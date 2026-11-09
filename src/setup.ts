import { z } from "zod";
import { discardBody, readBody } from "./body";
import {
  base64URL,
  cookieValue,
  handleConnect,
  hex,
  identify,
  Random,
  random,
  sha256,
  sourceKey,
} from "./connect";
import { type SetupConfig, setupConfig, WebhookID } from "./connect-config";
import { pairingStore, type SetupLogin } from "./pairing-store";
import type { RelayDeps } from "./relay";
import { type SetupDetails, type SetupMessage, setupPage } from "./setup-page";
import { readJSON } from "./x-subscriptions";

type Store = NonNullable<ReturnType<typeof pairingStore>>;

const loginLifetime = 10 * 60_000;
/** ログインを始めたブラウザに置く Cookie。X から戻ったとき (外のサイトからの移動) にも付くよう Lax にする。 */
const browserCookie = "__Host-tweetbot-setup";
/** `/setup` を開いたブラウザに置く Cookie。ログインのボタンのフォームの値と照らし合わせる。 */
const confirmCookie = "__Host-tweetbot-setup-confirm";
/** 本人の ID を読むだけの scope (`GET /2/users/me`)。購読は作らないので、ほかは求めない。 */
const scopes = ["tweet.read", "users.read"];
const api = "https://api.x.com";

const Webhook = z.object({
  id: z.string().regex(WebhookID),
  url: z.string().max(2048),
  valid: z.boolean().optional(),
});
const Webhooks = z.object({ data: z.array(Webhook).max(100).optional() });
const Created = z.object({ data: Webhook.extend({ valid: z.boolean() }) });
const Validated = z.object({ data: z.object({ valid: z.boolean() }) });

const headers = {
  "Cache-Control": "no-store",
  // no-referrer にすると、フォームの POST の Origin が "null" になる。same-origin なら、X へ移るときには Referer を送らない。
  "Referrer-Policy": "same-origin",
  "Content-Type": "text/html; charset=utf-8",
  // 外のページの枠の中に出して、押させない。form-action は付けない: 送った後の 303 (x.com へ移る) まで止めるブラウザがある。
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  "X-Frame-Options": "DENY",
} as const;

function japanese(request: Request): boolean {
  return /^ja\b/i.test(request.headers.get("Accept-Language") ?? "");
}

function page(
  request: Request,
  status: number,
  message: SetupMessage,
  details: Omit<SetupDetails, "host"> = {},
  cookies: string[] = [],
): Response {
  const host = new URL(request.url).host;
  const response = new Response(setupPage(message, { ...details, host }, japanese(request)), {
    status,
    headers,
  });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}

function plain(status: number, message: string): Response {
  return new Response(message, {
    status,
    headers: { "Cache-Control": "no-store", "Content-Type": "text/plain; charset=utf-8" },
  });
}

