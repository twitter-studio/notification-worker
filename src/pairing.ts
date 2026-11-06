import { z } from "zod";
import { readBody } from "./body";
import { RelayRouteID, relayEndpoint } from "./config";
import { pairingStore } from "./pairing-store";
import { type RelayDeps, sendToRelay } from "./relay";
import { XUserID } from "./x-activity";

const Account = z.strictObject({ x_user_id: XUserID });
const Connection = Account.extend({
  route_id: RelayRouteID,
  relay_token: z.string().regex(/^tsr_[A-Za-z0-9_-]{43}$/),
  code: z.string().regex(/^tpc_[A-Za-z0-9_-]{43}$/),
});
const Hex = z.string().regex(/^[a-f0-9]{64}$/);
const Challenge = Account.extend({
  route_id: RelayRouteID,
  lookup: Hex,
  nonce: Hex,
  management_hash: Hex,
});
const Route = z.strictObject({ route_id: RelayRouteID });

function response(status: number, data?: unknown) {
  const headers = { "Cache-Control": "no-store" };
  return data === undefined
    ? new Response(null, { status, headers })
    : Response.json(data, { status, headers });
}

function randomCode(): string {
  return `tpc_${btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "")}`;
}

const encoder = new TextEncoder();

function hex(value: ArrayBuffer) {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function hash(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function handlePairing(
  request: Request,
  path: string,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const store = pairingStore(env);
  if (!store) return response(404);
  if (path === "/v1/pairing" && request.method === "GET") return response(200, { version: 1 });
  if (request.method !== "POST") return response(405);
  const auth = request.headers.get("Authorization") ?? "";
  const issue = path === "/v1/pairing/codes";
  const listing = path === "/v1/pairing/routes";
  const admin = issue || listing || path === "/v1/pairing/revoke";
  const challenge = path === "/v1/pairing/challenge";
  if (
    !challenge &&
    (admin
      ? !/^Bearer tpa_[A-Za-z0-9_-]{43}$/.test(auth)
      : !/^Bearer tpm_[A-Za-z0-9_-]{43}$/.test(auth))
  )
    return response(401);
  if (admin) {
    if (
      !crypto.subtle.timingSafeEqual(
        encoder.encode(auth.slice(7)),
        encoder.encode(env.PAIRING_ADMIN_TOKEN),
      )
    )
      return response(401);
  }
  const body = await readBody(request, 1024);
  if (body === undefined) return response(413);
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return response(400);
  }
  if (challenge) {
    const parsed = Challenge.safeParse(json);
    if (!parsed.success) return response(422);
    const { lookup, x_user_id, route_id, nonce, management_hash } = parsed.data;
    const secret = await store.reserveCode(lookup, x_user_id, route_id, management_hash);
    if (secret === undefined) return response(401);
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const message = [
      "tweetbot-worker-pairing-v1",
      new URL(request.url).origin,
      x_user_id,
      route_id,
      management_hash,
      nonce,
    ].join("\n");
    return response(200, {
      proof: hex(await crypto.subtle.sign("HMAC", key, encoder.encode(message))),
    });
  }
  if (listing) {
    if (!z.strictObject({}).safeParse(json).success) return response(422);
    return response(200, { routes: await store.list() });
  }
  if (issue) {
    const parsed = Account.safeParse(json);
    if (!parsed.success) return response(422);
    const code = randomCode();
    const expires = Date.now() + 10 * 60_000;
    const [lookup, proofKey] = await Promise.all([
      hash(code),
      hash(`tweetbot-pairing-proof-key-v1\n${code}`),
    ]);
    if (!(await store.issue({ recipient: parsed.data.x_user_id, hash: lookup, proofKey, expires })))
      return response(429);
    return response(201, { code, expires_at: new Date(expires).toISOString() });
  }
  if (admin) {
    const parsed = Route.safeParse(json);
    if (!parsed.success) return response(422);
    await store.disconnect(parsed.data.route_id);
    return response(204);
  }
  const managementHash = await hash(auth.slice(7));
  if (path === "/v1/pairing") {
    const parsed = Connection.safeParse(json);
    if (!parsed.success) return response(422);
    const { x_user_id, route_id, relay_token, code } = parsed.data;
    const result = await store.registerRoute(await hash(code), {
      recipient: x_user_id,
      routeID: route_id,
      token: relay_token,
      managementHash,
    });
    return response(result === "connected" ? 204 : result === "invalid" ? 401 : 409);
  }
  const parsed = Route.safeParse(json);
  if (!parsed.success) return response(422);
  if (path === "/v1/pairing/disconnect") {
    await store.disconnect(parsed.data.route_id, managementHash);
    return response(204);
  }
  if (path !== "/v1/pairing/test") return response(404);
  const result = await store.reserveTest(parsed.data.route_id, managementHash);
  if (result.kind !== "ready") return response(result.kind === "limited" ? 429 : 404);
  const { route } = result;
  // 既存の中継 API の汎用通知文を使う。X のイベントや投稿へのリンクは作らない。
  const outcome = await sendToRelay(
    { endpoint: relayEndpoint(env.RELAY_URL), token: route.token },
    {
      event_id: `pairing_test_${crypto.randomUUID()}`,
      type: "follow",
      route_id: route.routeID,
      occurred_at: new Date().toISOString(),
    },
    deps,
    { remaining: 1 },
  );
  if (outcome.kind === "accepted") return response(202);
  return response(outcome.kind === "unauthorized" ? 424 : 503);
}
