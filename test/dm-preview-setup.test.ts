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
  if (store) await runInDurableObject(store, (_instance, ctx) => ctx.storage.deleteAll());
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
    const page = await handle(new Request(url), env, deps);
    const html = await page.text();
    const nonce = /name="confirm" value="([A-Za-z0-9_-]+)"/.exec(html)?.[1];
    expect(nonce).toBeDefined();
    const consent = await handle(
      new Request(url, {
        method: "POST",
        headers: {
          Origin: base,
          "Content-Type": "application/x-www-form-urlencoded",
          Cookie: page.headers.get("Set-Cookie") ?? "",
        },
        body: new URLSearchParams({ confirm: nonce ?? "" }),
      }),
      env,
      deps,
    );
    expect(consent.status).toBe(303);
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

  test("requires the route owner and rejects forged consent without calling Twitter", async () => {
    const f = await fixture();
    expect((await f.api("start", f.body, `tpm_${"X".repeat(43)}`)).status).toBe(404);
    expect((await f.api("start", f.body, "wrong")).status).toBe(401);
    const response = await f.api("start");
    const { url } = z.object({ url: z.string() }).parse(await response.json());
    expect(
      (await handle(new Request(url, { method: "POST", body: "confirm=fake" }), f.env, f.deps))
        .status,
    ).toBe(403);
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
