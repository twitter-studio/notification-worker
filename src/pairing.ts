import { z } from "zod";
import { readBody } from "./body";
import { NotificationTypes, RelayRouteID, RelayToken, relayEndpoint } from "./config";
import { connectConfig } from "./connect-config";
import { DmPreviewKey } from "./dm-preview";
import type { X_NOTIFICATION_TYPES } from "./normalize";
import { pairingStore } from "./pairing-store";
import { type RelayDeps, sendToRelay } from "./relay";
import { XUserID } from "./x-activity";
import { releaseWorkerSubscriptions } from "./x-subscriptions";

type X_NOTIFICATION_TYPE = (typeof X_NOTIFICATION_TYPES)[number];

const Account = z.strictObject({ x_user_id: XUserID });
const Connection = Account.extend({
  route_id: RelayRouteID,
  relay_token: RelayToken,
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
// 読むための API を別に作らず、変える項目のない要求を読み取りにする。アプリは同じ呼び出しで、今の値を読んでから変えられる。
const Settings = Route.extend({
  event_types: NotificationTypes.optional(),
  dm_preview_key: DmPreviewKey.nullable().optional(),
  relay_token: RelayToken.optional(),
});

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

/**
 * 外す要求の中で、購読の片付けにかける時間。X が遅くても、アプリの要求を待たせない。残りは定期の処理が片付ける。
 */
const releaseInRequest = 20_000;

/**
 * アカウントの接続コード (10 分、使い切り) を出す。管理用トークンの経路と、X でログインした経路 (`/connect`) の両方から使う。
 * 同じアカウントに新しく出すと、前のコードは使えなくなる。X でログインして出したコードは、同じアプリが出し直したときだけ使えなくなる。
 */
export async function issuePairingCode(
  store: NonNullable<ReturnType<typeof pairingStore>>,
  recipient: string,
  binding?: { managementHash: string; eventTypes: X_NOTIFICATION_TYPE[] },
): Promise<{ code: string; expires: number } | undefined> {
  const code = randomCode();
  const expires = Date.now() + 10 * 60_000;
  const [lookup, proofKey] = await Promise.all([
    hash(code),
    hash(`tweetbot-pairing-proof-key-v1\n${code}`),
  ]);
  if (!(await store.issue({ recipient, hash: lookup, proofKey, expires, ...binding })))
    return undefined;
  return { code, expires };
}

export async function handlePairing(
  request: Request,
  path: string,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const store = pairingStore(env);
  if (!store) return response(404);
  // 版 2 で設定の API、版 3 で X でログインして接続する入口 (`/connect`) を足した。利用者が自分で置く Worker には
  // 古い版が残るので、アプリは呼ぶ前に版を確かめる。`x_login` は、その Worker で `/connect` を使えるか。
  if (path === "/v1/pairing" && request.method === "GET") {
    // `/setup` で用意した Webhook の ID を読めなければ、使えないものとして答える (版の確かめまで失敗させない)。
    const login = (await connectConfig(env, store).catch(() => undefined)) !== undefined;
    return response(200, {
      version: 3,
      dm_preview_setup: login,
      x_login: login,
      // 接続のログインの許可で、続けて DM 通知の本文を設定できる (`/connect` の `dm_preview`)。
      dm_preview_login: login,
    });
  }
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
    const issued = await issuePairingCode(store, parsed.data.x_user_id);
    if (!issued) return response(429);
    return response(201, { code: issued.code, expires_at: new Date(issued.expires).toISOString() });
  }
  if (admin) {
    const parsed = Route.safeParse(json);
    if (!parsed.success) return response(422);
    const released = await store.disconnect(parsed.data.route_id);
    if (released !== undefined)
      await releaseWorkerSubscriptions(env, store, released, deps, releaseInRequest).catch(
        () => undefined,
      );
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
  if (path === "/v1/pairing/settings") {
    const parsed = Settings.safeParse(json);
    if (!parsed.success) return response(422);
    const { route_id, event_types, dm_preview_key, relay_token } = parsed.data;
    const result = await store.updateRoute(route_id, managementHash, {
      ...(event_types === undefined ? {} : { eventTypes: event_types }),
      ...(dm_preview_key === undefined ? {} : { dmPreviewKey: dm_preview_key }),
      ...(relay_token === undefined ? {} : { token: relay_token }),
    });
    if (result.kind !== "updated")
      return response(result.kind === "missing" ? 404 : result.kind === "limited" ? 429 : 409);
    return response(200, result.settings);
  }
  const parsed = Route.safeParse(json);
  if (!parsed.success) return response(422);
  if (path === "/v1/pairing/disconnect") {
    const released = await store.disconnect(parsed.data.route_id, managementHash);
    // 購読を消せなくても、外すことは止めない (消せなかった ID は記録に残り、定期の処理でやり直す)。
    if (released !== undefined)
      await releaseWorkerSubscriptions(env, store, released, deps, releaseInRequest).catch(
        () => undefined,
      );
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
