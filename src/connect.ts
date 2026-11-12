import { z } from "zod";
import { discardBody, readBody } from "./body";
import { NotificationTypes } from "./config";
import { type ConnectConfig, connectConfig, setupConfig } from "./connect-config";
import { confirmationPage } from "./connect-page";
import type { X_NOTIFICATION_TYPES } from "./normalize";
import { issuePairingCode } from "./pairing";
import { dmPreviewGrantLifetime, pairingStore } from "./pairing-store";
import type { RelayDeps } from "./relay";
import { XUserID } from "./x-activity";
import { ensureSubscriptions, readJSON, scopesFor } from "./x-subscriptions";

type Store = NonNullable<ReturnType<typeof pairingStore>>;
type NotificationType = (typeof X_NOTIFICATION_TYPES)[number];

/**
 * アプリが ASWebAuthenticationSession で受け取る戻り先。
 * HTTPS の戻り先はアプリの関連ドメインでなければならず、利用者ごとに違う Worker のホストは関連付けられない (ADR-0008)。
 */
const appCallback = "tweetbot-worker://connect";
const loginLifetime = 10 * 60_000;
/**
 * 本人を確かめた後、購読を作ってコードを出すまでの期限。この間は、そのアカウントの購読を片付けで消さない。
 * 購読を作る処理には、これより 1 分短い締め切りを付け、期限の中でコードを出し終える。
 */
const processingLease = 5 * 60_000;
/** ログインを始めたブラウザに置く Cookie。`__Host-` で、この Worker のホストのパス全体だけに付く。 */
const browserCookie = "__Host-tweetbot-connect";
/** 確かめのページを開いたブラウザに置く Cookie。「続ける」のフォームの値と照らし合わせる。 */
const confirmCookie = "__Host-tweetbot-confirm";
export const Random = /^[A-Za-z0-9_-]{22,128}$/;
const TokenReply = z.object({
  access_token: z.string().min(1).max(4096),
  token_type: z.string().regex(/^bearer$/i),
  scope: z.string().max(1024),
});
const Me = z.object({ data: z.object({ id: XUserID }) });

const headers = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

function text(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { ...headers, "Content-Type": "text/plain; charset=utf-8" },
  });
}

function redirect(location: string, cookie?: string): Response {
  const response = new Response(null, { status: 302, headers: { ...headers, Location: location } });
  if (cookie !== undefined) response.headers.append("Set-Cookie", cookie);
  return response;
}

