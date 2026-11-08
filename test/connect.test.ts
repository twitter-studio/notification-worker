import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { z } from "zod";
import { handle } from "../src/app";
import { sourceKey } from "../src/connect";
import { deliveryTargets, pairingStore } from "../src/pairing-store";
import { cleanupWorkerSubscriptions } from "../src/x-subscriptions";
import { testEnv } from "./helpers";

const admin = `tpa_${"A".repeat(43)}`;
const appState = "S".repeat(43);
const webhookID = "1234567890";
const clientSecret = "c".repeat(40);
const enc = new TextEncoder();
const toHex = async (value: string) =>
  Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");

type Call = { method: string; path: string; authorization: string | null; body: string };
type Row = {
  event_type: string;
  direction?: string;
  qualifiers?: Record<string, string>;
  tag?: string;
};

/** X の API の偽物。呼ばれた要求を残し、本人のトークンと App-only の Bearer の使い分けも確かめられるようにする。 */
function fakeX(options: {
  me: string;
  existing?: Row[];
  failCreate?: string;
  throwOnCreate?: string;
  loseResponseOn?: string;
  failDelete?: boolean;
  hideFromList?: boolean;
}) {
  const calls: Call[] = [];
  const rows = new Map<string, Row>(
    (options.existing ?? []).map((row, index) => [`${100 + index}`, row]),
  );
  let challenge = "";
  let next = 1;
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
        scope: "tweet.read users.read like.read dm.read",
      });
    }
    if (url.pathname === "/2/users/me") return Response.json({ data: { id: options.me } });
    if (url.pathname === "/2/activity/subscriptions" && request.method === "GET") {
      if (options.hideFromList) return Response.json({ data: [] });
      return Response.json({
        data: [...rows].map(([id, row]) => ({
          subscription_id: id,
          event_type: row.event_type,
          webhook_id: webhookID,
          ...(row.tag ? { tag: row.tag } : {}),
          filter: {
            user_id: options.me,
            ...(row.direction ? { direction: row.direction } : {}),
            ...(row.qualifiers ? { qualifiers: row.qualifiers } : {}),
          },
        })),
      });
    }
    if (url.pathname === "/2/activity/subscriptions" && request.method === "POST") {
      const sent = JSON.parse(body) as { event_type: string; tag: string };
      if (sent.event_type === options.throwOnCreate) throw new Error("timeout");
      if (sent.event_type === options.loseResponseOn) {
        rows.set(`${next++}`, { event_type: sent.event_type, tag: sent.tag });
        throw new Error("response lost");
      }
      if (sent.event_type === options.failCreate) return Response.json({}, { status: 429 });
      const id = `${next++}`;
      rows.set(id, { event_type: sent.event_type, tag: sent.tag });
      return Response.json({ data: { subscription: { subscription_id: id } } });
    }
    if (url.pathname.startsWith("/2/activity/subscriptions/") && request.method === "DELETE") {
      if (options.failDelete) return Response.json({}, { status: 503 });
      rows.delete(url.pathname.split("/").at(-1) ?? "");
      return Response.json({ data: { deleted: true } });
    }
    return Response.json({}, { status: 404 });
  };
  return {
    calls,
    rows,
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

function connectEnv(user: string, overrides: Partial<Env> = {}): Env {
  return testEnv({
    PAIRING_ADMIN_TOKEN: admin,
    ENABLE_X_ACTIVITY: "true",
    X_OAUTH2_CLIENT_ID: "client-id",
    X_OAUTH2_CLIENT_SECRET: clientSecret,
    ALLOWED_X_USER_IDS: `9, ${user}`,
    X_WEBHOOK_ID: webhookID,
    X_APP_BEARER_TOKEN: "app-bearer",
    CONNECT_LIMITER: { limit: async () => ({ success: true }) },
    ...overrides,
  });
}

/** `/connect` を開いて X の認可の URL と、ブラウザの Cookie を受け取る。 */
async function startLogin(
  env: Env,
  x: ReturnType<typeof fakeX>,
  user: string,
  types: string,
  manager: string,
) {
  const query = new URLSearchParams({
    x_user_id: user,
    types,
    app_state: appState,
    management_hash: await toHex(manager),
  });
  const started = await handle(new Request(`https://worker.test/connect?${query}`), env, x.deps);
  const cookie = (started.headers.get("Set-Cookie") ?? "").split(";")[0] ?? "";
  const authorize = new URL(started.headers.get("Location") ?? "https://invalid.test");
  x.setChallenge(authorize.searchParams.get("code_challenge") ?? "");
  return { started, cookie, authorize, state: authorize.searchParams.get("state") ?? "" };
}

function callback(env: Env, x: ReturnType<typeof fakeX>, query: string, cookie: string) {
  return handle(
    new Request(`https://worker.test/oauth/callback?${query}`, {
      headers: cookie ? { Cookie: cookie } : {},
    }),
    env,
    x.deps,
  );
}

function appRedirect(response: Response) {
  expect(response.status).toBe(302);
  const location = new URL(response.headers.get("Location") ?? "");
  expect(`${location.protocol}//${location.host}${location.pathname}`).toBe(
    "tweetbot-worker://connect",
  );
  return Object.fromEntries(location.searchParams);
}

/** 今の署名付きの接続 (ADR-0007) で、出したコードを使ってルートを足す。 */
async function pairWithCode(
  env: Env,
  deps: ReturnType<typeof fakeX>["deps"],
  user: string,
  code: string,
  manager: string,
) {
  const call = (suffix: string, body: unknown) =>
    handle(
      new Request(`https://worker.test/v1/pairing${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${manager}` },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
  const route_id = crypto.randomUUID();
  const signed = await call("/challenge", {
    lookup: await toHex(code),
    nonce: "a".repeat(64),
    route_id,
    management_hash: await toHex(manager),
    x_user_id: user,
  });
  const connected =
    signed.status === 200
      ? await call("", { x_user_id: user, route_id, relay_token: `tsr_${manager.slice(4)}`, code })
      : signed;
  return { route_id, status: connected.status, call };
}

describe("connecting with an X login", () => {
  test("sends the owner to X with PKCE, creates only the missing subscriptions, and returns a code bound to the app", async () => {
    const user = "3333333333333333333";
    const manager = `tpm_${"Q".repeat(43)}`;
    const env = connectEnv(user);
    const x = fakeX({
      me: user,
      existing: [
        { event_type: "post.mention.create" },
        { event_type: "like.create", qualifiers: { direction: "inbound" } },
      ],
    });

    const login = await startLogin(env, x, user, "mention,reply,like", manager);
    expect(login.started.status).toBe(302);
    expect(login.started.headers.get("Cache-Control")).toBe("no-store");
    expect(login.started.headers.get("Set-Cookie")).toMatch(
      /^__Host-tweetbot-connect=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax; Max-Age=600$/,
    );
    expect(login.authorize.origin + login.authorize.pathname).toBe(
      "https://x.com/i/oauth2/authorize",
    );
    expect(login.authorize.searchParams.get("client_id")).toBe("client-id");
    expect(login.authorize.searchParams.get("redirect_uri")).toBe(
      "https://worker.test/oauth/callback",
    );
    expect(login.authorize.searchParams.get("scope")?.split(" ").sort()).toEqual([
      "like.read",
      "tweet.read",
      "users.read",
    ]);
    expect(login.authorize.searchParams.get("code_challenge_method")).toBe("S256");

    const back = appRedirect(
      await callback(env, x, `code=x-code&state=${login.state}`, login.cookie),
    );
    expect(back.state).toBe(appState);
    expect(back.code).toMatch(/^tpc_[A-Za-z0-9_-]{43}$/);

    const token = x.calls.find((call) => call.path === "/2/oauth2/token");
    expect(token?.authorization).toBe(`Basic ${btoa(`client-id:${clientSecret}`)}`);
    const creations = x.calls.filter(
      (call) => call.path === "/2/activity/subscriptions" && call.method === "POST",
    );
    // メンションと、qualifiers で向きを付けたいいねは、持ち主の購読を使い、返信だけを作る。
    const sent = creations.map((call) => JSON.parse(call.body) as Record<string, unknown>);
    expect(sent.map(({ tag, ...rest }) => rest)).toEqual([
      { event_type: "post.reply.create", filter: { user_id: user }, webhook_id: webhookID },
    ]);
    expect(
      sent.every((body) => /^tweetbot-worker-connect-[a-f0-9]{16}$/.test(String(body.tag))),
    ).toBe(true);
    expect(creations.every((call) => call.authorization === "Bearer user-token")).toBe(true);
    expect(
      x.calls.find((call) => call.method === "GET" && call.path === "/2/activity/subscriptions")
        ?.authorization,
    ).toBe("Bearer app-bearer");

    // state は使い切り。同じ戻り先をもう一度開いても、コードは出ない。
    expect((await callback(env, x, `code=x-code&state=${login.state}`, login.cookie)).status).toBe(
      400,
    );

    // コードは、ログインを始めたアプリの管理キーでしか使えない。
    const stranger = await pairWithCode(
      env,
      x.deps,
      user,
      back.code ?? "",
      `tpm_${"R".repeat(43)}`,
    );
    expect(stranger.status).toBe(401);
    const paired = await pairWithCode(env, x.deps, user, back.code ?? "", manager);
    expect(paired.status).toBe(204);
    const target = (await deliveryTargets(env)).find((item) => item.routeID === paired.route_id);
    expect(target?.eventTypes).toEqual(["mention", "reply", "like"]);

    // 外すと、Worker が作った購読だけを消す。持ち主の購読は残る。
    expect((await paired.call("/disconnect", { route_id: paired.route_id })).status).toBe(204);
    const deletions = x.calls.filter((call) => call.method === "DELETE");
    expect(deletions.map((call) => [call.path, call.authorization])).toEqual([
      ["/2/activity/subscriptions/1", "Bearer app-bearer"],
    ]);
    expect([...x.rows.keys()].sort()).toEqual(["100", "101"]);
  });

  test("refuses a callback from a browser that did not start the login, and creates nothing", async () => {
    const user = "4444444444444444444";
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "mention", `tpm_${"B".repeat(43)}`);
    const response = await callback(
      env,
      x,
      `code=x-code&state=${login.state}`,
      `__Host-tweetbot-connect=${"Z".repeat(43)}`,
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("Location")).toBeNull();
    expect(x.calls).toHaveLength(0);
  });

  test("does not send an account that is not allowed to X", async () => {
    const env = connectEnv("4444444444444444441");
    const x = fakeX({ me: "5555555555555555555" });
    const login = await startLogin(
      env,
      x,
      "5555555555555555555",
      "mention",
      `tpm_${"B".repeat(43)}`,
    );
    expect(appRedirect(login.started)).toEqual({ state: appState, error: "not_allowed" });
    expect(x.calls).toHaveLength(0);
  });

  test("refuses a login with a different X account and creates nothing", async () => {
    const user = "6666666666666666666";
    const env = connectEnv(user);
    const x = fakeX({ me: "9" });
    const login = await startLogin(env, x, user, "mention", `tpm_${"C".repeat(43)}`);
    expect(
      appRedirect(await callback(env, x, `code=x-code&state=${login.state}`, login.cookie)),
    ).toEqual({ state: appState, error: "wrong_account" });
    expect(x.calls.some((call) => call.path.startsWith("/2/activity/"))).toBe(false);
  });

  test("returns to the app when the owner denies the login or the token cannot be obtained", async () => {
    const user = "7777777777777777777";
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const denied = await startLogin(env, x, user, "mention", `tpm_${"D".repeat(43)}`);
    expect(
      appRedirect(
        await callback(env, x, `error=access_denied&state=${denied.state}`, denied.cookie),
      ),
    ).toEqual({ state: appState, error: "denied" });
    const broken = await startLogin(env, x, user, "mention", `tpm_${"D".repeat(43)}`);
    x.setChallenge("not-the-challenge");
    expect(
      appRedirect(await callback(env, x, `code=x-code&state=${broken.state}`, broken.cookie)),
    ).toEqual({ state: appState, error: "unavailable" });
  });

  test("returns an expired login to the app without calling X", async () => {
    const user = "1212121212121212121";
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "mention", `tpm_${"E".repeat(43)}`);
    const store = pairingStore(env);
    if (!store) throw new Error("Missing store");
    // ログインの途中の状態の期限を、過去に書き換える。
    const taken = await store.takeLogin(login.state);
    if (!taken.login) throw new Error("Missing login");
    await store.finishLogin(login.state);
    const { processingUntil: _, ...waiting } = taken.login;
    await store.beginLogin({ ...waiting, expires: Date.now() - 1 });
    expect(
      appRedirect(await callback(env, x, `code=x-code&state=${login.state}`, login.cookie)),
    ).toEqual({ state: appState, error: "expired" });
    expect(x.calls).toHaveLength(0);
  });

  test("removes what it created when a later creation fails or throws, and issues no code", async () => {
    for (const failure of [{ failCreate: "chat.received" }, { throwOnCreate: "chat.received" }]) {
      const user = failure.failCreate ? "8888888888888888888" : "8888888888888888881";
      const env = connectEnv(user);
      const x = fakeX({ me: user, ...failure });
      const login = await startLogin(env, x, user, "mention,dm", `tpm_${"F".repeat(43)}`);
      expect(login.authorize.searchParams.get("scope")?.split(" ")).toContain("dm.read");
      expect(
        appRedirect(await callback(env, x, `code=x-code&state=${login.state}`, login.cookie)),
      ).toEqual({ state: appState, error: "subscription_failed" });
      expect(
        x.calls
          .filter((call) => call.method === "DELETE")
          .map((call) => [call.path, call.authorization]),
      ).toEqual([
        ["/2/activity/subscriptions/1", "Bearer user-token"],
        ["/2/activity/subscriptions/2", "Bearer user-token"],
      ]);
      expect(x.rows.size).toBe(0);
      expect(await pairingStore(env)?.subscriptionRecipients()).not.toContain(user);
    }
  });

  test("keeps subscriptions while a manual route uses the account, and cleans up leftovers later", async () => {
    const user = "1313131313131313131";
    const manager = `tpm_${"G".repeat(43)}`;
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "reply", manager);
    const back = appRedirect(
      await callback(env, x, `code=x-code&state=${login.state}`, login.cookie),
    );
    const store = pairingStore(env);
    if (!store) throw new Error("Missing store");

    // コードが有効な間は、ルートがなくても消さない。
    await cleanupWorkerSubscriptions(env, store, x.deps);
    expect(x.rows.size).toBe(1);

    const paired = await pairWithCode(env, x.deps, user, back.code ?? "", manager);
    expect(paired.status).toBe(204);
    // 手動の配送先が同じアカウントにあれば、最後のルートを外しても消さない。
    const withManual = testEnv({
      ...env,
      X_RELAY_ROUTES: JSON.stringify({
        [user]: [{ relay_token: `tsr_${"M".repeat(43)}`, route_id: crypto.randomUUID() }],
      }),
    });
    const removed = await handle(
      new Request("https://worker.test/v1/pairing/disconnect", {
        method: "POST",
        headers: { Authorization: `Bearer ${manager}` },
        body: JSON.stringify({ route_id: paired.route_id }),
      }),
      withManual,
      x.deps,
    );
    expect(removed.status).toBe(204);
    expect(x.rows.size).toBe(1);

    // 手動の配送先がなくなれば、定期の処理が片付ける。消せなかったら記録に残し、次にやり直す。
    const failing = fakeX({ me: user, failDelete: true });
    for (const [id, row] of x.rows) failing.rows.set(id, row);
    await cleanupWorkerSubscriptions(env, store, failing.deps);
    expect(await store.subscriptionRecipients()).toContain(user);
    await cleanupWorkerSubscriptions(env, store, x.deps);
    expect(x.rows.size).toBe(0);
    expect(await store.subscriptionRecipients()).not.toContain(user);
  });

  test("is hidden until the Worker has the X app settings and X activity is on, and limits each source", async () => {
    const x = fakeX({ me: "1" });
    const manager = `tpm_${"H".repeat(43)}`;
    expect(
      (await startLogin(testEnv({ PAIRING_ADMIN_TOKEN: admin }), x, "1", "mention", manager))
        .started.status,
    ).toBe(404);
    expect(
      (
        await startLogin(
          connectEnv("2", { ENABLE_X_ACTIVITY: "false" }),
          x,
          "2",
          "mention",
          manager,
        )
      ).started.status,
    ).toBe(404);
    const withoutLimiter = connectEnv("2");
    Reflect.deleteProperty(withoutLimiter, "CONNECT_LIMITER");
    expect((await startLogin(withoutLimiter, x, "2", "mention", manager)).started.status).toBe(404);
    const version = await handle(
      new Request("https://worker.test/v1/pairing"),
      connectEnv("2"),
      x.deps,
    );
    expect(await version.json()).toEqual({ version: 3, x_login: true });

    const env = connectEnv("2");
    expect((await startLogin(env, x, "2", "poll", manager)).started.status).toBe(400);
    expect(
      (
        await handle(
          new Request("https://worker.test/connect?x_user_id=2&types=mention"),
          env,
          x.deps,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handle(
          new Request("https://worker.test/oauth/callback?code=c&state=short"),
          env,
          x.deps,
        )
      ).status,
    ).toBe(400);

    const keys: string[] = [];
    const limited = connectEnv("2", {
      CONNECT_LIMITER: {
        limit: async ({ key }) => {
          keys.push(key);
          return { success: false };
        },
      },
    });
    const response = await handle(
      new Request("https://worker.test/connect", { headers: { "CF-Connecting-IP": "192.0.2.1" } }),
      limited,
      x.deps,
    );
    expect(response.status).toBe(429);
    expect(keys).toEqual(["connect:192.0.2.1"]);
  });

  test("never stores the X token", async () => {
    const user = "1414141414141414141";
    const manager = `tpm_${"J".repeat(43)}`;
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "mention", manager);
    const back = appRedirect(
      await callback(env, x, `code=x-code&state=${login.state}`, login.cookie),
    );
    const store = pairingStore(env);
    if (!store) throw new Error("Missing store");
    z.object({ code: z.string() }).parse(back);
    const saved = JSON.stringify([
      await store.list(),
      await store.subscriptionRecipients(),
      await store.takeLogin(login.state),
    ]);
    expect(saved).not.toContain("user-token");
    expect(saved).not.toContain(clientSecret);
  });
});

