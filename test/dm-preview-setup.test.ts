import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { handle } from "../src/app";
import { hex } from "../src/connect";
import { pairingStore } from "../src/pairing-store";
import { testEnv } from "./helpers";

const owner = "1111111111111111111";
const peer = "2222222222222222222";
const manager = `tpm_${"M".repeat(43)}`;
const webhook = "1234567890";
const base = "https://worker.test";
const enc = new TextEncoder();

afterEach(async () => {
  const store = pairingStore(testEnv({ PAIRING_ADMIN_TOKEN: `tpa_${"A".repeat(43)}` }));
  if (store)
    await runInDurableObject(store, (instance, ctx) => {
      // 接続のログインの許可は、ストレージではなくメモリにある。
      (instance as unknown as { dmPreviewGrants: Map<string, unknown> }).dmPreviewGrants.clear();
      return ctx.storage.deleteAll();
    });
});

async function fixture() {
  const env = testEnv({
    ENABLE_X_ACTIVITY: "true",
    PAIRING_ADMIN_TOKEN: `tpa_${"A".repeat(43)}`,
    ALLOWED_X_USER_IDS: owner,
    X_OAUTH2_CLIENT_ID: "test-client",
    X_APP_BEARER_TOKEN: "test-app-token",
    X_WEBHOOK_ID: webhook,
    CONNECT_LIMITER: { limit: async () => ({ success: true }) },
  });
  const store = pairingStore(env);
  if (!store) throw new Error("Fixture store missing");
  const routeID = crypto.randomUUID();
  const hash = await hex(manager);
  const code = crypto.randomUUID();
  await store.issue({
    recipient: owner,
    hash: code,
    proofKey: "a".repeat(64),
    expires: Date.now() + 600_000,
  });
  await store.reserveCode(code, owner, routeID, hash);
  expect(
    await store.registerRoute(code, {
      recipient: owner,
      routeID,
      managementHash: hash,
      token: `tsr_${"R".repeat(43)}`,
    }),
  ).toBe("connected");
  const calls: URL[] = [];
  let emptyFirstPage = false;
  const record = {
    public_key_version: "42",
    public_key: "public-key",
    signing_public_key: "signing-key",
    identity_public_key_signature: "signature",
  };
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    calls.push(url);
    if (url.pathname === "/2/oauth2/token")
      return Response.json({
        access_token: "test-user-token",
        token_type: "bearer",
        scope: "tweet.read users.read dm.read",
      });
    if (url.pathname === "/2/users/me") return Response.json({ data: { id: owner } });
    if (url.pathname === `/2/users/${owner}/public_keys`)
      return Response.json({
        data: [{ ...record, juicebox_config: { key_store_token_map_json: "{}" } }],
      });
    if (url.pathname === `/2/users/${peer}/public_keys`) return Response.json({ data: [record] });
    if (
      url.pathname === "/2/chat/conversations" &&
      emptyFirstPage &&
      !url.searchParams.has("pagination_token")
    )
      return Response.json({ data: [], meta: { has_more: true, next_token: "next-fixture-page" } });
    if (url.pathname === "/2/chat/conversations")
      return Response.json({ data: [{ id: `${owner}-${peer}`, participant_ids: [owner, peer] }] });
    if (url.pathname === `/2/chat/conversations/${peer}/events`)
      return Response.json({ meta: { conversation_key_events: ["YWJj"] } });
    if (url.pathname.includes("subscriptions"))
      return Response.json({
        data: [
          {
            subscription_id: "123",
            event_type: "dm.received",
            filter: { user_id: owner },
            webhook_id: webhook,
          },
          {
            subscription_id: "124",
            event_type: "chat.received",
            filter: { user_id: owner },
            webhook_id: webhook,
          },
        ],
      });
    throw new Error(`Unexpected fixture path: ${url.pathname}`);
  });
  const deps = { fetch, sleep: async () => {}, enqueueX: async () => {} };
  const body = { route_id: routeID, request_id: crypto.randomUUID(), app_state: "S".repeat(43) };
  const api = (action: string, payload: unknown = body, token = manager) =>
    handle(
      new Request(`${base}/v1/pairing/dm-preview/${action}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }),
      env,
      deps,
    );
  async function authorize() {
    const started = await api("start");
    expect(started.status).toBe(201);
    const { url } = z.object({ url: z.string() }).parse(await started.json());
    // 確かめのページはない (2026-11-12 に外した)。開くとすぐ X へ送る。
    const consent = await handle(new Request(url), env, deps);
    expect(consent.status).toBe(302);
    const oauth = new URL(consent.headers.get("Location") ?? "");
    expect(oauth.searchParams.get("scope")).toBe("tweet.read users.read dm.read");
    expect(oauth.searchParams.get("code_challenge_method")).toBe("S256");
    const state = oauth.searchParams.get("state") ?? "";
    const cookies =
      consent.headers
        .getSetCookie()
        .find((cookie) => cookie.startsWith("__Host-tweetbot-dm-preview=")) ?? "";
    const callback = () =>
      handle(
        new Request(`${base}/oauth/callback?state=${state}&code=test-code`, {
          headers: { Cookie: cookies },
        }),
        env,
        deps,
      );
    return { state, callback, oauth, cookies };
  }
  return {
    api,
    body,
    store,
    /** ルートをつないだコードのハッシュ。接続のログインの許可は、このコードでつないだルートにだけ移せる。 */
    pairedCode: code,
    env,
    deps,
    calls,
    authorize,
    fetch,
    hash,
    useEmptyFirstPage: () => {
      emptyFirstPage = true;
    },
  };
}

describe("DM message preview setup", () => {
  test("returns only device-encrypted material after browser consent and consumes the request", async () => {
    const f = await fixture();
    const { callback, state } = await f.authorize();
    expect(f.calls).toHaveLength(0);
    const result = await callback();
    expect(result.headers.get("Location")).toBe(
      `tweetbot-worker://dm-preview?state=${f.body.app_state}`,
    );
    expect((await callback()).status).toBe(400);
    const key = crypto.getRandomValues(new Uint8Array(32));
    const response = await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) });
    expect(response.status, f.calls.map((url) => url.pathname).join(",")).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const sealed = new Uint8Array(await response.arrayBuffer());
    const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.slice(0, 12),
        additionalData: enc.encode(
          `twitter-studio/x-chat-setup/v1\n${owner}\n${f.body.route_id}\n${f.body.request_id}`,
        ),
      },
      aes,
      sealed.slice(12),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({
      userID: owner,
      identityKeyVersion: "42",
      keyChangesByConversation: { [`${owner}:${peer}`]: ["YWJj"] },
    });
    expect(await f.store.readDMPreview(state)).toBeUndefined();
    expect(
      (await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) })).status,
    ).toBe(410);
    expect(
      f.calls.every(
        (url) => url.hostname === "api.x.com" && !url.search.includes("test-user-token"),
      ),
    ).toBe(true);
  });

  test("uses the connect login's grant without a browser or a second token exchange, once", async () => {
    const f = await fixture();
    await f.store.holdDMPreviewGrant(f.hash, owner, {
      accessToken: "connect-user-token",
      userID: owner,
      expires: Date.now() + 20_000,
      codeHash: f.pairedCode,
    });
    const started = await f.api("start", { ...f.body, use_connect_login: true });
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({ authorized: true });
    const key = crypto.getRandomValues(new Uint8Array(32));
    const response = await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) });
    expect(response.status, f.calls.map((url) => url.pathname).join(",")).toBe(200);
    const sealed = new Uint8Array(await response.arrayBuffer());
    const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: sealed.slice(0, 12),
        additionalData: enc.encode(
          `twitter-studio/x-chat-setup/v1\n${owner}\n${f.body.route_id}\n${f.body.request_id}`,
        ),
      },
      aes,
      sealed.slice(12),
    );
    expect(JSON.parse(new TextDecoder().decode(plaintext))).toMatchObject({ userID: owner });
    // 本人は接続のときに確かめてあるので、トークンの交換も本人の読み直しもしない。
    expect(f.calls.map((url) => url.pathname)).not.toContain("/2/oauth2/token");
    expect(f.calls.map((url) => url.pathname)).not.toContain("/2/users/me");
    expect(
      f.fetch.mock.calls.map(([, init]) => new Headers(init?.headers).get("Authorization")),
    ).toContain("Bearer connect-user-token");
    // 許可は使い切り。同じ要求でも、新しい要求でも、もう使えない。
    expect(
      (await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) })).status,
    ).toBe(410);
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
  });

  test("falls back to a browser login when there is no grant, without using the start interval", async () => {
    const f = await fixture();
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
    // ほかの管理キー (ほかの端末) の許可は使えない。
    await f.store.holdDMPreviewGrant(await hex(`tpm_${"Z".repeat(43)}`), owner, {
      accessToken: "other-device-token",
      userID: owner,
      expires: Date.now() + 20_000,
      codeHash: f.pairedCode,
    });
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
    // 期限の切れた許可も使えない。
    await f.store.holdDMPreviewGrant(f.hash, owner, {
      accessToken: "expired-token",
      userID: owner,
      expires: Date.now() - 1,
      codeHash: f.pairedCode,
    });
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
    // 断った直後でも、ブラウザでのログインを始められる。
    const started = await f.api("start");
    expect(started.status).toBe(201);
    expect(await started.json()).toEqual({
      url: expect.stringMatching(/\/dm-preview\?state=dmp_/),
    });
    expect(f.calls).toHaveLength(0);
  });

  test("moves a grant only to the route connected with the code issued by that login", async () => {
    const f = await fixture();
    // 同じ管理キーと本人でも、ほかのコードでつないだルート (前からある端末など) には移さない。
    await f.store.holdDMPreviewGrant(f.hash, owner, {
      accessToken: "connect-user-token",
      userID: owner,
      expires: Date.now() + 20_000,
      codeHash: "another-code",
    });
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
    expect(f.calls).toHaveLength(0);
  });

  test("refuses a claimed grant that expired before finishing, without calling Twitter", async () => {
    const f = await fixture();
    await f.store.holdDMPreviewGrant(f.hash, owner, {
      accessToken: "connect-user-token",
      userID: owner,
      expires: Date.now() + 200,
      codeHash: f.pairedCode,
    });
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 300));
    const key = btoa(String.fromCharCode(...new Uint8Array(32)));
    expect((await f.api("finish", { ...f.body, key })).status).toBe(410);
    expect(f.calls).toHaveLength(0);
  });

  test("uses a claimed grant only for the same request, and never logs the token", async () => {
    const f = await fixture();
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await f.store.holdDMPreviewGrant(f.hash, owner, {
        accessToken: "connect-user-token",
        userID: owner,
        expires: Date.now() + 20_000,
        codeHash: f.pairedCode,
      });
      expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(201);
      const key = btoa(String.fromCharCode(...new Uint8Array(32)));
      for (const other of [{ request_id: crypto.randomUUID() }, { app_state: "T".repeat(43) }]) {
        expect((await f.api("finish", { ...f.body, ...other, key })).status).toBe(410);
      }
      expect(f.calls).toHaveLength(0);
      expect((await f.api("finish", { ...f.body, key })).status).toBe(200);
      const printed = JSON.stringify([
        ...errors.mock.calls,
        ...infos.mock.calls,
        ...logs.mock.calls,
      ]);
      expect(printed).not.toContain("connect-user-token");
    } finally {
      errors.mockRestore();
      infos.mockRestore();
      logs.mockRestore();
    }
  });

  test("keeps claimed grants when the grants are full, and holds no new one", async () => {
    const f = await fixture();
    const grant = {
      accessToken: "claimed-token",
      userID: owner,
      expires: Date.now() + 20_000,
      codeHash: f.pairedCode,
    };
    // 16 件とも移した後 (`/finish` を待っている) にする。
    await runInDurableObject(f.store, (instance) => {
      const grants = (instance as unknown as { dmPreviewGrants: Map<string, unknown> })
        .dmPreviewGrants;
      for (let index = 0; index < 16; index += 1) grants.set(`request\n${index}`, grant);
    });
    await f.store.holdDMPreviewGrant(f.hash, owner, grant);
    const keys = await runInDurableObject(f.store, (instance) => [
      ...(instance as unknown as { dmPreviewGrants: Map<string, unknown> }).dmPreviewGrants.keys(),
    ]);
    expect(keys).toHaveLength(16);
    expect(keys.every((key) => key.startsWith("request\n"))).toBe(true);
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(410);
  });

  test("drops a claimed grant when the app cancels", async () => {
    const f = await fixture();
    await f.store.holdDMPreviewGrant(f.hash, owner, {
      accessToken: "connect-user-token",
      userID: owner,
      expires: Date.now() + 20_000,
      codeHash: f.pairedCode,
    });
    expect((await f.api("start", { ...f.body, use_connect_login: true })).status).toBe(201);
    expect((await f.api("cancel")).status).toBe(204);
    const key = btoa(String.fromCharCode(...new Uint8Array(32)));
    expect((await f.api("finish", { ...f.body, key })).status).toBe(410);
    expect(f.calls).toHaveLength(0);
  });

  test("sends the app back with rate_limited when a browser page hits the limit, without a blank page", async () => {
    const f = await fixture();
    const started = await f.api("start");
    const { url } = z.object({ url: z.string() }).parse(await started.json());
    const env = f.env as Env & { CONNECT_LIMITER: unknown };
    const limit = () => {
      env.CONNECT_LIMITER = { limit: async () => ({ success: false }) };
    };
    const allow = () => {
      env.CONNECT_LIMITER = { limit: async () => ({ success: true }) };
    };
    // どのログインか分かるので、アプリへ戻す。
    limit();
    const page = await handle(new Request(url), f.env, f.deps);
    expect(page.status).toBe(302);
    expect(page.headers.get("Location")).toBe(
      `tweetbot-worker://dm-preview?state=${f.body.app_state}&error=rate_limited`,
    );
    // どのログインか分からなければ、待つように書いた文のページを出す。
    const unknown = await handle(
      new Request(`${base}/dm-preview?state=dmp_${"U".repeat(43)}`, {
        headers: { "Accept-Language": "ja" },
      }),
      f.env,
      f.deps,
    );
    expect(unknown.status).toBe(429);
    expect(await unknown.text()).toContain("1分ほど待ってから");
    // アプリからの API は、今までどおり 429。
    expect((await f.api("finish", { ...f.body, key: btoa("k".repeat(32)) })).status).toBe(429);
    // 上限の中では書き込まないので、上限が明ければ同じ URL で X へ進める。
    allow();
    const reopened = await handle(new Request(url), f.env, f.deps);
    expect(reopened.status).toBe(302);
    expect(new URL(reopened.headers.get("Location") ?? "").host).toBe("x.com");
    expect(f.calls).toHaveLength(0);
  });

  test("sends the app back with rate_limited when the callback hits the limit, without exchanging the code", async () => {
    const f = await fixture();
    const { callback, state } = await f.authorize();
    (f.env as Env & { CONNECT_LIMITER: unknown }).CONNECT_LIMITER = {
      limit: async () => ({ success: false }),
    };
    const back = await callback();
    expect(back.status).toBe(302);
    expect(back.headers.get("Location")).toBe(
      `tweetbot-worker://dm-preview?state=${f.body.app_state}&error=rate_limited`,
    );
    expect(back.headers.getSetCookie()).toContain(
      "__Host-tweetbot-dm-preview=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
    );
    // 上限の中では書き込まないので、要求はブラウザでの同意を待つ状態のまま。
    expect((await f.store.readDMPreview(state))?.kind).toBe("authorizing");
    // ほかのブラウザから開いた戻り先は、アプリへ戻さない。
    const stranger = await handle(
      new Request(`${base}/oauth/callback?state=${state}&code=test-code`),
      f.env,
      f.deps,
    );
    expect(stranger.status).toBe(429);
    expect(await stranger.text()).toContain("Wait a minute");
    expect(f.calls).toHaveLength(0);
  });

  test("tells the app the owner declined even when the callback hits the limit", async () => {
    const f = await fixture();
    const { state, cookies } = await f.authorize();
    (f.env as Env & { CONNECT_LIMITER: unknown }).CONNECT_LIMITER = {
      limit: async () => ({ success: false }),
    };
    const back = await handle(
      new Request(`${base}/oauth/callback?state=${state}&error=access_denied`, {
        headers: { Cookie: cookies },
      }),
      f.env,
      f.deps,
    );
    expect(back.headers.get("Location")).toBe(
      `tweetbot-worker://dm-preview?state=${f.body.app_state}&error=denied`,
    );
    expect(f.calls).toHaveLength(0);
  });

  test("requires the route owner, and the browser page only takes GET, without calling Twitter", async () => {
    const f = await fixture();
    expect((await f.api("start", f.body, `tpm_${"X".repeat(43)}`)).status).toBe(404);
    expect((await f.api("start", f.body, "wrong")).status).toBe(401);
    const response = await f.api("start");
    const { url } = z.object({ url: z.string() }).parse(await response.json());
    expect(
      (await handle(new Request(url, { method: "POST", body: "confirm=fake" }), f.env, f.deps))
        .status,
    ).toBe(404);
    // 開けるのは 1 回だけ。2 回目は、もう X の同意を待っているので 410。
    expect((await handle(new Request(url), f.env, f.deps)).status).toBe(302);
    expect((await handle(new Request(url), f.env, f.deps)).status).toBe(410);
    expect(f.calls).toHaveLength(0);
  });

  test("rejects a callback from another browser and a route disconnected during consent", async () => {
    const f = await fixture();
    const { state, callback } = await f.authorize();
    expect(
      (
        await handle(
          new Request(`${base}/oauth/callback?state=${state}&code=test-code`),
          f.env,
          f.deps,
        )
      ).status,
    ).toBe(400);
    await f.store.disconnect(f.body.route_id, f.hash);
    expect((await callback()).status).toBe(400);
    expect(f.calls).toHaveLength(0);
  });

  test("pages past an empty filtered conversation page", async () => {
    const f = await fixture();
    f.useEmptyFirstPage();
    const { callback } = await f.authorize();
    await callback();
    expect((await f.api("finish", { ...f.body, key: btoa("x".repeat(32)) })).status).toBe(200);
    expect(
      f.calls.some((url) => url.searchParams.get("pagination_token") === "next-fixture-page"),
    ).toBe(true);
  });

  test("a key lookup failure cannot create DM subscriptions", async () => {
    const f = await fixture();
    const { callback } = await f.authorize();
    await callback();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/public_keys")) return Response.json({}, { status: 500 });
      if (!original) throw new Error("Missing fixture fetch");
      return original(input, init);
    });
    expect((await f.api("finish", { ...f.body, key: btoa("x".repeat(32)) })).status).toBe(503);
    expect(f.calls.some((url) => url.pathname.includes("subscriptions"))).toBe(false);
  });

  test("a different Twitter account cannot obtain recovery information", async () => {
    const f = await fixture();
    const { callback } = await f.authorize();
    await callback();
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        access_token: "test-user-token",
        token_type: "bearer",
        scope: "tweet.read users.read dm.read",
      }),
    );
    f.fetch.mockImplementationOnce(async () => Response.json({ data: { id: peer } }));
    const response = await f.api("finish", { ...f.body, key: btoa("x".repeat(32)) });
    expect(response.status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  test("insufficient read permission is rejected before reading key material", async () => {
    const f = await fixture();
    const { callback } = await f.authorize();
    await callback();
    f.fetch.mockImplementationOnce(async () =>
      Response.json({
        access_token: "test-user-token",
        token_type: "bearer",
        scope: "tweet.read users.read",
      }),
    );
    expect((await f.api("finish", { ...f.body, key: btoa("x".repeat(32)) })).status).toBe(403);
    expect(f.calls).toHaveLength(0);
  });

  test("cancellation removes the request and expiration erases its stored state", async () => {
    const f = await fixture();
    const { state } = await f.authorize();
    expect((await f.api("cancel")).status).toBe(204);
    expect(await f.store.readDMPreview(state)).toBeUndefined();
    await runInDurableObject(f.store, async (_instance, ctx) => {
      await ctx.storage.put("dm_previews", [{ state: "expired", expires: 0 }]);
    });
    await runInDurableObject(f.store, (instance) => instance.alarm());
    expect(
      await runInDurableObject(f.store, (_instance, ctx) => ctx.storage.get("dm_previews")),
    ).toEqual([]);
  });
});

