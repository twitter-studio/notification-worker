import { z } from "zod";
import { readBody } from "./body";
import { RelayRouteID } from "./config";
import {
  base64URL,
  cookieValue,
  hex,
  identify,
  Random,
  random,
  sha256,
  sourceKey,
} from "./connect";
import { connectConfig } from "./connect-config";
import { pairingStore } from "./pairing-store";
import type { RelayDeps } from "./relay";
import { XUserID } from "./x-activity";

const scopes = ["tweet.read", "users.read", "dm.read"];
const callback = "tweetbot-worker://dm-preview";
const browserCookie = "__Host-tweetbot-dm-preview";
const confirmCookie = "__Host-tweetbot-dm-confirm";
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const encoder = new TextEncoder();
const Start = z.strictObject({
  route_id: RelayRouteID,
  request_id: z.uuid(),
  app_state: z.string().regex(Random),
});
const Finish = Start.extend({ key: z.string().regex(/^[A-Za-z0-9+/]{43}=$/) });
type Base = {
  state: string;
  routeID: string;
  managementHash: string;
  recipient: string;
  requestID: string;
  appState: string;
  expires: number;
};
export type DMPreviewSession = Base &
  (
    | { kind: "prepared" }
    | { kind: "authorizing"; verifier: string; browserHash: string; redirectURI: string }
    | { kind: "authorized"; verifier: string; code: string; redirectURI: string }
  );