describe("keeping Worker subscriptions in step with connections", () => {
  test("a login that was only started does not keep subscriptions, but one being finished does", async () => {
    const user = "1515151515151515151";
    const env = connectEnv(user);
    const x = fakeX({
      me: user,
      existing: [{ event_type: "post.reply.create", tag: "tweetbot-worker-connect-old" }],
    });
    const store = pairingStore(env);
    if (!store) throw new Error("Missing store");
    await store.recordSubscriptions(user, ["100"]);

    const started = await startLogin(env, x, user, "reply", `tpm_${"K".repeat(43)}`);
    const taken = await store.takeLogin(started.state);
    expect(taken.login).toBeDefined();
    await cleanupWorkerSubscriptions(env, store, x.deps);
    expect(x.rows.has("100")).toBe(true);

    await store.finishLogin(started.state);
    await startLogin(env, x, user, "reply", `tpm_${"K".repeat(43)}`);
    await cleanupWorkerSubscriptions(env, store, x.deps);
    expect(x.rows.has("100")).toBe(false);
  });

  test("after a lost creation it removes only what this attempt made, not another connection's subscription", async () => {
    const user = "1616161616161616161";
    const env = connectEnv(user);
    const x = fakeX({
      me: user,
      existing: [
        { event_type: "post.mention.create", tag: "tweetbot-worker-connect-other-device" },
      ],
      loseResponseOn: "chat.received",
    });
    const login = await startLogin(env, x, user, "mention,reply,dm", `tpm_${"L".repeat(43)}`);
    expect(
      appRedirect(await callback(env, x, `code=x-code&state=${login.state}`, login.cookie)),
    ).toEqual({
      state: appState,
      error: "subscription_failed",
    });
    expect([...x.rows.keys()]).toEqual(["100"]);
    expect(x.calls.filter((call) => call.method === "DELETE").map((call) => call.path)).toEqual([
      "/2/activity/subscriptions/1",
      "/2/activity/subscriptions/2",
      "/2/activity/subscriptions/3",
    ]);
  });

  test("keeps a subscription it could not delete unless the list shows the others are visible", async () => {
    const user = "1717171717171717171";
    const env = connectEnv(user);
    const store = pairingStore(env);
    if (!store) throw new Error("Missing store");
    const hidden = fakeX({
      me: user,
      existing: [{ event_type: "post.reply.create" }],
      failDelete: true,
      hideFromList: true,
    });
    await store.recordSubscriptions(user, ["100"]);
    await cleanupWorkerSubscriptions(env, store, hidden.deps);
    expect(await store.subscriptionRecipients()).toContain(user);

    const visible = fakeX({
      me: user,
      existing: [{ event_type: "post.reply.create" }],
      failDelete: true,
    });
    await store.recordSubscriptions(user, ["100", "999"]);
    await cleanupWorkerSubscriptions(env, store, visible.deps);
    expect(await store.releasableSubscriptions(user)).toEqual(["100"]);
    await store.forgetSubscriptions(user, ["100"]);
  });

  test("refuses a callback without the browser cookie", async () => {
    const user = "1818181818181818181";
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "mention", `tpm_${"M".repeat(43)}`);
    const response = await callback(env, x, `code=x-code&state=${login.state}`, "");
    expect(response.status).toBe(400);
    expect(x.calls).toHaveLength(0);
  });

  test("counts IPv6 sources per /64 and IPv4 per address", () => {
    expect(sourceKey("192.0.2.1")).toBe("192.0.2.1");
    expect(sourceKey("2001:db8:0:1::5")).toBe("2001:db8:0:1::/64");
    expect(sourceKey("2001:DB8:0000:0001:aaaa:bbbb:cccc:dddd")).toBe("2001:db8:0:1::/64");
    expect(sourceKey("::1")).toBe("0:0:0:0::/64");
  });

  test("keeps no X token or client secret anywhere in the Durable Object", async () => {
    const user = "1919191919191919191";
    const manager = `tpm_${"N".repeat(43)}`;
    const env = connectEnv(user);
    const x = fakeX({ me: user });
    const login = await startLogin(env, x, user, "mention", manager);
    const back = appRedirect(
      await callback(env, x, `code=x-code&state=${login.state}`, login.cookie),
    );
    expect(back.code).toBeDefined();
    const stub = env.PAIRING_ROUTES?.getByName("routes");
    if (!stub) throw new Error("Missing store");
    const saved = await runInDurableObject(stub, (_instance, state) =>
      JSON.stringify(
        ["pairing", "logins", "subscriptions"].map((key) => state.storage.kv.get(key)),
      ),
    );
    expect(saved).not.toContain("user-token");
    expect(saved).not.toContain(clientSecret);
    expect(saved).not.toContain("x-code");
  });
});
