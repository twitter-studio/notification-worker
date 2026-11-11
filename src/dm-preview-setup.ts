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
        if (remaining <= 0) throw new SetupFailure("budget");
        remaining -= 1;
        return deps.fetch(input, init);
      },
    };
    if (!(await store.dmPreviewRoute(value.route_id, managementHash))) return reply(410);
    let collected: Awaited<ReturnType<typeof collectMaterial>>;
    try {
      collected = await collectMaterial(
        user.userID,
        user.accessToken,
        bounded,
        () => remaining >= 2,
      );
    } catch (error) {
      // どこで読めなかったかを残す。値、ID、トークン、本文は出さない (#71)。
      console.error(
        JSON.stringify({ event: "dm_preview_setup", outcome: "failed", ...describeFailure(error) }),
      );
      return reply(503);
    }
    const { material } = collected;
    console.info(
      JSON.stringify({
        event: "dm_preview_setup",
        outcome: "prepared",
        conversation_count: collected.conversationCount,
        skipped: collected.skipped,
      }),
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
type KeyRecord = z.infer<typeof KeyRecord>;
// 記録は 1 件ずつ確かめる。1 件の形が合わないだけで、ほかの鍵まで捨てないため (#71)。
const Keys = z.object({
  data: z.union([z.array(z.unknown()).max(100), z.record(z.string(), z.unknown())]),
});
const Conversations = z.object({
  meta: z
    .object({
      next_token: z.string().min(1).max(2048).optional(),
      has_more: z.boolean().optional(),
    })
    .optional(),
  data: z.array(z.unknown()).max(1000).default([]),
});
// 相手は participant_ids か会話の ID (`A-B`) から決める。participant_ids に本人が入るか、いつも入るかを
// X の文書は書いていないので、どちらかが欠けていても読めるようにする (#71)。
const Conversation = z.object({
  id: z.string().max(64).optional(),
  participant_ids: z.array(XUserID).min(1).max(2).optional(),
});
const RotationEvent = z.string().regex(/^[A-Za-z0-9+/]{1,16384}={0,2}$/);
const History = z.object({
  meta: z
    .object({ conversation_key_events: z.array(z.unknown()).max(100).default([]) })
    .default({ conversation_key_events: [] }),
});

/** 鍵の材料を読めなかった段階。ログには段階の名前、HTTP の状態、X の problem の種類、形のずれた項目の名前だけを出す。 */
type Stage = "own_keys" | "conversations" | "conversation_events" | "peer_keys";
type Detail = {
  status?: number;
  problem?: string;
  issues?: string[];
  skipped?: Record<string, number>;
};
class SetupFailure extends Error {
  constructor(
    readonly stage: Stage | "no_recovery_key" | "no_key_changes" | "deadline" | "budget",
    readonly detail: Detail = {},
  ) {
    super("setup_unavailable");
  }
}

/** zod の失敗を、値を含まない項目の名前と種類にする (配列の位置は `#` にまとめる)。 */
function issueNames(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map(
        (issue) =>
          `${issue.path.map((part) => (typeof part === "number" ? "#" : String(part))).join(".")}:${issue.code}`,
      ),
    ),
  ].slice(0, 5);
}

/** X の problem の `type` の末尾 (`…/problems/not-authorized-for-resource` など) だけを取る。 */
function problemName(errors: unknown[]): string {
  const first = errors[0];
  const type =
    typeof first === "object" && first !== null && "type" in first ? first.type : undefined;
  const name = typeof type === "string" ? type.split("/").pop() : undefined;
  return name && /^[a-z][a-z-]{0,63}$/.test(name) ? name : "x_error";
}

/** 失敗をログの欄にする。段階の分からない例外は、名前だけを出す。 */
function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof SetupFailure) return { stage: error.stage, ...error.detail };
  const name = error instanceof Error ? error.name : "unknown";
  return { stage: "unexpected", problem: /^[A-Za-z]{1,64}$/.test(name) ? name : "unknown" };
}

