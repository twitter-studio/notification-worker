import { describe, expect, onTestFinished, test } from "vitest";
import { z } from "zod";
import { handle } from "../src/app";
import { applyRouteChanges, deliveryTargets, type StoredRoute } from "../src/pairing-store";
import { handleXQueue, relayBinding } from "../src/x-queue";
import { fakeRelay, testEnv } from "./helpers";

const admin = `tpa_${"A".repeat(43)}`;
const manager = `tpm_${"B".repeat(43)}`;
const otherManager = `tpm_${"C".repeat(43)}`;
const relayToken = `tsr_${"D".repeat(43)}`;
const user = "1111111111111111111";
const otherUser = "2222222222222222222";

test("pairs only the selected account once, tests its relay, and removes just that route", async () => {
  const relay = fakeRelay();
  const env = testEnv({ PAIRING_ADMIN_TOKEN: admin, ENABLE_X_ACTIVITY: "true" });
  const call = (suffix: string, token: string, body: unknown) =>
    handle(
      new Request(`https://worker.test/v1/pairing${suffix}`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        body: JSON.stringify(body),
      }),
      env,
      relay.deps,
    );

  expect((await call("/codes", otherManager, { x_user_id: user })).status).toBe(401);
  const issued = await call("/codes", admin, { x_user_id: user });
  expect(issued.status).toBe(201);
  const { code } = z.object({ code: z.string() }).parse(await issued.json());
  const route_id = crypto.randomUUID();
  const enc = new TextEncoder();
  const toHex = (value: ArrayBuffer) =>
    Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
  const lookup = toHex(await crypto.subtle.digest("SHA-256", enc.encode(code)));
  const nonce = "a".repeat(64);
  const management_hash = toHex(await crypto.subtle.digest("SHA-256", enc.encode(manager)));
  const challenge = { lookup, nonce, route_id, management_hash, x_user_id: user };
  const signed = await call("/challenge", "", challenge);
  expect(signed.status).toBe(200);
  const proofKey = toHex(
    await crypto.subtle.digest("SHA-256", enc.encode(`tweetbot-pairing-proof-key-v1\n${code}`)),
  );
  const signingKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(proofKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = await crypto.subtle.sign(
    "HMAC",
    signingKey,
    enc.encode(
      `tweetbot-worker-pairing-v1\nhttps://worker.test\n${user}\n${route_id}\n${management_hash}\n${nonce}`,
    ),
  );
  expect(await signed.json()).toEqual({ proof: toHex(expected) });
  expect((await call("/challenge", "", { ...challenge, x_user_id: otherUser })).status).toBe(401);
  expect((await call("/challenge", "", { ...challenge, lookup: "0".repeat(64) })).status).toBe(401);
  const route = { x_user_id: user, route_id, relay_token: relayToken, code };
  expect((await call("", manager, { ...route, x_user_id: otherUser })).status).toBe(401);
  expect((await call("", manager, { ...route, relay_token: env.RELAY_TOKEN })).status).toBe(409);
  const cancelledID = crypto.randomUUID();
  expect((await call("/challenge", "", { ...challenge, route_id: cancelledID })).status).toBe(200);
  expect((await call("/disconnect", manager, { route_id: cancelledID })).status).toBe(204);
  expect((await call("", manager, { ...route, route_id: cancelledID })).status).toBe(401);
  expect((await call("/challenge", "", { ...challenge, route_id: cancelledID })).status).toBe(401);
  expect((await call("", manager, route)).status).toBe(204);
  expect((await call("", manager, route)).status).toBe(204);
  expect((await call("", otherManager, { ...route, route_id: crypto.randomUUID() })).status).toBe(
    401,
  );

  expect((await call("/routes", manager, {})).status).toBe(401);
  expect(await (await call("/routes", admin, {})).json()).toEqual({
    routes: [{ x_user_id: user, route_id, event_types: ["mention", "reply"], dm_preview: false }],
  });
  const targets = await deliveryTargets(env);
  expect(targets).toHaveLength(2);
  const target = targets.find((candidate) => candidate.routeID === route_id);
  expect(target).toBeDefined();
  if (!target) throw new Error("Missing paired route");
  expect((await call("/test", otherManager, { route_id })).status).toBe(404);
  expect((await call("/test", manager, { route_id })).status).toBe(202);
  expect((await call("/test", manager, { route_id })).status).toBe(429);
  expect(relay.sent).toHaveLength(1);
  expect(relay.sent[0]).toMatchObject({
    authorization: `Bearer ${relayToken}`,
    body: { route_id },
  });

  expect((await call("/disconnect", otherManager, { route_id })).status).toBe(204);
  expect(await deliveryTargets(env)).toHaveLength(2);
  expect((await call("/disconnect", manager, { route_id })).status).toBe(204);
  expect((await call("/disconnect", manager, { route_id })).status).toBe(204);
  expect((await call("", manager, route)).status).toBe(401);
  expect(await deliveryTargets(env)).toHaveLength(1);

  let acknowledged = false;
  await handleXQueue(
    [
      {
        body: {
          relay_binding: await relayBinding(target.config, user, route_id),
          event: {
            event_id: `x2_${"E".repeat(43)}`,
            type: "mention",
            post_id: "123",
            route_id,
            occurred_at: new Date().toISOString(),
          },
        },
        attempts: 1,
        ack: () => {
          acknowledged = true;
        },
        retry: () => {
          throw new Error("Revoked route must not be retried");
        },
      },
    ],
    env,
    relay.deps,
  );
  expect(acknowledged).toBe(true);
  expect(relay.sent).toHaveLength(1);
});