const clearBrowser = `${browserCookie}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * `/setup`。持ち主が X でログインすると、この Worker の Webhook を持ち主の X アプリに登録し、X に確かめさせて、状態を出す
 * (ADR-0008 の段 4)。ログインできるのは、許可した X アカウント (`ALLOWED_X_USER_IDS`) だけ。
 */
export async function handleSetup(request: Request, env: Env): Promise<Response> {
  const config = setupConfig(env);
  const store = pairingStore(env);
  if (!config || !store) return plain(404, "Not Found");
  if (request.method === "GET") {
    // ログインはまだ始めない (書き込まない)。ボタンのフォームの値と照らし合わせる値だけを置く。
    const nonce = random();
    return page(request, 200, "start", { confirm: nonce }, [
      `${confirmCookie}=${nonce}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${loginLifetime / 1000}`,
    ]);
  }
  if (request.method !== "POST") return plain(405, "Method Not Allowed");
  return start(request, config, store);
}

/** `POST /setup`。ログインを始めて X へ送る。外のサイトから送らせたものは、確かめの値と Strict の Cookie で断る。 */
async function start(request: Request, config: SetupConfig, store: Store): Promise<Response> {
  const url = new URL(request.url);
  const forbidden = () => page(request, 403, "restart");
  if (!/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("Content-Type") ?? ""))
    return forbidden();
  const origin = request.headers.get("Origin");
  if (origin !== null && origin !== "null" && origin !== url.origin) return forbidden();
  const body = await readBody(request, 1024);
  if (body === undefined) return plain(413, "Payload Too Large");
  const confirm = new URLSearchParams(new TextDecoder().decode(body)).getAll("confirm");
  const nonce = cookieValue(request, confirmCookie);
  if (nonce === undefined || confirm.length !== 1 || confirm[0] !== nonce) return forbidden();
  // 認証のない入口なので、接続元ごとに回数を絞る。上限を超えたら、ログインを始めない (書き込まない)。
  const source = sourceKey(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await config.limiter.limit({ key: `setup:${source}` })).success)
    return page(request, 429, "rate_limited");
  const state = random();
  const verifier = random();
  const browser = random();
  const redirectURI = `${url.origin}/oauth/callback`;
  await store.beginSetup({
    state,
    verifier,
    browserHash: await hex(browser),
    redirectURI,
    expires: Date.now() + loginLifetime,
  });
  const authorize = new URL("https://x.com/i/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientID,
    redirect_uri: redirectURI,
    scope: scopes.join(" "),
    state,
    code_challenge: base64URL(await sha256(verifier)),
    code_challenge_method: "S256",
  }).toString();
  const response = new Response(null, {
    status: 303,
    headers: {
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      Location: authorize.href,
    },
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

/**
 * `GET /oauth/callback`。X の戻り先は 1 つに揃える (X アプリに登録する Callback URL を増やさない)。
 * state が `/setup` のログインのものなら設定を終え、ほかは接続のログインとして扱う。`/setup` のログインは、Cookie が
 * なくても引いて使い切る (別のブラウザに戻った認可コードで、後から終えられないようにする)。
 */
export async function handleCallback(
  request: Request,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const config = setupConfig(env);
  const store = pairingStore(env);
  const state = new URL(request.url).searchParams.get("state") ?? "";
  if (config && store && request.method === "GET" && Random.test(state)) {
    const { login, expired } = await store.takeSetup(state);
    if (login) {
      const browser = cookieValue(request, browserCookie);
      if (browser === undefined || (await hex(browser)) !== login.browserHash)
        // ほかの人が始めたログインの戻り先を開かされた。開いた人の進めているログインの Cookie は消さない。
        return page(request, 400, "restart");
      const configured = env.X_WEBHOOK_ID ?? "";
      return finish(request, config, store, login, expired === true, configured, deps).catch(() =>
        page(request, 503, "unavailable", {}, [clearBrowser]),
      );
    }
  }
  return handleConnect(request, env, deps);
}

async function finish(
  request: Request,
  config: SetupConfig,
  store: Store,
  login: SetupLogin,
  expired: boolean,
  /** `X_WEBHOOK_ID` の値。置いていれば、接続ではこちらを使う (`connectConfig`)。 */
  configured: string,
  deps: RelayDeps,
): Promise<Response> {
  const url = new URL(request.url);
  const done = (status: number, message: SetupMessage, details: Omit<SetupDetails, "host"> = {}) =>
    page(request, status, message, details, [clearBrowser]);
  if (expired) return done(400, "expired");
  const code = url.searchParams.get("code") ?? "";
  if (url.searchParams.has("error") || code.length === 0 || code.length > 512)
    return done(400, "denied");
  const source = sourceKey(request.headers.get("CF-Connecting-IP") ?? "unknown");
  if (!(await config.limiter.limit({ key: `setup:${source}` })).success)
    return done(429, "rate_limited");
  const identified = await identify(code, login.redirectURI, login.verifier, scopes, config, deps);
  if (!identified) return done(503, "unavailable");
  if (!config.allowed.has(identified.userID)) return done(403, "not_allowed");

  const webhookURL = `${url.origin}/webhooks/x`;
  const prepared = await prepareWebhook(webhookURL, config.bearer, deps);
  if (prepared.kind === "unavailable") return done(503, "unavailable");
  if (prepared.kind === "failed")
    // ほかの Webhook の URL は、消すものを選んでもらうとき (上限、同じ URL のものがあると言われた) にだけ出す。
    return done(
      502,
      prepared.reason,
      prepared.reason === "limit" || prepared.reason === "duplicate"
        ? { others: prepared.others }
        : {},
    );
  // X が確かめた Webhook の ID だけを使う。確かめられない Webhook に購読を付けても、イベントは届かず課金だけが進む。
  // 前に保存した同じ ID も、確かめられなければ外す (接続を止め、確かめ直すまで購読を作らせない)。
  if (prepared.valid) await store.saveWebhookID(prepared.id);
  else await store.forgetWebhookID(prepared.id);
  const relation =
    configured.length === 0
      ? "none"
      : !WebhookID.test(configured)
        ? "invalid"
        : configured === prepared.id
          ? "same"
          : "different";
  const message = !prepared.valid
    ? "not_valid"
    : relation === "invalid"
      ? "ready_blocked"
      : "ready";
  return done(prepared.valid ? 200 : 502, message, {
    webhook: {
      url: webhookURL,
      id: prepared.id,
      created: prepared.created,
      configured: relation,
    },
  });
}

type Prepared =
  | { kind: "ready"; id: string; valid: boolean; created: boolean }
  | {
      kind: "failed";
      reason: "crc_failed" | "limit" | "url_rejected" | "duplicate" | "create_failed";
      others: { id: string; url: string; valid: boolean | undefined }[];
    }
  | { kind: "unavailable" };

async function call(
  deps: RelayDeps,
  method: "GET" | "POST" | "PUT",
  path: string,
  bearer: string,
  body?: unknown,
): Promise<Response | undefined> {
  return deps
    .fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${bearer}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    })
    .catch(() => undefined);
}

/** 答えの本文を、X のエラーの名前を探すためだけに文字にする。本文はページにもログにも出さない。 */
async function errorText(response: Response): Promise<string> {
  const text = JSON.stringify((await readJSON(response)) ?? null);
  await discardBody(response);
  return text;
}

/** X が URL を整えて保存しても見つけられるよう、URL の形を揃えてから比べる。 */
function sameURL(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href;
  } catch {
    return false;
  }
}

/**
 * この Worker の URL の Webhook を、App-only の Bearer で探し、なければ登録する。あれば、X に確かめ (CRC) を呼び直させる。
 * X の文書は、失敗の答えの状態コードと本文の形を決めていない。名前 (`WebhookLimitExceeded` など) が本文にあるかだけを見る。
 */
async function prepareWebhook(url: string, bearer: string, deps: RelayDeps): Promise<Prepared> {
  const listed = await call(deps, "GET", "/2/webhooks?webhook_config.fields=id,url,valid", bearer);
  const parsed = listed?.status === 200 ? Webhooks.safeParse(await readJSON(listed)) : undefined;
  await discardBody(listed);
  if (!parsed?.success) return { kind: "unavailable" };
  const rows = parsed.data.data ?? [];
  const found = rows.find((row) => sameURL(row.url, url));
  if (found !== undefined) {
    const checked = await call(deps, "PUT", `/2/webhooks/${found.id}`, bearer);
    if (checked === undefined) return { kind: "unavailable" };
    if (checked.status === 200) {
      const result = Validated.safeParse(await readJSON(checked));
      await discardBody(checked);
      if (!result.success) return { kind: "unavailable" };
      return { kind: "ready", id: found.id, valid: result.data.data.valid, created: false };
    }
    // 確かめに失敗したと分かるときだけ、確かめられないと出す。ほかの失敗 (429、5xx、一覧の後に消された) では、
    // 確かめの結果が分からないので、やり直してもらう (次は一覧から探し直す)。
    if ((await errorText(checked)).includes("CrcValidationFailed"))
      return { kind: "ready", id: found.id, valid: false, created: false };
    return { kind: "unavailable" };
  }
  const created = await call(deps, "POST", "/2/webhooks", bearer, { url });
  if (created === undefined) return { kind: "unavailable" };
  if (created.status === 200 || created.status === 201) {
    const result = Created.safeParse(await readJSON(created));
    await discardBody(created);
    // 送った URL のものでなければ、この Worker の Webhook として保存しない。
    if (!result.success || !sameURL(result.data.data.url, url)) return { kind: "unavailable" };
    return { kind: "ready", id: result.data.data.id, valid: result.data.data.valid, created: true };
  }
  const text = await errorText(created);
  const others = rows.map(({ id, url: other, valid }) => ({ id, url: other, valid }));
  if (text.includes("WebhookLimitExceeded")) return { kind: "failed", reason: "limit", others };
  if (text.includes("CrcValidationFailed")) return { kind: "failed", reason: "crc_failed", others };
  if (text.includes("UrlValidationFailed"))
    return { kind: "failed", reason: "url_rejected", others };
  if (text.includes("DuplicateUrlFailed")) return { kind: "failed", reason: "duplicate", others };
  return { kind: "failed", reason: "create_failed", others };
}
