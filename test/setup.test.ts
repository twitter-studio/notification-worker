import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test } from "vitest";
import { handle } from "../src/app";
import { connectConfig } from "../src/connect-config";
import { pairingStore } from "../src/pairing-store";
import { testEnv } from "./helpers";

const admin = `tpa_${"A".repeat(43)}`;
const owner = "111";
const enc = new TextEncoder();
const origin = "https://worker.test";
const webhookURL = `${origin}/webhooks/x`;

type Call = { method: string; path: string; authorization: string | null; body: string };
type Hook = { id: string; url: string; valid: boolean };

/** X の API の偽物。本人のトークンと App-only の Bearer の使い分けも確かめられるよう、呼ばれた要求を残す。 */
function fakeX(
  options: {
    me?: string;
    hooks?: Hook[];
    /** 登録の失敗の答え (状態コードと本文)。 */
    createError?: { status: number; body: unknown };
    /** 登録の 200 の答えの本文を、この値にする (読めない答え)。 */
    createReply?: unknown;
    /** 確かめ (PUT) の後の valid。 */
    revalidate?: boolean;
    /** 確かめ (PUT) の失敗の答え (状態コードと本文)。 */
    revalidateError?: { status: number; body: unknown };
    listStatus?: number;
  } = {},
) {
  const calls: Call[] = [];
  const hooks = [...(options.hooks ?? [])];
  let challenge = "";
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({
      method: request.method,
      path: url.pathname,
      authorization: request.headers.get("Authorization"),
      body,
    });
    if (url.pathname === "/2/oauth2/token") {
      const verifier = new URLSearchParams(body).get("code_verifier") ?? "";
      const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(verifier)));
      const expected = btoa(String.fromCharCode(...digest))
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, "");
      if (expected !== challenge) return Response.json({}, { status: 400 });
      return Response.json({
        access_token: "user-token",
        token_type: "bearer",
        scope: "tweet.read users.read",
      });
    }
    if (url.pathname === "/2/users/me") return Response.json({ data: { id: options.me ?? owner } });
    if (url.pathname === "/2/webhooks" && request.method === "GET") {
      if (options.listStatus !== undefined)
        return Response.json({}, { status: options.listStatus });
      return Response.json({ data: hooks, meta: { result_count: hooks.length } });
    }
    if (url.pathname === "/2/webhooks" && request.method === "POST") {
      if (options.createError)
        return Response.json(options.createError.body, { status: options.createError.status });
      if (options.createReply !== undefined) return Response.json(options.createReply);
      const created = {
        id: "5550001",
        url: (JSON.parse(body) as { url: string }).url,
        valid: true,
        created_at: new Date().toISOString(),
      };
      hooks.push(created);
      return Response.json({ data: created });
    }
    if (url.pathname.startsWith("/2/webhooks/") && request.method === "PUT") {
      if (options.revalidateError)
        return Response.json(options.revalidateError.body, {
          status: options.revalidateError.status,
        });
      return Response.json({ data: { valid: options.revalidate ?? true } });
    }
    return Response.json({}, { status: 404 });
  };
  return {
    calls,
    setChallenge: (value: string) => {
      challenge = value;
    },
    deps: {
      fetch: fetch as typeof globalThis.fetch,
      enqueueX: async () => {},
      sleep: async () => {},
    },
  };
}

function setupEnv(overrides: Partial<Env> = {}): Env {
  return testEnv({
    PAIRING_ADMIN_TOKEN: admin,
    ENABLE_X_ACTIVITY: "true",
    X_OAUTH2_CLIENT_ID: "client-id",
    X_OAUTH2_CLIENT_SECRET: "c".repeat(40),
    ALLOWED_X_USER_IDS: `9, ${owner}`,
    X_APP_BEARER_TOKEN: "app-bearer",
    CONNECT_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  });
}

async function storedWebhook(env: Env): Promise<string | undefined> {
  const stub = env.PAIRING_ROUTES?.getByName("routes");
  if (!stub) throw new Error("Missing store");
  return runInDurableObject(stub, (_instance, state) => state.storage.kv.get<string>("webhook_id"));
}

afterEach(async () => {
  const stub = testEnv().PAIRING_ROUTES?.getByName("routes");
  if (stub) await runInDurableObject(stub, (_instance, state) => state.storage.deleteAll());
});