test("pairing is opt-in, reports the settings version, and is disabled during a relay trial", async () => {
  const request = new Request("https://worker.test/v1/pairing");
  const { deps } = fakeRelay();
  expect((await handle(request, testEnv(), deps)).status).toBe(404);
  const enabled = await handle(request, testEnv({ PAIRING_ADMIN_TOKEN: admin }), deps);
  expect(enabled.status).toBe(200);
  expect(await enabled.json()).toEqual({ version: 2 });
  expect(
    (
      await handle(
        request,
        testEnv({ PAIRING_ADMIN_TOKEN: admin, PUBLIC_RELAY_TRIAL_UNTIL: "9999999999999" }),
        deps,
      )
    ).status,
  ).toBe(404);
});

test("a fresh Worker can have no manual routes when pairing is enabled", async () => {
  const env = testEnv({ PAIRING_ADMIN_TOKEN: admin });
  Reflect.deleteProperty(env, "X_USER_ID");
  Reflect.deleteProperty(env, "RELAY_TOKEN");
  expect(await deliveryTargets(env)).toEqual([]);
  env.X_USER_ID = user;
  await expect(deliveryTargets(env)).rejects.toThrow();
});

test("a paired route's owner can read and change its types, DM preview key, and relay credential", async () => {
  const relay = fakeRelay();
  const env = testEnv({ PAIRING_ADMIN_TOKEN: admin, ENABLE_X_ACTIVITY: "true" });
  const call = (suffix: string, token: string, body: unknown) =>
    handle(
      new Request(`https://worker.test/v1/pairing${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
      relay.deps,
    );
  const enc = new TextEncoder();
  const toHex = async (value: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const pair = async (x_user_id: string, management: string, relay_token: string) => {
    const issued = await call("/codes", admin, { x_user_id });
    const { code } = z.object({ code: z.string() }).parse(await issued.json());
    const route_id = crypto.randomUUID();
    const challenge = {
      lookup: await toHex(code),
      nonce: "a".repeat(64),
      route_id,
      management_hash: await toHex(management),
      x_user_id,
    };
    expect((await call("/challenge", management, challenge)).status).toBe(200);
    expect((await call("", management, { x_user_id, route_id, relay_token, code })).status).toBe(
      204,
    );
    return route_id;
  };
  const route_id = await pair(user, manager, relayToken);
  onTestFinished(() => call("/disconnect", manager, { route_id }).then(() => undefined));
  const otherRoute = await pair(otherUser, otherManager, `tsr_${"F".repeat(43)}`);
  onTestFinished(() =>
    call("/disconnect", otherManager, { route_id: otherRoute }).then(() => undefined),
  );
  const settings = async (body: Record<string, unknown>, token = manager) => {
    const response = await call("/settings", token, { route_id, ...body });
    return {
      status: response.status,
      body: response.status === 200 ? await response.json() : null,
    };
  };
  const paired = async () => {
    const target = (await deliveryTargets(env)).find((item) => item.routeID === route_id);
    if (!target) throw new Error("Missing paired route");
    return target;
  };

  expect(await settings({})).toEqual({
    status: 200,
    body: { event_types: ["mention", "reply"], dm_preview: false },
  });
  expect((await settings({}, otherManager)).status).toBe(404);
  expect((await call("/settings", manager, { route_id: otherRoute })).status).toBe(404);
  expect((await settings({ event_types: ["mention", "poll"] })).status).toBe(422);
  expect((await settings({ dm_preview_key: "short" })).status).toBe(422);
  expect((await settings({ relay_token: "tsr_short" })).status).toBe(422);
  expect((await settings({ x_user_id: otherUser })).status).toBe(422);

  expect(await settings({ event_types: ["mention", "like", "like", "dm"] })).toEqual({
    status: 200,
    body: { event_types: ["mention", "like", "dm"], dm_preview: false },
  });
  expect((await paired()).eventTypes).toEqual(["mention", "like", "dm"]);
  expect((await settings({ event_types: [] })).body).toEqual({
    event_types: [],
    dm_preview: false,
  });
  expect((await paired()).eventTypes).toEqual([]);

  const key = "A".repeat(43);
  expect((await settings({ dm_preview_key: key })).body).toEqual({
    event_types: [],
    dm_preview: true,
  });
  expect((await paired()).dmPreviewKey).toBe(key);
  expect(
    (await call("/settings", otherManager, { route_id: otherRoute, dm_preview_key: key })).status,
  ).toBe(409);
  expect((await settings({ dm_preview_key: null })).body).toEqual({
    event_types: [],
    dm_preview: false,
  });
  expect((await paired()).dmPreviewKey).toBeUndefined();

  const sameAccountToken = `tsr_${"H".repeat(43)}`;
  const sameAccountManager = `tpm_${"H".repeat(43)}`;
  const sameAccountRoute = await pair(user, sameAccountManager, sameAccountToken);
  onTestFinished(() =>
    call("/disconnect", sameAccountManager, { route_id: sameAccountRoute }).then(() => undefined),
  );
  expect((await settings({ relay_token: env.RELAY_TOKEN })).status).toBe(409);
  expect((await settings({ event_types: ["like"], relay_token: sameAccountToken })).status).toBe(
    409,
  );
  expect((await settings({})).body).toEqual({ event_types: [], dm_preview: false });

  const rotated = `tsr_${"G".repeat(43)}`;
  const before = await paired();
  expect((await settings({ relay_token: rotated })).status).toBe(200);
  expect((await paired()).config.token).toBe(rotated);
  let acknowledged = false;
  await handleXQueue(
    [
      {
        body: {
          relay_binding: await relayBinding(before.config, user, route_id),
          event: {
            event_id: `x2_${"E".repeat(43)}`,
            type: "mention",
            post_id: "123",
            route_id,
            occurred_at: new Date().toISOString(),
          },
        },
        attempts: 1,
        ack: () => {
          acknowledged = true;
        },
        retry: () => {
          throw new Error("A job bound to the replaced credential must not be retried");
        },
      },
    ],
    env,
    relay.deps,
  );
  expect(acknowledged).toBe(true);
  expect(relay.sent).toHaveLength(0);
  expect((await call("/test", manager, { route_id })).status).toBe(202);
  expect(relay.sent.at(-1)).toMatchObject({ authorization: `Bearer ${rotated}` });
});

test("a DM preview key that any other route also has is used by none of them", async () => {
  const env = testEnv({ PAIRING_ADMIN_TOKEN: admin, ENABLE_X_ACTIVITY: "true" });
  const { deps } = fakeRelay();
  const call = (suffix: string, token: string, body: unknown) =>
    handle(
      new Request(`https://worker.test/v1/pairing${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
  const enc = new TextEncoder();
  const toHex = async (value: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const issued = await call("/codes", admin, { x_user_id: user });
  const { code } = z.object({ code: z.string() }).parse(await issued.json());
  const route_id = crypto.randomUUID();
  await call("/challenge", "", {
    lookup: await toHex(code),
    nonce: "a".repeat(64),
    route_id,
    management_hash: await toHex(manager),
    x_user_id: user,
  });
  expect(
    (await call("", manager, { x_user_id: user, route_id, relay_token: relayToken, code })).status,
  ).toBe(204);
  onTestFinished(() => call("/disconnect", manager, { route_id }).then(() => undefined));
  const key = `${"K".repeat(42)}A`;
  expect((await call("/settings", manager, { route_id, dm_preview_key: key })).status).toBe(200);

  const manualRoute = crypto.randomUUID();
  const withManualKey = (...keys: string[]) =>
    testEnv({
      ...env,
      X_RELAY_ROUTES: JSON.stringify({
        [otherUser]: keys.map((dm_preview_key, index) => ({
          relay_token: `tsr_${String(index).repeat(43)}`,
          route_id: index === 0 ? manualRoute : crypto.randomUUID(),
          dm_preview_key,
        })),
      }),
    });
  const keys = async (target: Env) =>
    Object.fromEntries(
      (await deliveryTargets(target)).map((item) => [item.routeID, item.dmPreviewKey]),
    );

  expect((await keys(withManualKey(`${"M".repeat(42)}A`)))[route_id]).toBe(key);
  const shared = await keys(withManualKey(key));
  expect(shared[route_id]).toBeUndefined();
  expect(shared[manualRoute]).toBeUndefined();
  const duplicatedManually = await keys(withManualKey(key, key));
  expect(duplicatedManually[route_id]).toBeUndefined();
});

test("settings writes are limited per route, but reads, unchanged writes, and narrowing are free", async () => {
  const env = testEnv({ PAIRING_ADMIN_TOKEN: admin });
  const limitToken = `tsr_${"L".repeat(43)}`;
  const limitManager = `tpm_${"L".repeat(43)}`;
  const { deps } = fakeRelay();
  const call = (suffix: string, token: string, body: unknown) =>
    handle(
      new Request(`https://worker.test/v1/pairing${suffix}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
      env,
      deps,
    );
  const enc = new TextEncoder();
  const toHex = async (value: string) =>
    Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(value))), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
  const issued = await call("/codes", admin, { x_user_id: user });
  const { code } = z.object({ code: z.string() }).parse(await issued.json());
  const route_id = crypto.randomUUID();
  await call("/challenge", "", {
    lookup: await toHex(code),
    nonce: "a".repeat(64),
    route_id,
    management_hash: await toHex(limitManager),
    x_user_id: user,
  });
  expect(
    (await call("", limitManager, { x_user_id: user, route_id, relay_token: limitToken, code }))
      .status,
  ).toBe(204);
  onTestFinished(() => call("/disconnect", limitManager, { route_id }).then(() => undefined));
  const settings = (body: Record<string, unknown>) =>
    call("/settings", limitManager, { route_id, ...body });

  // 種類を入れ替える書き換えは、減らすだけの変更ではないので数える。
  for (let index = 0; index < 30; index += 1) {
    const event_types = index % 2 === 0 ? ["like"] : ["reply"];
    expect((await settings({ event_types })).status).toBe(200);
    expect((await settings({ event_types })).status).toBe(200);
    expect((await settings({})).status).toBe(200);
  }
  expect((await settings({ event_types: ["mention"] })).status).toBe(429);
  expect((await settings({ event_types: [], dm_preview_key: null })).status).toBe(200);
  expect(await (await settings({})).json()).toEqual({ event_types: [], dm_preview: false });
});

describe("applyRouteChanges", () => {
  const route: StoredRoute = {
    recipient: user,
    routeID: "00000000-0000-4000-a000-000000000001",
    token: relayToken,
    managementHash: "a".repeat(64),
  };
  const none = { tokens: [], dmPreviewKeys: [] };
  const key = `${"K".repeat(42)}A`;

  test("refuses a key that a manual route has, even when the manual routes repeat it", () => {
    expect(
      applyRouteChanges(
        route,
        [],
        { tokens: [], dmPreviewKeys: [key, key] },
        { dmPreviewKey: key },
        0,
      ),
    ).toEqual({ kind: "conflict" });
  });

  test("refuses a credential that a manual route of the same account has, but not another account's", () => {
    const token = `tsr_${"M".repeat(43)}`;
    expect(
      applyRouteChanges(
        route,
        [],
        { tokens: [{ recipient: user, token }], dmPreviewKeys: [] },
        { token },
        0,
      ),
    ).toEqual({ kind: "conflict" });
    expect(
      applyRouteChanges(
        route,
        [],
        { tokens: [{ recipient: otherUser, token }], dmPreviewKeys: [] },
        { token },
        0,
      ).kind,
    ).toBe("changed");
  });

  test("counts writes in a ten-minute window and starts again after it closes", () => {
    const limited: StoredRoute = { ...route, settingsWrites: 30, settingsWindowEndsAt: 600_000 };
    expect(applyRouteChanges(limited, [], none, { eventTypes: ["like"] }, 599_999)).toEqual({
      kind: "limited",
    });
    const reopened = applyRouteChanges(limited, [], none, { eventTypes: ["like"] }, 600_000);
    expect(reopened).toMatchObject({
      kind: "changed",
      route: { eventTypes: ["like"], settingsWrites: 1, settingsWindowEndsAt: 1_200_000 },
    });
    expect(
      applyRouteChanges(limited, [], none, { eventTypes: ["mention"], token: relayToken }, 599_999),
    ).toMatchObject({
      kind: "changed",
      route: { settingsWrites: 30, settingsWindowEndsAt: 600_000 },
    });
    const typed: StoredRoute = { ...limited, eventTypes: ["reply", "mention"] };
    expect(
      applyRouteChanges(typed, [], none, { eventTypes: ["reply", "mention", "reply"] }, 0),
    ).toEqual({ kind: "unchanged" });
  });
});
