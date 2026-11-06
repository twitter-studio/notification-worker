import { expect, test } from "vitest";
import { z } from "zod";
import { handle } from "../src/app";
import { deliveryTargets } from "../src/pairing-store";
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
    routes: [{ x_user_id: user, route_id }],
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

test("pairing is opt-in and disabled during a relay trial", async () => {
  const request = new Request("https://worker.test/v1/pairing");
  const { deps } = fakeRelay();
  expect((await handle(request, testEnv(), deps)).status).toBe(404);
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