describe("reading Twitter key material for DM message text", () => {
  const otherPeer = "3333333333333333333";
  const record = {
    public_key_version: "7",
    public_key: "public-key",
    signing_public_key: "signing-key",
    identity_public_key_signature: "signature",
  };
  const recoverable = {
    ...record,
    public_key_version: "42",
    juicebox_config: { key_store_token_map_json: "{}" },
  };
  type Fixture = Awaited<ReturnType<typeof fixture>>;
  type Override = (url: URL, f: Fixture) => Response | undefined | Promise<Response | undefined>;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** 同意を済ませ、X の応答の一部を差し替えて finish を呼ぶ。dm_preview_setup のログの欄も返す。 */
  async function finishWith(override: Override) {
    const f = await fixture();
    const { callback } = await f.authorize();
    await callback();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      const replaced = await override(url, f);
      if (replaced) {
        f.calls.push(url);
        return replaced;
      }
      if (!original) throw new Error("Missing fixture fetch");
      return original(input, init);
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
    const key = crypto.getRandomValues(new Uint8Array(32));
    let response: Response;
    let lines: string[];
    try {
      response = await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) });
      lines = [...errors.mock.calls, ...infos.mock.calls]
        .map((call) => String(call[0]))
        .filter((line) => line.includes("dm_preview_setup"));
    } finally {
      errors.mockRestore();
      infos.mockRestore();
    }
    let material = {
      keyChangesByConversation: {} as Record<string, string[]>,
      signingKeys: [] as unknown[],
      identityKeyVersion: "",
    };
    if (response.status === 200) {
      const sealed = new Uint8Array(await response.arrayBuffer());
      const aes = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sealed.slice(0, 12),
          additionalData: enc.encode(
            `twitter-studio/x-chat-setup/v1\n${owner}\n${f.body.route_id}\n${f.body.request_id}`,
          ),
        },
        aes,
        sealed.slice(12),
      );
      material = JSON.parse(new TextDecoder().decode(plaintext));
    }
    expect(lines).toHaveLength(1);
    const text = lines.join("\n");
    for (const secret of [owner, peer, otherPeer, "test-user-token"])
      expect(text).not.toContain(secret);
    // ユーザー ID や会話 ID の形の数字を出さない。
    expect(text).not.toMatch(/[0-9]{10,}/);
    return {
      status: response.status,
      log: JSON.parse(lines[0] ?? "{}"),
      material,
      calls: f.calls,
    };
  }

  const conversations = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    Response.json({ data: rows, ...extra });
  const keyEvents = (events: unknown[]) =>
    Response.json({
      data: [{ id: "1", encoded_event: "e" }],
      meta: { conversation_key_events: events },
    });
  const twoConversations = conversations([
    { participant_ids: [owner, otherPeer] },
    { participant_ids: [owner, peer] },
  ]);

  test("a failed read is logged by stage, status and X problem type without IDs or tokens", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json(
            {
              type: "https://api.x.com/2/problems/client-forbidden",
              detail: `user ${owner} is not allowed`,
            },
            { status: 403 },
          )
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "own_keys",
      status: 403,
      problem: "client-forbidden",
    });
  });

  test("a mismatched response shape is logged by field name and issue code only", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations" ? Response.json({ data: `${owner}` }) : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "conversations",
      issues: ["data:invalid_type"],
    });
  });

  test.each([
    [
      "without data",
      { errors: [{ type: "https://api.x.com/2/problems/not-authorized-for-resource" }] },
    ],
    [
      "with only meta",
      {
        meta: { result_count: 0 },
        errors: [{ type: "https://api.x.com/2/problems/not-authorized-for-resource" }],
      },
    ],
  ])("an X application error %s fails with its problem type", async (_name, body) => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations" ? Response.json(body) : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({
      stage: "conversations",
      status: 200,
      problem: "not-authorized-for-resource",
    });
  });

  test("partial errors next to conversation data are counted and do not stop the setup", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([{ id: `${owner}-${peer}`, participant_ids: [owner, peer] }], {
            errors: [{ type: "https://api.twitter.com/2/problems/resource-not-found" }],
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "prepared",
      conversation_count: 1,
      partial: { "conversations:resource-not-found": 1 },
    });
  });

  test("older key records with a missing field are dropped and counted", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({
            data: [
              { public_key_version: "41", public_key: "old-key", signing_public_key: "old" },
              recoverable,
            ],
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.material.identityKeyVersion).toBe("42");
    expect(result.material.signingKeys).toHaveLength(2);
    expect(result.log).toMatchObject({ skipped: { "own_keys:invalid_record": 1 } });
  });

  test.each([
    ["missing a field", { public_key_version: "43", public_key: "new-key" }],
    [
      "with an unknown recovery setting",
      { ...recoverable, public_key_version: "43", juicebox_config: "x" },
    ],
  ])(
    "an unreadable newer own key %s stops the setup instead of using an older key",
    async (_name, newer) => {
      const result = await finishWith((url) =>
        url.pathname === `/2/users/${owner}/public_keys`
          ? Response.json({ data: [newer, recoverable] })
          : undefined,
      );
      expect(result.status).toBe(503);
      expect(result.log).toMatchObject({ stage: "own_keys", problem: "newer_key_unreadable" });
    },
  );

  test("a peer key with another recovery setting shape is still used for signatures", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${peer}/public_keys`
        ? Response.json({ data: [{ ...record, juicebox_config: "other-shape" }] })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.material.signingKeys).toHaveLength(2);
  });

  test.each([
    ["participant IDs without the owner", { participant_ids: [peer] }],
    ["the conversation ID", { id: `${peer}-${owner}` }],
    [
      "the conversation ID when participant IDs are empty",
      { id: `${owner}-${peer}`, participant_ids: [] },
    ],
    [
      "participant IDs when the conversation ID is a bare number",
      { id: "123", participant_ids: [owner, peer] },
    ],
  ])("the peer is found from %s", async (_name, row) => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations" ? conversations([row]) : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
  });

  test("conversations that are not the owner's one-to-one chats are skipped", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([
            { id: `${otherPeer}-${peer}`, participant_ids: [otherPeer, peer] },
            { id: `${otherPeer}-${peer}`, participant_ids: [owner, peer] },
            { id: `${owner}-${otherPeer}`, participant_ids: [owner, peer] },
            { id: "g123", participant_ids: [owner, otherPeer] },
            { id: `${owner}-${otherPeer}`, type: "group" },
            { id: `${owner}-${peer}`, participant_ids: [owner, peer], type: "direct" },
          ])
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toMatchObject({ conversation_count: 1, skipped: { conversation_shape: 5 } });
    expect(result.calls.some((url) => url.pathname.includes(otherPeer))).toBe(false);
  });

  test.each([
    ["an error status", () => Response.json({}, { status: 403 }), "conversation_events:403"],
    [
      "a broken response body",
      () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.error(new DOMException("timed out", "TimeoutError"));
            },
          }),
        ),
      "conversation_events:TimeoutError",
    ],
    [
      "a network failure",
      () => {
        throw new TypeError("connection lost");
      },
      "conversation_events:TypeError",
    ],
  ])(
    "one conversation failing with %s is skipped and the others are prepared",
    async (_name, fail, reason) => {
      const result = await finishWith((url) => {
        if (url.pathname === "/2/chat/conversations") return twoConversations.clone();
        if (url.pathname === `/2/chat/conversations/${otherPeer}/events`) return fail();
        return undefined;
      });
      expect(result.status).toBe(200);
      expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
      expect(result.log).toMatchObject({ outcome: "prepared", skipped: { [reason]: 1 } });
    },
  );

  test("a single peer key record next to partial errors is kept", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${peer}/public_keys`
        ? Response.json({
            data: record,
            errors: [{ type: "https://api.x.com/2/problems/resource-not-found" }],
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.material.signingKeys).toHaveLength(2);
    expect(result.log).toMatchObject({ partial: { "peer_keys:resource-not-found": 1 } });
  });

  test("a peer whose keys cannot be read is skipped", async () => {
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations") return twoConversations.clone();
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`) return keyEvents(["ZGVm"]);
      if (url.pathname === `/2/users/${otherPeer}/public_keys`)
        return Response.json({}, { status: 404 });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.log).toMatchObject({ skipped: { "peer_keys:404": 1 } });
  });

  test("a failed later conversation page keeps the peers already found", async () => {
    const result = await finishWith((url) => {
      if (url.pathname !== "/2/chat/conversations") return undefined;
      if (url.searchParams.has("pagination_token")) return Response.json({}, { status: 503 });
      return conversations([{ participant_ids: [owner, peer] }], {
        meta: { has_more: true, next_token: "page-2" },
      });
    });
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toMatchObject({ skipped: { "conversations:503": 1 } });
  });

  test("key changes longer than the app accepts are dropped and counted apart from plain chats", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/chat/conversations/${peer}/events`
        ? keyEvents([`${"A".repeat(16384)}==`])
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({
      stage: "no_key_changes",
      skipped: { invalid_key_change: 1 },
    });
  });

  test("signing keys up to the app's limit of 100 are kept and a peer past it is skipped", async () => {
    const keysOf = (length: number) =>
      Array.from({ length }, (_, index) => ({ ...record, public_key_version: String(index + 1) }));
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations")
        return conversations([
          { participant_ids: [owner, peer] },
          { participant_ids: [owner, otherPeer] },
        ]);
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`) return keyEvents(["ZGVm"]);
      if (url.pathname === `/2/users/${peer}/public_keys`)
        return Response.json({ data: keysOf(99) });
      if (url.pathname === `/2/users/${otherPeer}/public_keys`)
        return Response.json({ data: keysOf(1) });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.material.signingKeys).toHaveLength(100);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toMatchObject({ skipped: { signing_key_limit: 1 } });
  });

  test("conversations that would make the material too large for the app are skipped", async () => {
    const peers = Array.from({ length: 20 }, (_, index) => `4${String(index).padStart(18, "0")}`);
    const large = Array.from({ length: 4 }, () => "A".repeat(16384));
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations")
        return conversations(peers.map((id) => ({ participant_ids: [owner, id] })));
      if (url.pathname.endsWith("/events")) return keyEvents(large);
      if (/^\/2\/users\/4[0-9]+\/public_keys$/.test(url.pathname))
        return Response.json({ data: [record] });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.log).toMatchObject({
      outcome: "prepared",
      conversation_count: 1,
      skipped: { material_size: 19 },
    });
    expect(JSON.stringify(result.material).length).toBeLessThanOrEqual(131044);
  });

  test("without any encrypted conversation the setup fails and says why", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/chat/conversations/${peer}/events` ? keyEvents([]) : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "no_key_changes",
      skipped: { no_key_change: 1 },
    });
  });

  test("without a recoverable key the setup fails before reading conversations", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({ data: [record] })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({ stage: "no_recovery_key" });
    expect(result.calls.some((url) => url.pathname === "/2/chat/conversations")).toBe(false);
  });

  test("a deadline reached before listing conversations names the stage it stopped in", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    const result = await finishWith((url) => {
      if (url.pathname !== `/2/users/${owner}/public_keys`) return undefined;
      // 本人の鍵を読み終えたところで、40 秒の締め切りを過ぎたことにする。
      now.mockReturnValue(start + 60_000);
      return Response.json({ data: [recoverable] });
    });
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({ stage: "deadline", during: "conversations" });
  });

  test("a request cut off by the overall deadline is logged as the deadline, not as that API", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    const result = await finishWith((url) => {
      if (url.pathname !== `/2/users/${owner}/public_keys`) return undefined;
      // 締め切りの残りで切れたことにする。
      now.mockReturnValue(start + 60_000);
      throw new DOMException("timed out", "TimeoutError");
    });
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({ stage: "deadline", during: "own_keys" });
  });

  test("conversations left after the deadline are skipped, keeping those already read", async () => {
    const start = Date.now();
    const now = vi.spyOn(Date, "now");
    let reads = 0;
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations")
        return conversations([
          { participant_ids: [owner, peer] },
          { participant_ids: [owner, otherPeer] },
        ]);
      if (url.pathname === `/2/users/${peer}/public_keys`) {
        reads += 1;
        // 1 つ目の会話を読み終えたところで、40 秒の締め切りを過ぎたことにする。
        now.mockReturnValue(start + 60_000);
        return Response.json({ data: [record] });
      }
      return undefined;
    });
    expect(reads).toBe(1);
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toMatchObject({ skipped: { deadline: 1 } });
  });

  test("a route disconnected while reading is logged as gone instead of prepared", async () => {
    const result = await finishWith(async (url, f) => {
      if (url.pathname !== `/2/users/${peer}/public_keys`) return undefined;
      await f.store.disconnect(f.body.route_id, f.hash);
      return Response.json({ data: [record] });
    });
    expect(result.status).toBe(410);
    expect(result.log).toMatchObject({ outcome: "route_gone", conversation_count: 1 });
  });

  test("an own key response with partial errors stops the setup", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({
            data: [recoverable],
            errors: [{ type: "https://api.x.com/2/problems/resource-not-found" }],
          })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({ stage: "own_keys", problem: "resource-not-found" });
  });

  test.each([
    ["an object", { type: "https://api.x.com/2/problems/resource-not-found" }],
    ["a string", "resource-not-found"],
  ])("an own key response whose errors field is %s stops the setup", async (_name, errors) => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({ data: [recoverable], errors })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toMatchObject({ stage: "own_keys", problem: "invalid_errors" });
  });

  test("a newer own key without a recovery setting is counted and the recoverable key is used", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({ data: [{ ...record, public_key_version: "43" }, recoverable] })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.material.identityKeyVersion).toBe("42");
    expect(result.log).toMatchObject({ skipped: { "own_keys:newer_without_recovery": 1 } });
  });

  test("a conversation whose events are refused with only meta is skipped with the problem type", async () => {
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations") return twoConversations.clone();
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`)
        return Response.json({
          meta: { result_count: 0 },
          errors: [{ type: "https://api.x.com/2/problems/not-authorized-for-resource" }],
        });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.log).toMatchObject({
      skipped: { "conversation_events:200:not-authorized-for-resource": 1 },
    });
  });

  test.each([
    ["an unreadable type", { participant_ids: [owner, otherPeer], type: "d".repeat(33) }],
    ["too many participants", { participant_ids: [owner, otherPeer, peer] }],
    ["an unreadable ID", { id: "1".repeat(65), participant_ids: [owner, otherPeer] }],
    ["a non-numeric participant", { id: `${owner}-${otherPeer}`, participant_ids: [owner, "me"] }],
    ["an empty ID", { id: "", participant_ids: [owner, otherPeer] }],
    ["an ID in no documented form", { id: "dm-1", participant_ids: [owner, otherPeer] }],
  ])("a conversation with %s is skipped", async (_name, row) => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([row, { participant_ids: [owner, peer] }])
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(result.log).toMatchObject({ skipped: { conversation_shape: 1 } });
    expect(result.calls.some((url) => url.pathname.includes(otherPeer))).toBe(false);
  });

  test("a repeated page token stops paging and keeps the peers already found", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([{ participant_ids: [owner, peer] }], {
            meta: { has_more: true, next_token: "same-page" },
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.log).toMatchObject({ skipped: { "conversations:repeated_page": 1 } });
    expect(result.calls.filter((url) => url.pathname === "/2/chat/conversations")).toHaveLength(2);
  });

  test("paging stops when has_more is false even with a next token", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([{ participant_ids: [owner, peer] }], {
            meta: { has_more: false, next_token: "next" },
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.calls.filter((url) => url.pathname === "/2/chat/conversations")).toHaveLength(1);
  });

  test("a problem type carrying an ID is left out of the log", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({ type: `https://api.x.com/2/problems/user${owner}` }, { status: 403 })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "own_keys",
      status: 403,
    });
  });

  test("a peer without any usable key is skipped", async () => {
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations") return twoConversations.clone();
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`) return keyEvents(["ZGVm"]);
      if (url.pathname === `/2/users/${otherPeer}/public_keys`) return Response.json({ data: [] });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.log).toMatchObject({ skipped: { "peer_keys:none": 1 } });
  });

  test("a failure outside reading Twitter is still logged once as unexpected", async () => {
    vi.spyOn(crypto.subtle, "importKey").mockRejectedValueOnce(new TypeError("broken"));
    const result = await finishWith(() => undefined);
    expect(result.status).toBe(503);
    expect(result.log).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "unexpected",
      problem: "TypeError",
    });
  });
});