export async function collectMaterial(
  owner: string,
  token: string,
  deps: RelayDeps,
  canReadConversation: () => boolean,
  deadline = Date.now() + 40_000,
) {
  async function get(stage: Stage, path: string, query: Record<string, string>) {
    if (deadline <= Date.now()) throw new SetupFailure("deadline");
    const url = new URL(path, "https://api.x.com");
    url.search = new URLSearchParams(query).toString();
    let response: Response;
    try {
      response = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
      });
    } catch (error) {
      if (error instanceof SetupFailure) throw error;
      throw new SetupFailure(stage, { problem: describeFailure(error).problem as string });
    }
    const bytes = await readBody(response, 131072);
    if (response.status !== 200) throw new SetupFailure(stage, { status: response.status });
    if (!bytes) throw new SetupFailure(stage, { status: 200, problem: "unreadable_body" });
    let value: unknown;
    try {
      value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
    } catch {
      throw new SetupFailure(stage, { status: 200, problem: "invalid_json" });
    }
    if (typeof value !== "object" || value === null)
      throw new SetupFailure(stage, { status: 200, problem: "invalid_json" });
    // data があれば、展開した相手を引けないときなどの部分的な errors では止めない (#71)。
    const errors = "errors" in value && Array.isArray(value.errors) ? value.errors : [];
    if (errors.length && !("data" in value) && !("meta" in value))
      throw new SetupFailure(stage, { status: 200, problem: problemName(errors) });
    return value;
  }
  function parse<T extends z.ZodType>(stage: Stage, schema: T, value: unknown): z.infer<T> {
    const result = schema.safeParse(value);
    if (!result.success) throw new SetupFailure(stage, { issues: issueNames(result.error) });
    return result.data;
  }
  const fields = "public_key_version,public_key,signing_public_key,identity_public_key_signature";
  async function keys(stage: Stage, user: string, recovery = false): Promise<KeyRecord[]> {
    const { data } = parse(
      stage,
      Keys,
      await get(stage, `/2/users/${user}/public_keys`, {
        "public_key.fields": fields + (recovery ? ",juicebox_config" : ""),
      }),
    );
    return (Array.isArray(data) ? data : [data]).flatMap((row) => {
      const record = KeyRecord.safeParse(row);
      return record.success ? [record.data] : [];
    });
  }
  /** 1 対 1 の会話の相手。participant_ids と会話の ID の両方があれば、食い違わないものだけを使う。 */
  function peerOf(row: unknown): string | undefined {
    const conversation = Conversation.safeParse(row);
    if (!conversation.success) return undefined;
    const { id, participant_ids: participants } = conversation.data;
    const fromParticipants = participants?.filter((participant) => participant !== owner);
    if (
      participants &&
      (fromParticipants?.length !== 1 || participants.length !== new Set(participants).size)
    )
      return undefined;
    const members = /^([0-9]{1,19})-([0-9]{1,19})$/.exec(id ?? "")?.slice(1);
    const fromID =
      members?.includes(owner) && members[0] !== members[1]
        ? members.find((member) => member !== owner)
        : undefined;
    const peer = fromParticipants?.[0] ?? fromID;
    if (!peer || (fromID && fromID !== peer) || !XUserID.safeParse(peer).success) return undefined;
    return peer;
  }

  const ownKeys = await keys("own_keys", owner, true);
  const recoverable = ownKeys
    .filter((key) => key.juicebox_config !== undefined)
    .sort((a, b) => (BigInt(a.public_key_version) > BigInt(b.public_key_version) ? -1 : 1))[0];
  if (!recoverable?.juicebox_config) throw new SetupFailure("no_recovery_key");

  /** 飛ばした会話の数を、理由ごとに数える (ログに出す)。 */
  const skipped: Record<string, number> = {};
  const skip = (reason: string) => {
    skipped[reason] = (skipped[reason] ?? 0) + 1;
  };
  const reason = (error: SetupFailure) =>
    `${error.stage}:${error.detail.status ?? error.detail.problem ?? error.detail.issues?.[0] ?? "failed"}`;

  const peers: string[] = [];
  let pagination: string | undefined;
  for (let page = 0; page < 5 && peers.length < 20; page += 1) {
    const result = parse(
      "conversations",
      Conversations,
      await get("conversations", "/2/chat/conversations", {
        max_results: "20",
        type: "direct",
        expansions: "participant_ids",
        "chat_conversation.fields": "id,type",
        ...(pagination === undefined ? {} : { pagination_token: pagination }),
      }),
    );
    for (const row of result.data) {
      const peer = peerOf(row);
      if (!peer) skip("conversation_shape");
      else if (!peers.includes(peer) && peers.length < 20) peers.push(peer);
    }
    const next = result.meta?.next_token;
    if (!next || result.meta?.has_more === false) break;
    if (next === pagination) throw new SetupFailure("conversations", { problem: "repeated_page" });
    pagination = next;
  }

  const records = new Map([[owner, ownKeys]]);
  let signingKeyCount = ownKeys.length;
  const rotations: Record<string, string[]> = {};
  for (const peer of peers) {
    if (!canReadConversation() || deadline <= Date.now()) {
      skip(deadline <= Date.now() ? "deadline" : "budget");
      continue;
    }
    try {
      const history = parse(
        "conversation_events",
        History,
        await get("conversation_events", `/2/chat/conversations/${peer}/events`, {
          max_results: "1",
          "chat_message_event.fields": "conversation_key_version",
        }),
      );
      const events = history.meta.conversation_key_events.flatMap((event) =>
        RotationEvent.safeParse(event).success ? [event as string] : [],
      );
      if (!events.length) {
        skip("no_key_change");
        continue;
      }
      if (!records.has(peer)) {
        const peerKeys = await keys("peer_keys", peer);
        if (!peerKeys.length) {
          skip("peer_keys:none");
          continue;
        }
        // アプリが保存する署名鍵は 100 件まで。超える会話は飛ばし、ほかの会話を残す。
        if (signingKeyCount + peerKeys.length > 100) {
          skip("signing_key_limit");
          continue;
        }
        records.set(peer, peerKeys);
        signingKeyCount += peerKeys.length;
      }
      const members = [owner, peer].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      rotations[members.join(":")] = events.slice(0, 4);
    } catch (error) {
      // 1 つの会話を読めなくても、ほかの会話の本文は出せるので続ける。回数や時間の上限は、残りも読めない。
      if (!(error instanceof SetupFailure)) throw error;
      skip(error.stage === "deadline" || error.stage === "budget" ? error.stage : reason(error));
    }
  }
  if (!Object.keys(rotations).length) throw new SetupFailure("no_key_changes", { skipped });
  const signingKeys = [...records].flatMap(([userID, rows]) =>
    rows.map((row) => ({
      userID,
      publicKeyVersion: row.public_key_version,
      publicKey: row.signing_public_key,
      identityPublicKey: row.public_key,
      identityPublicKeySignature: row.identity_public_key_signature,
    })),
  );
  if (signingKeys.length > 100)
    throw new SetupFailure("own_keys", { problem: "signing_key_limit" });
  return {
    material: {
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
    },
    conversationCount: Object.keys(rotations).length,
    skipped,
  };
}