const clearCookie = `${browserCookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/** アプリへ戻す。アプリは state が自分の出したものかを確かめてから、コードで接続する。 */
function toApp(values: Record<string, string>): Response {
  return redirect(`${appCallback}?${new URLSearchParams(values)}`, clearCookie);
}

/**
 * `/connect` で断ったわけを、ログインを始めたアプリへ戻す。文字だけのページを返すと、利用者は認証のシートを閉じるしかなく、
 * アプリには「キャンセルした」と出る。`app_state` が 1 つだけで形が合うときだけ戻す (読めなければ、どのログインのものか分からない)。
 */
function refuse(params: URLSearchParams, status: number, message: string, error: string): Response {
  const [appState, ...rest] = params.getAll("app_state");
  return appState !== undefined && rest.length === 0 && Random.test(appState)
    ? toApp({ state: appState, error })
    : text(status, message);
}

export function base64URL(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function random(): string {
  return base64URL(crypto.getRandomValues(new Uint8Array(32)));
}

export async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

export async function hex(value: string): Promise<string> {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function cookieValue(request: Request, cookie: string): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === cookie && value !== undefined && Random.test(value)) return value;
  }
  return undefined;
}

/**
 * 回数を数える接続元。IPv6 は /64 にまとめる (1 人が /64 の中でアドレスを変えて、上限を抜けられないように)。
 * Cloudflare の文書は IP を鍵にすることを勧めていないが、この入口にはログインの前に使える利用者の識別子がない。
 */
export function sourceKey(address: string): string {
  if (!address.includes(":")) return address;
  // IPv4 を IPv6 の形で書いたもの (`::ffff:192.0.2.1`) は、IPv4 として数える (/64 にまとめると、すべて同じ鍵になる)。
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(address)?.[1];
  if (mapped !== undefined) return mapped;
  const [head = "", tail = ""] = address.toLowerCase().split("::", 2);
  const front = head === "" ? [] : head.split(":");
  const back = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
  const groups = address.includes("::")
    ? [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back]
    : front;
  return `${groups
    .slice(0, 4)
    .map((group) => group.replace(/^0+(?=.)/, ""))
    .join(":")}::/64`;
}

/** RFC 6749 §2.3.1 のとおり、Basic 認証の ID と Secret を form-urlencode してからつなぐ。 */
function basic(clientID: string, clientSecret: string): string {
  const encode = (value: string) => encodeURIComponent(value).replaceAll("%20", "+");
  return `Basic ${btoa(`${encode(clientID)}:${encode(clientSecret)}`)}`;
}

/** `/connect` と `GET /oauth/callback`。X でログインした本人に、そのアカウントの接続コードを渡す (ADR-0008 の段 3)。 */
export async function handleConnect(
  request: Request,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const store = pairingStore(env);
  const setup = setupConfig(env);
  if (!setup || !store) return text(404, "Not Found");
  const url = new URL(request.url);
  const method = url.pathname === "/connect" ? ["GET", "POST"] : ["GET"];
  if (!method.includes(request.method)) return text(405, "Method Not Allowed");
  // 認証のない入口なので、接続元ごとに回数を絞る。絞らないと、持ち主の X アプリへのトークンの要求を外から繰り返させられる。
  // 上限を超えたら、X へは何も求めず、ログインも始めない (書き込まない)。始めたアプリが分かれば、そのアプリへ戻す。
  // X から戻ったときは、始めたアプリを知るために、上限を超えていてもログインを読む (読み出しは絞らない)。
  const source = sourceKey(request.headers.get("CF-Connecting-IP") ?? "unknown");
  const limited = !(await setup.limiter.limit({ key: `connect:${source}` })).success;
  // `/setup` で用意した Webhook の ID は Durable Object から読むので、回数を数えた後に読む。
  const config = await connectConfig(env, store);
  if (!config) return text(404, "Not Found");
  if (url.pathname === "/connect")
    return request.method === "GET"
      ? confirmStart(request, url, config, limited)
      : start(request, url, config, store, limited);
  return finish(request, url, config, store, deps, limited);
}

type StartParams = {
  recipient: string;
  appState: string;
  managementHash: string;
  eventTypes: NotificationType[];
  dmPreview: boolean;
};

const StartQuery = z.strictObject({
  x_user_id: XUserID,
  types: z.string().max(100),
  app_state: z.string().regex(Random),
  management_hash: z.string().regex(/^[a-f0-9]{64}$/),
  /** 接続の後、続けて DM 通知の本文の設定にこのログインの許可を使う。DM を選んだときだけ受ける。 */
  dm_preview: z.literal("1").optional(),
});

/** アプリが `/connect` に付けた引数を読む。読めなければ、断ったわけを返す (始めたアプリが分かれば、そのアプリへ)。 */
function readStart(
  params: URLSearchParams,
  config: ConnectConfig,
  limited: boolean,
): { ok: true; value: StartParams } | { ok: false; response: Response } {
  if (limited)
    return { ok: false, response: refuse(params, 429, "Too Many Requests", "rate_limited") };
  const parsed = StartQuery.safeParse(Object.fromEntries(params));
  // 引数が合わないのは、アプリと Worker の版の違い (Worker の知らない種類など) のことが多い。
  const types = parsed.success
    ? NotificationTypes.min(1).safeParse(parsed.data.types.split(","))
    : undefined;
  if (
    !parsed.success ||
    !types?.success ||
    (parsed.data.dm_preview !== undefined && !types.data.includes("dm"))
  )
    return { ok: false, response: refuse(params, 400, "Bad Request", "invalid_request") };
  const { x_user_id, app_state, management_hash } = parsed.data;
  // 本当の守りは、ログインの後に本人の ID を確かめること (connect)。ここで断るのは、許可していない X アカウントに
  // 持ち主の X アプリの同意画面を出さないため。どの ID が許可されているかは、応答の違いから外に分かる。
  if (!config.allowed.has(x_user_id))
    return { ok: false, response: toApp({ state: app_state, error: "not_allowed" }) };
  return {
    ok: true,
    value: {
      recipient: x_user_id,
      appState: app_state,
      managementHash: management_hash,
      eventTypes: [...new Set(types.data)],
      dmPreview: parsed.data.dm_preview !== undefined,
    },
  };
}

/**
 * `GET /connect`。X へ送る前に、確かめのページを出す。
 * `/connect` の URL は誰でも作れるので、他人の管理キーのハッシュを入れた URL を開かされても、本人が気づいて止められるようにする
 * (#51)。ログインはまだ始めない (書き込まない)。
 */
function confirmStart(
  request: Request,
  url: URL,
  config: ConnectConfig,
  limited: boolean,
): Response {
  const read = readStart(url.searchParams, config, limited);
  if (!read.ok) return read.response;
  const nonce = random();
  const page = confirmationPage(
    url.host,
    read.value.eventTypes,
    {
      x_user_id: read.value.recipient,
      types: read.value.eventTypes.join(","),
      app_state: read.value.appState,
      management_hash: read.value.managementHash,
      ...(read.value.dmPreview ? { dm_preview: "1" } : {}),
      confirm: nonce,
    },
    /^ja\b/i.test(request.headers.get("Accept-Language") ?? ""),
    read.value.dmPreview,
  );
  const response = new Response(page, {
    status: 200,
    headers: {
      ...headers,
      // no-referrer にすると、フォームの POST の Origin が "null" になり、同じオリジンから送ったと分からない (Fetch の決まり)。
      // same-origin なら、X へ移るときには Referer を送らない (ページの URL の引数を X に渡さない)。
      "Referrer-Policy": "same-origin",
      "Content-Type": "text/html; charset=utf-8",
      // 外のページの枠の中に出して、押させない。form-action は付けない: 送った後の 303 (x.com へ移る) まで止めるブラウザがある。
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      "X-Frame-Options": "DENY",
    },
  });
  // 続けるときのフォームの値と照らし合わせる。Strict なので、外のサイトから送らせたフォームには付かない。
  response.headers.append(
    "Set-Cookie",
    `${confirmCookie}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${loginLifetime / 1000}`,
  );
  return response;
}

/** `POST /connect`。確かめのページで「続ける」を押したら、ログインを始めて X へ送る。 */
async function start(
  request: Request,
  url: URL,
  config: ConnectConfig,
  store: Store,
  limited: boolean,
): Promise<Response> {
  const forbidden = () => text(403, "Start again from Tweetbot.");
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("Content-Type") ?? ""))
    return forbidden();
  // ほかのオリジンから送らせたと分かるものは、ここで断る。Origin がない、または "null" (referrer policy で隠された) ときは、
  // 下の確かめの値と Strict の Cookie に任せる (どちらも外のサイトからは用意できない)。
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== "null" && origin !== url.origin) return forbidden();
  const body = await readBody(request, 2048);
  if (body === undefined) return text(413, "Payload Too Large");
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const confirm = form.getAll("confirm");
  form.delete("confirm");
  // 確かめのページを開いたブラウザでなければ断る。始めたアプリへも戻さない (外から送らせたものかもしれない)。
  const nonce = cookieValue(request, confirmCookie);
  if (nonce === undefined || confirm.length !== 1 || confirm[0] !== nonce) return forbidden();
  const read = readStart(form, config, limited);
  if (!read.ok) return read.response;
  const { recipient, appState, managementHash, eventTypes, dmPreview } = read.value;
  const state = random();
  const verifier = random();
  const browser = random();
  const redirectURI = `${url.origin}/oauth/callback`;
  await store.beginLogin({
    state,
    verifier,
    browserHash: await hex(browser),
    managementHash,
    appState,
    recipient,
    eventTypes,
    redirectURI,
    expires: Date.now() + loginLifetime,
    ...(dmPreview ? { dmPreview: true } : {}),
  });
  const authorize = new URL("https://x.com/i/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientID,
    redirect_uri: redirectURI,
    scope: scopesFor(eventTypes).join(" "),
    state,
    code_challenge: base64URL(await sha256(verifier)),
    code_challenge_method: "S256",
  }).toString();
  // フォームの POST の後なので、303 で GET に変えて X へ送る。確かめの Cookie は使い切り。
  const response = new Response(null, {
    status: 303,
    headers: { ...headers, Location: authorize.href },
  });
  response.headers.append(
    "Set-Cookie",
    `${browserCookie}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${loginLifetime / 1000}`,
  );
  response.headers.append(
    "Set-Cookie",
    `${confirmCookie}=; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=0`,
  );
  return response;
}

async function finish(
  request: Request,
  url: URL,
  config: ConnectConfig,
  store: Store,
  deps: RelayDeps,
  limited: boolean,
): Promise<Response> {
  // ログインを始めたブラウザだと分かるまでは、アプリへ戻さない。上限を超えていたら、文字のページも 429 にする。
  const reject = (message: string) =>
    limited ? text(429, "Too Many Requests") : text(400, message);
  const state = url.searchParams.get("state") ?? "";
  if (!Random.test(state)) return reject("Bad Request");
  // 上限を超えていても、ログインは読む (始めたアプリへ戻すため)。X へは何も求めない。
  const { login, expired } = await store.takeLogin(state);
  if (!login) return reject("Start again from Tweetbot.");
  try {
    // ログインを始めたブラウザでなければ断る (RFC 6749 §10.12)。他人が始めたログインの URL を開かされて同意しても、
    // 購読もコードも作らない。この応答はアプリへ戻さない (始めたアプリではないため)。期限切れを戻すのも、この後にする。
    const browser = cookieValue(request, browserCookie);
    if (browser === undefined || (await hex(browser)) !== login.browserHash)
      return reject("Start again from Tweetbot.");
    if (expired) return toApp({ state: login.appState, error: "expired" });
    const fail = (error: string) => toApp({ state: login.appState, error });
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.has("error") || code.length === 0 || code.length > 512)
      return fail("denied");
    // X の認可コードは使い切りで、すぐに切れる。後で同じ戻り先を開き直せないので、ここで終えて初めからやり直してもらう。
    if (limited) return fail("rate_limited");
    try {
      return await connect(code, state, login, config, store, deps, fail);
    } catch {
      return fail("unavailable");
    }
  } finally {
    // 使い切りのログインを消し、処理中の印も外して、片付けで購読を消せるようにする (コードを出したら、有効なコードが購読を守る)。
    await store.finishLogin(state).catch(() => undefined);
  }
}

/**
 * 認可コードをトークンに換え、ログインした本人の X ユーザー ID を読む。求めた scope がそろわなければ undefined。
 * 認可コードは 30 秒で切れるので、戻ってきたらすぐに換える。トークンは保存しない。
 * 使った後にトークンを取り消さない: 取り消すと本人の認可で作った購読も消えるかを、確かめられていないため (トークンは 2 時間で切れる)。
 */
export async function identify(
  code: string,
  redirectURI: string,
  verifier: string,
  scopes: readonly string[],
  config: { clientID: string; clientSecret: string },
  deps: RelayDeps,
): Promise<{ accessToken: string; userID: string } | undefined> {
  const exchanged = await deps
    .fetch("https://api.x.com/2/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: basic(config.clientID, config.clientSecret),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectURI,
        code_verifier: verifier,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined);
  const token =
    exchanged?.status === 200 ? TokenReply.safeParse(await readJSON(exchanged)) : undefined;
  await discardBody(exchanged);
  const granted = new Set(token?.success ? token.data.scope.split(" ") : []);
  if (!token?.success || !scopes.every((scope) => granted.has(scope))) return undefined;
  const accessToken = token.data.access_token;

  const me = await deps
    .fetch("https://api.x.com/2/users/me", {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined);
  const user = me?.status === 200 ? Me.safeParse(await readJSON(me)) : undefined;
  await discardBody(me);
  if (!user?.success) return undefined;
  return { accessToken, userID: user.data.data.id };
}

async function connect(
  code: string,
  state: string,
  login: NonNullable<Awaited<ReturnType<Store["takeLogin"]>>["login"]>,
  config: ConnectConfig,
  store: Store,
  deps: RelayDeps,
  fail: (error: string) => Response,
): Promise<Response> {
  const identified = await identify(
    code,
    login.redirectURI,
    login.verifier,
    scopesFor(login.eventTypes),
    config,
    deps,
  );
  if (!identified) return fail("unavailable");
  const { accessToken, userID } = identified;
  // アプリで選んでいたアカウントと違う X アカウントでログインしたら、つながない (通知が別のアカウントに届く)。
  if (userID !== login.recipient || !config.allowed.has(userID)) return fail("wrong_account");
  // 処理中の印は、本人を確かめた後に付ける (前に付けると、誰でも戻り先を開くだけで片付けを止められる)。
  // 片付けがこのアカウントの購読を消している間や、同じアカウントのほかの接続が処理中の間は、少し待ってからやり直してもらう。
  if (!(await store.startProcessing(state, Date.now() + processingLease))) return fail("busy");

  if (
    !(await ensureSubscriptions({
      store,
      recipient: login.recipient,
      types: login.eventTypes,
      webhookID: config.webhookID,
      userToken: accessToken,
      bearer: config.bearer,
      workerID: await store.workerID(),
      attempt: (await hex(state)).slice(0, 16),
      deadline: Date.now() + processingLease - 60_000,
      extendLease: (until) => store.extendProcessing(state, until),
      deps,
    }))
  )
    return fail("subscription_failed");
  // コードは、ログインを始めたアプリの管理キーでしか使えない。選んだ種類は、つないだルートの初めの種類になる。
  const issued = await issuePairingCode(store, login.recipient, {
    managementHash: login.managementHash,
    eventTypes: login.eventTypes,
  });
  if (!issued) return fail("busy");
  // DM の本文の設定も選んでいたら、このログインの読み取りトークンを、続けて始める本文の設定のために少しだけ持つ。
  // 本文の設定に要る scope (tweet.read、users.read、dm.read) は、DM を選んだ接続の scope にそろっている。
  // 置けなくても接続は終わっている。アプリはブラウザでのログインに戻る。
  if (login.dmPreview)
    await store
      .holdDMPreviewGrant(login.managementHash, login.recipient, {
        accessToken,
        userID,
        expires: Date.now() + dmPreviewGrantLifetime,
      })
      .catch(() => undefined);
  return toApp({ state: login.appState, code: issued.code });
}