function cookieOf(response: Response, name: string): string {
  return (
    response.headers
      .getSetCookie()
      .map((cookie) => cookie.split(";")[0] ?? "")
      .find((cookie) => cookie.startsWith(`${name}=`)) ?? ""
  );
}

/** `/setup` を開いてログインのボタンを押し、X の認可の URL と、ブラウザの Cookie を受け取る。 */
async function startSetup(env: Env, x: ReturnType<typeof fakeX>) {
  const opened = await handle(new Request(`${origin}/setup`), env, x.deps);
  const confirm = /name="confirm" value="([^"]+)"/.exec(await opened.text())?.[1] ?? "";
  const started = await handle(
    new Request(`${origin}/setup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: origin,
        Cookie: cookieOf(opened, "__Host-tweetbot-setup-confirm"),
      },
      body: new URLSearchParams({ confirm }),
    }),
    env,
    x.deps,
  );
  const authorize = new URL(started.headers.get("Location") ?? "https://invalid.test");
  x.setChallenge(authorize.searchParams.get("code_challenge") ?? "");
  return { started, authorize, cookie: cookieOf(started, "__Host-tweetbot-setup") };
}

function callback(
  env: Env,
  x: ReturnType<typeof fakeX>,
  state: string,
  cookie: string,
  query: Record<string, string> = { code: "auth-code" },
) {
  return handle(
    new Request(`${origin}/oauth/callback?${new URLSearchParams({ ...query, state })}`, {
      headers: { ...(cookie ? { Cookie: cookie } : {}), "Accept-Language": "en" },
    }),
    env,
    x.deps,
  );
}

async function completeSetup(env: Env, x: ReturnType<typeof fakeX>) {
  const { authorize, cookie } = await startSetup(env, x);
  return callback(env, x, authorize.searchParams.get("state") ?? "", cookie);
}

describe("/setup", () => {
  test("設定が欠けていれば、入口があることも見せない", async () => {
    const x = fakeX();
    for (const env of [
      setupEnv({ X_APP_BEARER_TOKEN: "" }),
      setupEnv({ ENABLE_X_ACTIVITY: "false" }),
      setupEnv({ ALLOWED_X_USER_IDS: "" }),
      setupEnv({ PAIRING_ADMIN_TOKEN: "" }),
      (() => {
        const env = setupEnv();
        delete env.CONNECT_LIMITER;
        return env;
      })(),
      setupEnv({ X_OAUTH2_CLIENT_SECRET: "short" }),
    ]) {
      const response = await handle(new Request(`${origin}/setup`), env, x.deps);
      expect(response.status).toBe(404);
    }
  });

  test("開いただけでは X へ送らず、ログインのボタンと、枠の中に出さない指定を返す", async () => {
    const x = fakeX();
    const response = await handle(
      new Request(`${origin}/setup`, { headers: { "Accept-Language": "ja" } }),
      setupEnv(),
      x.deps,
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors 'none'");
    expect(response.headers.get("X-Frame-Options")).toBe("DENY");
    expect(response.headers.getSetCookie().join("\n")).toMatch(
      /__Host-tweetbot-setup-confirm=[A-Za-z0-9_-]+; Path=\/; Secure; HttpOnly; SameSite=Strict/,
    );
    const body = await response.text();
    expect(body).toContain('<form method="post" action="/setup">');
    expect(body).toContain("Twitterでログイン");
    expect(x.calls).toEqual([]);
  });

  test("ボタンを押すと、本人の ID を読む scope だけで X のログインへ送る", async () => {
    const x = fakeX();
    const { started, authorize, cookie } = await startSetup(setupEnv(), x);
    expect(started.status).toBe(303);
    expect(authorize.origin + authorize.pathname).toBe("https://x.com/i/oauth2/authorize");
    expect(authorize.searchParams.get("scope")).toBe("tweet.read users.read");
    expect(authorize.searchParams.get("redirect_uri")).toBe(`${origin}/oauth/callback`);
    expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
    expect(cookie).toMatch(/^__Host-tweetbot-setup=[A-Za-z0-9_-]+$/);
    expect(started.headers.getSetCookie().join("\n")).toContain("SameSite=Lax");
  });

  test("ほかのサイトから送らせたフォームと、確かめの値の合わないフォームは断る", async () => {
    const x = fakeX();
    const env = setupEnv();
    const opened = await handle(new Request(`${origin}/setup`), env, x.deps);
    const confirm = /name="confirm" value="([^"]+)"/.exec(await opened.text())?.[1] ?? "";
    const cookie = cookieOf(opened, "__Host-tweetbot-setup-confirm");
    for (const [headers, value] of [
      [{ Origin: "https://evil.test", Cookie: cookie }, confirm],
      [{ Origin: origin }, confirm],
      [{ Origin: origin, Cookie: cookie }, "X".repeat(43)],
    ] as const) {
      const response = await handle(
        new Request(`${origin}/setup`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
          body: new URLSearchParams({ confirm: value }),
        }),
        env,
        x.deps,
      );
      expect(response.status).toBe(403);
      expect(response.headers.get("Location")).toBeNull();
    }
  });

  test("回数の上限を超えたら、ログインを始めない", async () => {
    const x = fakeX();
    const keys: string[] = [];
    const env = setupEnv({
      CONNECT_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const { started } = await startSetup(env, x);
    expect(started.status).toBe(429);
    expect(started.headers.get("Location")).toBeNull();
    expect(keys).toEqual(["setup:unknown"]);
  });

  test("Webhook がなければ登録し、ID を保存して、接続を使えるようにする", async () => {
    const x = fakeX();
    const env = setupEnv();
    const before = await handle(new Request(`${origin}/v1/pairing`), env, x.deps);
    expect(await before.json()).toEqual({ version: 3, x_login: false });

    const response = await completeSetup(env, x);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain("Webhook Ready");
    expect(body).toContain(webhookURL);
    expect(body).toContain("Registered now");
    expect(await storedWebhook(env)).toBe("5550001");
    // 本人のトークンは本人の確かめにだけ使い、Webhook は App-only の Bearer で扱う。
    expect(x.calls.map(({ method, path, authorization }) => [method, path, authorization])).toEqual(
      [
        ["POST", "/2/oauth2/token", expect.stringMatching(/^Basic /)],
        ["GET", "/2/users/me", "Bearer user-token"],
        ["GET", "/2/webhooks", "Bearer app-bearer"],
        ["POST", "/2/webhooks", "Bearer app-bearer"],
      ],
    );
    expect(JSON.parse(x.calls[3]?.body ?? "{}")).toEqual({ url: webhookURL });
    expect(response.headers.getSetCookie().join("\n")).toContain("__Host-tweetbot-setup=; ");

    const after = await handle(new Request(`${origin}/v1/pairing`), env, x.deps);
    expect(await after.json()).toEqual({ version: 3, x_login: true });
  });

  test("登録済みの Webhook は作り直さず、X に確かめ直させる", async () => {
    const x = fakeX({ hooks: [{ id: "777", url: webhookURL, valid: false }] });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Already registered");
    expect(await storedWebhook(env)).toBe("777");
    expect(
      x.calls.filter(({ path }) => path.startsWith("/2/webhooks")).map((c) => c.method),
    ).toEqual(["GET", "PUT"]);
    expect(x.calls.at(-1)?.path).toBe("/2/webhooks/777");
  });

  test("X が確かめられなければ、そう出し、ID は保存しない (購読を作れるようにしない)", async () => {
    for (const options of [
      { revalidate: false },
      { revalidateError: { status: 400, body: { errors: [{ message: "CrcValidationFailed" }] } } },
    ]) {
      const x = fakeX({ hooks: [{ id: "777", url: webhookURL, valid: true }], ...options });
      const env = setupEnv();
      const response = await completeSetup(env, x);
      expect(response.status).toBe(502);
      expect(await response.text()).toContain("Webhook Not Verified");
      expect(await storedWebhook(env)).toBeUndefined();
      const version = await handle(new Request(`${origin}/v1/pairing`), env, x.deps);
      expect(await version.json()).toEqual({ version: 3, x_login: false });
    }
  });

  test("確かめの結果が分からない失敗では、確かめられないとは出さず、やり直してもらう", async () => {
    for (const revalidateError of [
      { status: 503, body: {} },
      { status: 429, body: {} },
      { status: 400, body: { errors: [{ message: "WebhookIdInvalid" }] } },
    ]) {
      const x = fakeX({ hooks: [{ id: "777", url: webhookURL, valid: true }], revalidateError });
      const env = setupEnv();
      const response = await completeSetup(env, x);
      expect(response.status, String(revalidateError.status)).toBe(503);
      expect(await response.text()).toContain("Could Not Reach Twitter");
      expect(await storedWebhook(env)).toBeUndefined();
    }
  });

  test("X が URL を整えて保存していても、同じ Webhook として見つける", async () => {
    const x = fakeX({ hooks: [{ id: "777", url: "HTTPS://WORKER.TEST/webhooks/x", valid: true }] });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(200);
    expect(await storedWebhook(env)).toBe("777");
    expect(x.calls.some(({ method, path }) => method === "POST" && path === "/2/webhooks")).toBe(
      false,
    );
  });

  test("登録の答えが読めなければ、ID を保存しない", async () => {
    const x = fakeX({ createReply: {} });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(503);
    expect(await storedWebhook(env)).toBeUndefined();
  });

  test("登録の失敗は、理由ごとの文言で出し、ほかの Webhook は上限と同じ URL のときだけ出す", async () => {
    const other = { id: "888", url: "https://other.test/hook", valid: true };
    for (const [message, text, listed] of [
      ["CrcValidationFailed", "Check the client secret", false],
      ["UrlValidationFailed", "did not accept this Worker&#39;s URL", false],
      ["DuplicateUrlFailed", "already has a webhook for this URL", true],
      ["SomethingElse", "Twitter did not accept the webhook", false],
    ] as const) {
      const x = fakeX({
        hooks: [other],
        createError: { status: 400, body: { errors: [{ message }] } },
      });
      const env = setupEnv();
      const response = await completeSetup(env, x);
      expect(response.status, message).toBe(502);
      const body = await response.text();
      expect(body, message).toContain(text);
      expect(body.includes(other.url), message).toBe(listed);
      expect(await storedWebhook(env)).toBeUndefined();
    }
  });

  test("Webhook の数が上限なら、開発者アプリのほかの Webhook を出し、ID は保存しない", async () => {
    const x = fakeX({
      hooks: [{ id: "888", url: "https://other.test/hook?<b>", valid: true }],
      createError: {
        status: 400,
        body: { errors: [{ message: "WebhookLimitExceeded", title: "WebhookLimitExceeded" }] },
      },
    });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(502);
    const body = await response.text();
    expect(body).toContain("as many webhooks as it can");
    expect(body).toContain("https://other.test/hook?&lt;b&gt; (verified)");
    expect(body).not.toContain("<b>");
    expect(await storedWebhook(env)).toBeUndefined();
  });

  test("許可していないアカウントでログインしたら、Webhook に触らない", async () => {
    const x = fakeX({ me: "222" });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("not allowed");
    expect(x.calls.some(({ path }) => path.startsWith("/2/webhooks"))).toBe(false);
    expect(await storedWebhook(env)).toBeUndefined();
  });

  test("ログインを始めたブラウザでなければ、コードを換えずに断り、ログインは使い切る", async () => {
    const x = fakeX();
    const env = setupEnv();
    const { authorize, cookie } = await startSetup(env, x);
    const state = authorize.searchParams.get("state") ?? "";
    const other = await callback(env, x, state, `__Host-tweetbot-setup=${"Z".repeat(43)}`);
    expect(other.status).toBe(400);
    expect(await other.text()).toContain("Start Again");
    // 開いた人が進めているログインの Cookie は消さない。
    expect(other.headers.getSetCookie()).toEqual([]);
    expect(x.calls).toEqual([]);
    // 同じ state はもう使えない (接続のログインとして扱い、見つからない)。
    const again = await callback(env, x, state, cookie);
    expect(again.status).toBe(404);
    expect(x.calls).toEqual([]);
  });

  test("取り消したログインと、期限の切れたログインでは、X に何も求めない", async () => {
    const x = fakeX();
    const env = setupEnv();
    const denied = await startSetup(env, x);
    const response = await callback(
      env,
      x,
      denied.authorize.searchParams.get("state") ?? "",
      denied.cookie,
      {
        error: "access_denied",
      },
    );
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Login Cancelled");

    const late = await startSetup(env, x);
    const stub = env.PAIRING_ROUTES?.getByName("routes");
    if (!stub) throw new Error("Missing store");
    await runInDurableObject(stub, (_instance, state) => {
      const logins = state.storage.kv.get<{ expires: number }[]>("setup_logins") ?? [];
      state.storage.kv.put(
        "setup_logins",
        logins.map((login) => ({ ...login, expires: Date.now() - 1 })),
      );
    });
    const expired = await callback(
      env,
      x,
      late.authorize.searchParams.get("state") ?? "",
      late.cookie,
    );
    expect(expired.status).toBe(400);
    expect(await expired.text()).toContain("Login Expired");
    expect(x.calls).toEqual([]);
  });

  test("X_WEBHOOK_ID が別の Webhook を指していれば、接続ではそちらを使うことを出す", async () => {
    const x = fakeX();
    const env = setupEnv({ X_WEBHOOK_ID: "999" });
    const response = await completeSetup(env, x);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("X_WEBHOOK_ID is set to a different webhook");
  });

  test("一覧を読めなければ、何も登録しない", async () => {
    const x = fakeX({ listStatus: 503 });
    const env = setupEnv();
    const response = await completeSetup(env, x);
    expect(response.status).toBe(503);
    expect(
      x.calls.filter(({ method, path }) => method === "POST" && path === "/2/webhooks"),
    ).toEqual([]);
    expect(await storedWebhook(env)).toBeUndefined();
  });

  test("GET と POST のほかは受けず、フォームでない POST は断る", async () => {
    const x = fakeX();
    const env = setupEnv();
    const put = await handle(new Request(`${origin}/setup`, { method: "PUT" }), env, x.deps);
    expect(put.status).toBe(405);
    const opened = await handle(new Request(`${origin}/setup`), env, x.deps);
    const confirm = /name="confirm" value="([^"]+)"/.exec(await opened.text())?.[1] ?? "";
    const json = await handle(
      new Request(`${origin}/setup`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: origin,
          Cookie: cookieOf(opened, "__Host-tweetbot-setup-confirm"),
        },
        body: JSON.stringify({ confirm }),
      }),
      env,
      x.deps,
    );
    expect(json.status).toBe(403);
  });

  test("X から戻ったときも回数を数え、上限を超えたら X に何も求めない", async () => {
    const x = fakeX();
    let calls = 0;
    const env = setupEnv({
      CONNECT_LIMITER: { limit: async () => ({ success: ++calls === 1 }) },
    });
    const response = await completeSetup(env, x);
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("Too Many Attempts");
    expect(x.calls).toEqual([]);
  });

  test("結果のページは、日本語の端末では日本語で出す", async () => {
    const x = fakeX();
    const env = setupEnv();
    const { authorize, cookie } = await startSetup(env, x);
    const response = await handle(
      new Request(
        `${origin}/oauth/callback?${new URLSearchParams({ code: "auth-code", state: authorize.searchParams.get("state") ?? "" })}`,
        { headers: { Cookie: cookie, "Accept-Language": "ja-JP,ja;q=0.9" } },
      ),
      env,
      x.deps,
    );
    const body = await response.text();
    expect(body).toContain('<html lang="ja">');
    expect(body).toContain("Webhookを用意しました");
    expect(body).toContain("今登録しました");
  });

  test("X_WEBHOOK_ID の形が正しくなければ、接続できないことを出す", async () => {
    const x = fakeX();
    const env = setupEnv({ X_WEBHOOK_ID: " 999" });
    const response = await completeSetup(env, x);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("X_WEBHOOK_ID is not a webhook ID");
  });
});

describe("接続で使う Webhook の ID", () => {
  async function save(env: Env, id: string) {
    const stub = env.PAIRING_ROUTES?.getByName("routes");
    if (!stub) throw new Error("Missing store");
    await runInDurableObject(stub, (_instance, state) => state.storage.kv.put("webhook_id", id));
  }

  test("X_WEBHOOK_ID がなければ、/setup で保存した ID を使う", async () => {
    const env = setupEnv();
    expect(await connectConfig(env, pairingStore(env))).toBeUndefined();
    await save(env, "5550001");
    expect((await connectConfig(env, pairingStore(env)))?.webhookID).toBe("5550001");
  });

  test("X_WEBHOOK_ID を置いていれば、保存した ID より先に使い、形が正しくなければ使わない", async () => {
    await save(setupEnv(), "5550001");
    expect(
      (await connectConfig(setupEnv({ X_WEBHOOK_ID: "999" }), pairingStore(setupEnv())))?.webhookID,
    ).toBe("999");
    expect(
      await connectConfig(setupEnv({ X_WEBHOOK_ID: "abc" }), pairingStore(setupEnv())),
    ).toBeUndefined();
  });
});
