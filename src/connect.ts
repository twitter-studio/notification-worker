import { z } from "zod";
import { discardBody } from "./body";
import { NotificationTypes } from "./config";
import { type ConnectConfig, connectConfig } from "./connect-config";
import { issuePairingCode } from "./pairing";
import { pairingStore } from "./pairing-store";
import type { RelayDeps } from "./relay";
import { XUserID } from "./x-activity";
import { ensureSubscriptions, readJSON, scopesFor } from "./x-subscriptions";

type Store = NonNullable<ReturnType<typeof pairingStore>>;

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
const Random = /^[A-Za-z0-9_-]{22,128}$/;
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

function base64URL(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function random(): string {
  return base64URL(crypto.getRandomValues(new Uint8Array(32)));
}

async function sha256(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function hex(value: string): Promise<string> {
  return Array.from(await sha256(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function cookieValue(request: Request): string | undefined {
  for (const part of (request.headers.get("Cookie") ?? "").split(";")) {
    const [name, value] = part.trim().split("=", 2);
    if (name === browserCookie && value !== undefined && Random.test(value)) return value;
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

/** `GET /connect` と `GET /oauth/callback`。X でログインした本人に、そのアカウントの接続コードを渡す (ADR-0008 の段 3)。 */
export async function handleConnect(
  request: Request,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const config = connectConfig(env);
  const store = pairingStore(env);
  if (!config || !store) return text(404, "Not Found");
  if (request.method !== "GET") return text(405, "Method Not Allowed");
  // 認証のない入口なので、接続元ごとに回数を絞る。絞らないと、持ち主の X アプリへのトークンの要求を外から繰り返させられる。
  const source = sourceKey(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await config.limiter.limit({ key: `connect:${source}` })).success)
    return text(429, "Too Many Requests");
  const url = new URL(request.url);
  return url.pathname === "/connect"
    ? start(url, config, store)
    : finish(request, url, config, store, deps);
}

async function start(url: URL, config: ConnectConfig, store: Store): Promise<Response> {
  const params = z
    .strictObject({
      x_user_id: XUserID,
      types: z.string().max(100),
      app_state: z.string().regex(Random),
      management_hash: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .safeParse(Object.fromEntries(url.searchParams));
  if (!params.success) return text(400, "Bad Request");
  const types = NotificationTypes.min(1).safeParse(params.data.types.split(","));
  if (!types.success) return text(400, "Bad Request");
  const { x_user_id, app_state, management_hash } = params.data;
  // 本当の守りは、ログインの後に本人の ID を確かめること (connect)。ここで断るのは、許可していない X アカウントに
  // 持ち主の X アプリの同意画面を出さないため。どの ID が許可されているかは、応答の違いから外に分かる。
  if (!config.allowed.has(x_user_id)) return toApp({ state: app_state, error: "not_allowed" });
  const state = random();
  const verifier = random();
  const browser = random();
  const eventTypes = [...new Set(types.data)];
  const redirectURI = `${url.origin}/oauth/callback`;
  await store.beginLogin({
    state,
    verifier,
    browserHash: await hex(browser),
    managementHash: management_hash,
    appState: app_state,
    recipient: x_user_id,
    eventTypes,
    redirectURI,
    expires: Date.now() + loginLifetime,
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
  return redirect(
    authorize.href,
    `${browserCookie}=${browser}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${loginLifetime / 1000}`,
  );
}

async function finish(
  request: Request,
  url: URL,
  config: ConnectConfig,
  store: Store,
  deps: RelayDeps,
): Promise<Response> {
  const state = url.searchParams.get("state") ?? "";
  if (!Random.test(state)) return text(400, "Bad Request");
  const { login, expired } = await store.takeLogin(state);
  if (!login) return text(400, "Start again from Tweetbot.");
  try {
    // ログインを始めたブラウザでなければ断る (RFC 6749 §10.12)。他人が始めたログインの URL を開かされて同意しても、
    // 購読もコードも作らない。この応答はアプリへ戻さない (始めたアプリではないため)。期限切れを戻すのも、この後にする。
    const browser = cookieValue(request);
    if (browser === undefined || (await hex(browser)) !== login.browserHash)
      return text(400, "Start again from Tweetbot.");
    if (expired) return toApp({ state: login.appState, error: "expired" });
    const fail = (error: string) => toApp({ state: login.appState, error });
    const code = url.searchParams.get("code") ?? "";
    if (url.searchParams.has("error") || code.length === 0 || code.length > 512)
      return fail("denied");
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

async function connect(
  code: string,
  state: string,
  login: NonNullable<Awaited<ReturnType<Store["takeLogin"]>>["login"]>,
  config: ConnectConfig,
  store: Store,
  deps: RelayDeps,
  fail: (error: string) => Response,
): Promise<Response> {
  // 認可コードは 30 秒で切れるので、ここで換える。トークンは保存しない。
  // 使った後にトークンを取り消さない: 取り消すと本人の認可で作った購読も消えるかを、確かめられていないため (トークンは 2 時間で切れる)。
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
        redirect_uri: login.redirectURI,
        code_verifier: login.verifier,
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined);
  const token =
    exchanged?.status === 200 ? TokenReply.safeParse(await readJSON(exchanged)) : undefined;
  await discardBody(exchanged);
  const granted = new Set(token?.success ? token.data.scope.split(" ") : []);
  if (!token?.success || !scopesFor(login.eventTypes).every((scope) => granted.has(scope)))
    return fail("unavailable");
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
  if (!user?.success) return fail("unavailable");
  // アプリで選んでいたアカウントと違う X アカウントでログインしたら、つながない (通知が別のアカウントに届く)。
  if (user.data.data.id !== login.recipient || !config.allowed.has(user.data.data.id))
    return fail("wrong_account");
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
      attempt: (await hex(state)).slice(0, 16),
      deadline: Date.now() + processingLease - 60_000,
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
  return toApp({ state: login.appState, code: issued.code });
}
