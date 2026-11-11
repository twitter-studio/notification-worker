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

describe("reading Twitter key material for DM message text", () => {
  const otherPeer = "3333333333333333333";
  const record = {
    public_key_version: "7",
    public_key: "public-key",
    signing_public_key: "signing-key",
    identity_public_key_signature: "signature",
  };
  type Override = (url: URL) => Response | Promise<Response> | undefined;

  /** 同意を済ませ、X の応答の一部を差し替えて finish を呼ぶ。ログの欄も返す。 */
  async function finishWith(override: Override) {
    const f = await fixture();
    const { callback } = await f.authorize();
    await callback();
    const original = f.fetch.getMockImplementation();
    f.fetch.mockImplementation(async (input, init) => {
      const url = new URL(new Request(input, init).url);
      const replaced = await override(url);
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
    const response = await f.api("finish", { ...f.body, key: btoa(String.fromCharCode(...key)) });
    const logs = [...errors.mock.calls, ...infos.mock.calls]
      .map((call) => String(call[0]))
      .filter((line) => line.includes("dm_preview_setup"));
    errors.mockRestore();
    infos.mockRestore();
    let material: { keyChangesByConversation: Record<string, string[]>; signingKeys: unknown[] } = {
      keyChangesByConversation: {},
      signingKeys: [],
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
    return { status: response.status, logs, material, calls: f.calls };
  }

  const conversations = (rows: unknown[], extra: Record<string, unknown> = {}) =>
    Response.json({ data: rows, ...extra });
  const keyEvents = (events: unknown[]) =>
    Response.json({ meta: { conversation_key_events: events } });

  test("a failed read is logged by stage and status without account IDs or tokens", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({ title: `user ${owner}` }, { status: 500 })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(result.logs).toHaveLength(1);
    expect(JSON.parse(result.logs[0] ?? "")).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "own_keys",
      status: 500,
    });
    for (const secret of [owner, peer, "test-user-token"])
      expect(result.logs.join("\n")).not.toContain(secret);
  });

  test("a mismatched response shape is logged by field name and issue code only", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations" ? Response.json({ data: `${owner}` }) : undefined,
    );
    expect(result.status).toBe(503);
    expect(JSON.parse(result.logs[0] ?? "")).toEqual({
      event: "dm_preview_setup",
      outcome: "failed",
      stage: "conversations",
      issues: ["data:invalid_type"],
    });
    expect(result.logs.join("\n")).not.toContain(owner);
  });

  test("an X application error without data is logged by its problem type", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? Response.json({
            errors: [
              {
                type: "https://api.x.com/2/problems/not-authorized-for-resource",
                detail: `Sorry, you are not authorized to see ${owner}`,
              },
            ],
          })
        : undefined,
    );
    expect(result.status).toBe(503);
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({
      stage: "conversations",
      problem: "not-authorized-for-resource",
    });
    expect(result.logs.join("\n")).not.toContain(owner);
  });

  test("key records with a missing field are dropped instead of failing the setup", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/users/${owner}/public_keys`
        ? Response.json({
            data: [
              { public_key_version: "41", public_key: "old-key", signing_public_key: "old" },
              {
                ...record,
                public_key_version: "42",
                juicebox_config: { key_store_token_map_json: "{}" },
              },
            ],
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(result.material.signingKeys).toHaveLength(2);
  });

  test("partial errors next to conversation data do not stop the setup", async () => {
    const result = await finishWith((url) =>
      url.pathname === "/2/chat/conversations"
        ? conversations([{ id: `${owner}-${peer}`, participant_ids: [owner, peer] }], {
            errors: [{ type: "https://api.twitter.com/2/problems/resource-not-found" }],
          })
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
  });

  test.each([
    ["participant IDs without the owner", { participant_ids: [peer] }],
    ["the conversation ID", { id: `${peer}-${owner}` }],
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
            { id: `${owner}-${otherPeer}`, participant_ids: [owner, peer] },
            { id: "g123" },
            { id: `${owner}-${peer}`, participant_ids: [owner, peer] },
          ])
        : undefined,
    );
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({
      outcome: "prepared",
      conversation_count: 1,
      skipped: { conversation_shape: 3 },
    });
    expect(result.calls.some((url) => url.pathname.includes(otherPeer))).toBe(false);
  });

  test("one unreadable conversation is skipped and the others are still prepared", async () => {
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations")
        return conversations([
          { participant_ids: [owner, otherPeer] },
          { participant_ids: [owner, peer] },
        ]);
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`)
        return Response.json({}, { status: 403 });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({
      skipped: { "conversation_events:403": 1 },
    });
  });

  test("a peer whose keys would pass the app's 100 signing key limit is skipped", async () => {
    const many = Array.from({ length: 100 }, (_, index) => ({
      ...record,
      public_key_version: String(index + 1),
    }));
    const result = await finishWith((url) => {
      if (url.pathname === "/2/chat/conversations")
        return conversations([
          { participant_ids: [owner, otherPeer] },
          { participant_ids: [owner, peer] },
        ]);
      if (url.pathname === `/2/chat/conversations/${otherPeer}/events`) return keyEvents(["ZGVm"]);
      if (url.pathname === `/2/users/${otherPeer}/public_keys`)
        return Response.json({ data: many });
      return undefined;
    });
    expect(result.status).toBe(200);
    expect(result.material.signingKeys.length).toBeLessThanOrEqual(100);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({ skipped: { signing_key_limit: 1 } });
  });

  test("without any encrypted conversation the setup fails and says why", async () => {
    const result = await finishWith((url) =>
      url.pathname === `/2/chat/conversations/${peer}/events` ? keyEvents([]) : undefined,
    );
    expect(result.status).toBe(503);
    expect(JSON.parse(result.logs[0] ?? "")).toEqual({
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
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({ stage: "no_recovery_key" });
    expect(result.calls.some((url) => url.pathname === "/2/chat/conversations")).toBe(false);
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
    now.mockRestore();
    expect(reads).toBe(1);
    expect(result.status).toBe(200);
    expect(Object.keys(result.material.keyChangesByConversation)).toEqual([`${owner}:${peer}`]);
    expect(JSON.parse(result.logs[0] ?? "")).toMatchObject({ skipped: { deadline: 1 } });
  });
});