function reply(status: number, body?: unknown): Response {
  return body === undefined
    ? new Response(null, { status, headers })
    : Response.json(body, { status, headers });
}
function redirect(location: string, cookies: string[] = [], status = 302): Response {
  const response = new Response(null, { status, headers: { ...headers, Location: location } });
  for (const cookie of cookies) response.headers.append("Set-Cookie", cookie);
  return response;
}
function cookie(name: string, value: string, seconds = 600): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${name === confirmCookie ? "Strict" : "Lax"}; Max-Age=${seconds}`;
}

export async function handleDMPreview(
  request: Request,
  env: Env,
  deps: RelayDeps,
): Promise<Response> {
  const store = pairingStore(env);
  const config = await connectConfig(env, store);
  if (!store || !config) return reply(404);
  const url = new URL(request.url);
  if (
    !(
      await config.limiter.limit({
        key: `dm-preview:${sourceKey(request.headers.get("CF-Connecting-IP") ?? "unknown")}`,
      })
    ).success
  )
    return reply(429);
  if (url.pathname.startsWith("/v1/pairing/dm-preview/")) {
    if (
      !["start", "finish", "cancel"].some(
        (action) => url.pathname === `/v1/pairing/dm-preview/${action}`,
      )
    )
      return reply(404);
    if (request.method !== "POST") return reply(405);
    const auth = request.headers.get("Authorization") ?? "";
    if (!/^Bearer tpm_[A-Za-z0-9_-]{43}$/.test(auth)) return reply(401);
    const bytes = await readBody(request, 1024);
    if (!bytes) return reply(413);
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      return reply(400);
    }
    const parsed = (url.pathname.endsWith("/finish") ? Finish : Start).safeParse(json);
    if (!parsed.success) return reply(422);
    const managementHash = await hex(auth.slice(7));
    const value = parsed.data;
    const route = await store.dmPreviewRoute(value.route_id, managementHash);
    if (!route || !config.allowed.has(route.recipient)) return reply(404);
    if (url.pathname.endsWith("/start")) {
      const state = `dmp_${random()}`;
      const created = await store.beginDMPreview({
        state,
        kind: "prepared",
        routeID: value.route_id,
        managementHash,
        recipient: route.recipient,
        requestID: value.request_id,
        appState: value.app_state,
        expires: Date.now() + 600_000,
      });
      if (!created) return reply(429);
      return reply(201, { url: `${url.origin}/dm-preview?state=${state}` });
    }
    if (url.pathname.endsWith("/cancel")) {
      await store.takeDMPreview(value.route_id, managementHash, value.request_id, value.app_state);
      return reply(204);
    }
    if (!url.pathname.endsWith("/finish")) return reply(404);
    const input = Finish.parse(value);
    const session = await store.takeDMPreview(
      value.route_id,
      managementHash,
      value.request_id,
      value.app_state,
    );
    if (session?.kind !== "authorized") return reply(410);
    const user = await identify(
      session.code,
      session.redirectURI,
      session.verifier,
      scopes,
      config,
      deps,
    );
    if (!user || user.userID !== route.recipient) return reply(403);
    // トークン交換と本人照合の2回を含め、無料プランの外部要求50回の内側に収める。
    let remaining = 48;
    const bounded: RelayDeps = {
      ...deps,
      fetch: async (input, init) => {
        if (remaining <= 0) throw new Error("setup_unavailable");
        remaining -= 1;
        return deps.fetch(input, init);
      },
    };
    if (!(await store.dmPreviewRoute(value.route_id, managementHash))) return reply(410);
    const material = await collectMaterial(
      user.userID,
      user.accessToken,
      bounded,
      () => remaining >= 2,
    );
    if (!(await store.dmPreviewRoute(value.route_id, managementHash))) return reply(410);
    const keyBytes = Uint8Array.from(atob(input.key), (char) => char.charCodeAt(0));
    const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
    keyBytes.fill(0);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = encoder.encode(JSON.stringify(material));
    if (plaintext.length > 131044) {
      plaintext.fill(0);
      return reply(413);
    }
    try {
      const aad = encoder.encode(
        `twitter-studio/x-chat-setup/v1\n${route.recipient}\n${value.route_id.toLowerCase()}\n${value.request_id.toLowerCase()}`,
      );
      const encrypted = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad },
          key,
          plaintext,
        ),
      );
      const sealed = new Uint8Array(nonce.length + encrypted.length);
      sealed.set(nonce);
      sealed.set(encrypted, nonce.length);
      if (!(await store.dmPreviewRoute(value.route_id, managementHash))) return reply(410);
      return new Response(sealed, {
        headers: { ...headers, "Content-Type": "application/octet-stream" },
      });
    } finally {
      plaintext.fill(0);
    }
  }
  if (url.pathname === "/oauth/callback") {
    if (request.method !== "GET") return reply(405);
    const session = await store.readDMPreview(url.searchParams.get("state") ?? "");
    if (session?.kind !== "authorizing") return reply(400);
    const browser = cookieValue(request, browserCookie);
    if (!browser || (await hex(browser)) !== session.browserHash) return reply(400);
    const code = url.searchParams.get("code");
    const error = url.searchParams.has("error") || !code || code.length > 512;
    if (error)
      await store.takeDMPreview(
        session.routeID,
        session.managementHash,
        session.requestID,
        session.appState,
      );
    else if (!(await store.authorizeDMPreview(session.state, code))) return reply(410);
    return redirect(
      `${callback}?${new URLSearchParams({ state: session.appState, ...(error ? { error: "denied" } : {}) })}`,
      [cookie(browserCookie, "", 0)],
    );
  }
  if (url.pathname !== "/dm-preview" || !["GET", "POST"].includes(request.method))
    return reply(404);
  const session = await store.readDMPreview(url.searchParams.get("state") ?? "");
  if (session?.kind !== "prepared" || !config.allowed.has(session.recipient)) return reply(410);
  if (request.method === "GET") {
    const nonce = random();
    const ja = /^ja\b/i.test(request.headers.get("Accept-Language") ?? "");
    const title = ja ? "DM通知で本文を表示" : "Show Message Text in DM Notifications";
    const message = ja
      ? "Twitterで読み取りを許可し、この端末でDM通知の本文を表示します。PINはTweetbot内で入力します。"
      : "Allow Twitter read access to show DM message text on this device. Enter your passcode only in Tweetbot.";
    const response = new Response(
      `<!doctype html><html lang="${ja ? "ja" : "en"}"><meta name="viewport" content="width=device-width"><title>${title}</title><h1>${title}</h1><p>${message}</p><form method="post"><input type="hidden" name="confirm" value="${nonce}"><button>${ja ? "続ける" : "Continue"}</button></form></html>`,
      {
        headers: {
          ...headers,
          "Referrer-Policy": "same-origin",
          "Content-Type": "text/html; charset=utf-8",
          "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
          "X-Frame-Options": "DENY",
        },
      },
    );
    response.headers.append("Set-Cookie", cookie(confirmCookie, nonce));
    return response;
  }
  const origin = request.headers.get("Origin");
  if (
    (origin !== null && origin !== "null" && origin !== url.origin) ||
    !/^application\/x-www-form-urlencoded\b/i.test(request.headers.get("Content-Type") ?? "")
  )
    return reply(403);
  const body = await readBody(request, 256);
  if (!body) return reply(413);
  const form = new URLSearchParams(new TextDecoder().decode(body));
  const nonce = cookieValue(request, confirmCookie);
  if (!nonce || form.getAll("confirm").length !== 1 || form.get("confirm") !== nonce)
    return reply(403);
  const browser = random();
  const verifier = random();
  const redirectURI = `${url.origin}/oauth/callback`;
  if (
    !(await store.startDMPreview(session.state, {
      verifier,
      browserHash: await hex(browser),
      redirectURI,
    }))
  )
    return reply(410);
  const authorize = new URL("https://x.com/i/oauth2/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: config.clientID,
    redirect_uri: redirectURI,
    scope: scopes.join(" "),
    state: session.state,
    code_challenge: base64URL(await sha256(verifier)),
    code_challenge_method: "S256",
  }).toString();
  return redirect(
    authorize.href,
    [cookie(browserCookie, browser), cookie(confirmCookie, "", 0)],
    303,
  );
}

const KeyRecord = z.object({
  public_key_version: z.string().regex(/^[0-9]{1,20}$/),
  public_key: z.string().min(1).max(1024),
  signing_public_key: z.string().min(1).max(1024),
  identity_public_key_signature: z.string().min(1).max(1024),
  juicebox_config: z
    .object({ key_store_token_map_json: z.string().min(1).max(65536) })
    .passthrough()
    .optional(),
});
const Keys = z.object({ data: z.union([KeyRecord, z.array(KeyRecord).min(1).max(100)]) });
const Conversations = z.object({
  meta: z
    .object({
      next_token: z.string().min(1).max(2048).optional(),
      has_more: z.boolean().optional(),
    })
    .optional(),
  data: z
    .array(
      z.object({
        id: z.string().regex(/^[0-9:-]{1,64}$/),
        participant_ids: z.array(XUserID).length(2),
      }),
    )
    .max(20)
    .default([]),
});
const History = z.object({
  meta: z
    .object({
      conversation_key_events: z
        .array(z.string().regex(/^[A-Za-z0-9+/]{1,16384}={0,2}$/))
        .max(100)
        .default([]),
    })
    .default({ conversation_key_events: [] }),
});

async function collectMaterial(
  owner: string,
  token: string,
  deps: RelayDeps,
  canReadConversation: () => boolean,
) {
  const deadline = Date.now() + 40_000;
  async function get(path: string, query: Record<string, string>) {
    if (deadline <= Date.now()) throw new Error("setup_unavailable");
    const url = new URL(path, "https://api.x.com");
    url.search = new URLSearchParams(query).toString();
    const response = await deps.fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
    });
    const bytes = await readBody(response, 131072);
    if (response.status !== 200 || !bytes) throw new Error("setup_unavailable");
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    const error = z.object({ errors: z.array(z.unknown()).optional() }).parse(value);
    if (error.errors?.length) throw new Error("setup_unavailable");
    return value;
  }
  const fields = "public_key_version,public_key,signing_public_key,identity_public_key_signature";
  async function keys(user: string, recovery = false) {
    const result = Keys.parse(
      await get(`/2/users/${user}/public_keys`, {
        "public_key.fields": fields + (recovery ? ",juicebox_config" : ""),
      }),
    ).data;
    return Array.isArray(result) ? result : [result];
  }
  const ownKeys = await keys(owner, true);
  const recoverable = ownKeys
    .filter((key) => key.juicebox_config !== undefined)
    .sort((a, b) => (BigInt(a.public_key_version) > BigInt(b.public_key_version) ? -1 : 1))[0];
  if (!recoverable?.juicebox_config) throw new Error("setup_unavailable");
  const conversations: z.infer<typeof Conversations>["data"] = [];
  const seen = new Set<string>();
  let pagination: string | undefined;
  for (let page = 0; page < 5 && conversations.length < 20; page += 1) {
    const result = Conversations.parse(
      await get("/2/chat/conversations", {
        max_results: "20",
        type: "direct",
        expansions: "participant_ids",
        "chat_conversation.fields": "id,type",
        ...(pagination === undefined ? {} : { pagination_token: pagination }),
      }),
    );
    for (const conversation of result.data) {
      if (!seen.has(conversation.id) && conversations.length < 20) {
        seen.add(conversation.id);
        conversations.push(conversation);
      }
    }
    const next = result.meta?.next_token;
    if (!next || result.meta?.has_more === false) break;
    if (next === pagination) throw new Error("setup_unavailable");
    pagination = next;
  }
  const records = new Map([[owner, ownKeys]]);
  const rotations: Record<string, string[]> = {};
  for (const conversation of conversations) {
    if (!canReadConversation()) break;
    if (!conversation.participant_ids.includes(owner)) throw new Error("setup_unavailable");
    const peer = conversation.participant_ids.find((id) => id !== owner);
    if (!peer) continue;
    const history = History.parse(
      await get(`/2/chat/conversations/${peer}/events`, {
        max_results: "1",
        "chat_message_event.fields": "conversation_key_version",
      }),
    );
    if (!history.meta.conversation_key_events.length) continue;
    if (!records.has(peer)) records.set(peer, await keys(peer));
    const members = [owner, peer].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
    rotations[members.join(":")] = history.meta.conversation_key_events.slice(0, 4);
  }
  const signingKeys = [...records].flatMap(([userID, rows]) =>
    rows.map((row) => ({
      userID,
      publicKeyVersion: row.public_key_version,
      publicKey: row.signing_public_key,
      identityPublicKey: row.public_key,
      identityPublicKeySignature: row.identity_public_key_signature,
    })),
  );
  if (!Object.keys(rotations).length || signingKeys.length > 100)
    throw new Error("setup_unavailable");
  return {
    userID: owner,
    identityKeyVersion: recoverable.public_key_version,
    identityPublicKey: recoverable.public_key,
    signingPublicKey: recoverable.signing_public_key,
    recoveryConfiguration: btoa(
      Array.from(encoder.encode(JSON.stringify(recoverable.juicebox_config)), (byte) =>
        String.fromCharCode(byte),
      ).join(""),
    ),
    signingKeys,
    keyChangesByConversation: rotations,
  };
}
