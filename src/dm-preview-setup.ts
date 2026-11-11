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
    // どこで読めなかったか、何を飛ばしたかを、結果が決まってから 1 行残す。値、ID、トークン、本文は出さない (#71)。
    const log = (outcome: string, fields: Record<string, unknown>) =>
      (outcome === "prepared" ? console.info : console.error)(
        JSON.stringify({ event: "dm_preview_setup", outcome, ...fields }),
      );
    try {
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
      if (!(await store.dmPreviewRoute(value.route_id, managementHash))) {
        log("route_gone", {});
        return reply(410);
      }
      let collected: Awaited<ReturnType<typeof collectMaterial>>;
      try {
        collected = await collectMaterial(
          user.userID,
          user.accessToken,
          bounded,
          () => remaining >= 2,
        );
      } catch (error) {
        log("failed", describeFailure(error));
        return reply(503);
      }
      const { material, summary } = collected;
      if (!(await store.dmPreviewRoute(value.route_id, managementHash))) {
        log("route_gone", summary);
        return reply(410);
      }
      const keyBytes = Uint8Array.from(atob(input.key), (char) => char.charCodeAt(0));
      const key = await crypto.subtle.importKey("raw", keyBytes, "AES-GCM", false, ["encrypt"]);
      keyBytes.fill(0);
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const plaintext = encoder.encode(JSON.stringify(material));
      if (plaintext.length > materialLimit) {
        plaintext.fill(0);
        log("too_large", summary);
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
        if (!(await store.dmPreviewRoute(value.route_id, managementHash))) {
          log("route_gone", summary);
          return reply(410);
        }
        log("prepared", summary);
        return new Response(sealed, {
          headers: { ...headers, "Content-Type": "application/octet-stream" },
        });
      } finally {
        plaintext.fill(0);
      }
    } catch (error) {
      // 材料を集める処理の外 (Durable Object の呼び出し、暗号化) の失敗も、段階の分からない 503 にしない。
      log("failed", { stage: "unexpected", problem: errorName(error) });
      return reply(503);
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

/** アプリが受け取る材料の上限 (128KiB から nonce と tag を引いた大きさ)。 */
const materialLimit = 131044;
const Version = z.object({ public_key_version: z.string().regex(/^[0-9]{1,20}$/) });
// 署名鍵は 4 つの項目だけで確かめる。juicebox_config は本人の復旧鍵を選ぶときだけ見る
// (X の文書は中身を定めていないので、ほかの形でも署名鍵まで捨てない。#71)。
const SigningRecord = Version.extend({
  public_key: z.string().min(1).max(1024),
  signing_public_key: z.string().min(1).max(1024),
  identity_public_key_signature: z.string().min(1).max(1024),
});
type SigningRecord = z.infer<typeof SigningRecord>;
const JuiceboxConfig = z
  .object({ key_store_token_map_json: z.string().min(1).max(65536) })
  .passthrough();
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
// X の文書は書いていないので、項目ごとに確かめ、片方が欠けていても読めるようにする (#71)。
const ConversationID = z.object({ id: z.string().max(64) });
const ConversationType = z.object({ type: z.string().max(32) });
const Participants = z.object({ participant_ids: z.array(XUserID).max(2) });
// アプリは 1 件 16384 バイトまでしか受けない。
const RotationEvent = z
  .string()
  .max(16384)
  .regex(/^[A-Za-z0-9+/]{1,16384}={0,2}$/);
const History = z.object({
  meta: z
    .object({ conversation_key_events: z.array(z.unknown()).max(100).default([]) })
    .default({ conversation_key_events: [] }),
});

/** 鍵の材料を読めなかった段階。ログには段階の名前、HTTP の状態、X の problem の種類、形のずれた項目の名前だけを出す。 */
type Stage = "own_keys" | "conversations" | "conversation_events" | "peer_keys";
type Counts = Record<string, number>;
type Detail = {
  status?: number;
  problem?: string;
  issues?: string[];
  during?: Stage;
  skipped?: Counts;
  partial?: Counts;
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
function problemName(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const errors = "errors" in value && Array.isArray(value.errors) ? value.errors : [];
  const problem: unknown = "type" in value ? value : errors[0];
  const type =
    typeof problem === "object" && problem !== null && "type" in problem ? problem.type : undefined;
  const name = typeof type === "string" ? type.split("/").pop() : undefined;
  return name && /^[a-z][a-z-]{0,63}$/.test(name) ? name : undefined;
}

/** 例外の名前 (`TimeoutError` など)。外から来た文字列は出さない。 */
function errorName(error: unknown): string {
  const name = error instanceof Error ? error.name : "unknown";
  return /^[A-Za-z]{1,64}$/.test(name) ? name : "unknown";
}

/** 失敗をログの欄にする。段階の分からない例外は、名前だけを出す。 */
function describeFailure(error: unknown): Record<string, unknown> {
  if (error instanceof SetupFailure) return { stage: error.stage, ...error.detail };
  return { stage: "unexpected", problem: errorName(error) };
}

/** 飛ばした理由のキー。締め切りと回数の上限は、段階を問わず同じキーで数える。 */
function failureReason(error: SetupFailure): string {
  if (error.stage === "deadline" || error.stage === "budget") return error.stage;
  const { status, problem, issues } = error.detail;
  return [error.stage, status, problem ?? issues?.[0]]
    .filter((part) => part !== undefined)
    .join(":");
}

async function collectMaterial(
  owner: string,
  token: string,
  deps: RelayDeps,
  canReadConversation: () => boolean,
) {
  const deadline = Date.now() + 40_000;
  /** 飛ばした会話や記録の数と、data と一緒に届いた部分的な errors の数を、理由ごとに数える (ログに出す)。 */
  const skipped: Counts = {};
  const partial: Counts = {};
  const count = (counts: Counts, key: string, by = 1) => {
    counts[key] = (counts[key] ?? 0) + by;
  };
  const counts = () => ({
    ...(Object.keys(skipped).length ? { skipped } : {}),
    ...(Object.keys(partial).length ? { partial } : {}),
  });

  /**
   * X の API を 1 回呼ぶ。`errors` が付いた応答は、`keep` の中身が空でないときだけ部分的な失敗として通す
   * (展開した相手を引けないときなど。#71)。`never` は errors があれば止める。
   */
  async function get(
    stage: Stage,
    path: string,
    query: Record<string, string>,
    keep: "data" | "events" | "never",
  ): Promise<object> {
    if (deadline <= Date.now()) throw new SetupFailure("deadline", { during: stage });
    const url = new URL(path, "https://api.x.com");
    url.search = new URLSearchParams(query).toString();
    let status: number;
    let bytes: Uint8Array | undefined;
    try {
      const response = await deps.fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        redirect: "manual",
        signal: AbortSignal.timeout(Math.min(10_000, deadline - Date.now())),
      });
      status = response.status;
      bytes = await readBody(response, 131072);
    } catch (error) {
      if (error instanceof SetupFailure) throw new SetupFailure(error.stage, { during: stage });
      // 全体の締め切りの残りで切れたものは、その API の時間切れと区別して残す。
      if (deadline <= Date.now()) throw new SetupFailure("deadline", { during: stage });
      throw new SetupFailure(stage, { problem: errorName(error) });
    }
    let value: unknown;
    try {
      value = bytes
        ? JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes))
        : undefined;
    } catch {
      value = undefined;
    }
    const problem = problemName(value);
    if (status !== 200) throw new SetupFailure(stage, { status, ...(problem ? { problem } : {}) });
    if (!bytes) throw new SetupFailure(stage, { status, problem: "unreadable_body" });
    if (typeof value !== "object" || value === null || Array.isArray(value))
      throw new SetupFailure(stage, { status, problem: "invalid_json" });
    // errors が配列でない形なら、エラーがないとはみなさない (本人の鍵の never をすり抜けないため)。
    const listed = "errors" in value ? value.errors : undefined;
    if (listed != null && !Array.isArray(listed))
      throw new SetupFailure(stage, { status, problem: "invalid_errors" });
    const errors: unknown[] = Array.isArray(listed) ? listed : [];
    if (errors.length) {
      // 公開鍵の data は、記録 1 件のオブジェクトで返ることもある。
      const filled = (content: unknown) =>
        Array.isArray(content)
          ? content.length > 0
          : typeof content === "object" && content !== null && Object.keys(content).length > 0;
      const { data, meta } = value as {
        data?: unknown;
        meta?: { conversation_key_events?: unknown };
      };
      const kept =
        keep === "data"
          ? filled(data)
          : keep === "events" && (filled(data) || filled(meta?.conversation_key_events));
      if (!kept) throw new SetupFailure(stage, { status, problem: problem ?? "x_error" });
      count(partial, `${stage}:${problem ?? "x_error"}`);
    }
    return value;
  }
  function parse<T extends z.ZodType>(stage: Stage, schema: T, value: unknown): z.infer<T> {
    const result = schema.safeParse(value);
    if (!result.success) throw new SetupFailure(stage, { issues: issueNames(result.error) });
    return result.data;
  }
  const fields = "public_key_version,public_key,signing_public_key,identity_public_key_signature";
  async function keys(stage: Stage, user: string, recovery = false) {
    const { data } = parse(
      stage,
      Keys,
      await get(
        stage,
        `/2/users/${user}/public_keys`,
        { "public_key.fields": fields + (recovery ? ",juicebox_config" : "") },
        // 本人の鍵は、引けなかった記録が新しい版かもしれないので、部分的な errors でも止める。
        recovery ? "never" : "data",
      ),
    );
    const rows = (Array.isArray(data) ? data : [data]).map((row) => ({
      row,
      record: SigningRecord.safeParse(row),
    }));
    const dropped = rows.filter(({ record }) => !record.success).map(({ row }) => row);
    if (dropped.length) count(skipped, `${stage}:invalid_record`, dropped.length);
    return {
      records: rows.flatMap(({ row, record }) =>
        record.success ? [{ row, record: record.data }] : [],
      ),
      dropped,
    };
  }
  /** 1 対 1 の会話の相手。participant_ids と会話の ID の両方があれば、食い違わないものだけを使う。 */
  function peerOf(row: unknown): string | undefined {
    // 項目があるのに読めない行は、グループかどうかを決められないので飛ばす。
    if (typeof row !== "object" || row === null) return undefined;
    if ("type" in row) {
      const type = ConversationType.safeParse(row);
      if (!type.success || type.data.type.toLowerCase() !== "direct") return undefined;
    }
    let fromID: string | undefined;
    if ("id" in row) {
      const id = ConversationID.safeParse(row);
      if (!id.success || id.data.id.startsWith("g")) return undefined;
      const members = /^([0-9]{1,19})-([0-9]{1,19})$/.exec(id.data.id)?.slice(1);
      if (members) {
        if (!members.includes(owner) || members[0] === members[1]) return undefined;
        fromID = members.find((member) => member !== owner);
      } else if (!/^[0-9]{1,19}$/.test(id.data.id)) {
        // 会話イベントの文書が認める形 (数字、`A-B`、`g` で始まる) のどれでもない ID は読めないものとして飛ばす。
        // 数字だけの ID は、何を指すかを文書が書いていないので、participant_ids で決める。
        return undefined;
      }
    }
    let fromParticipants: string | undefined;
    const listed = Participants.safeParse(row);
    if ("participant_ids" in row && !listed.success) return undefined;
    if (listed.success && listed.data.participant_ids.length) {
      const ids = listed.data.participant_ids;
      const others = ids.filter((participant) => participant !== owner);
      if (others.length !== 1 || new Set(ids).size !== ids.length) return undefined;
      fromParticipants = others[0];
    }
    const peer = fromParticipants ?? fromID;
    if (!peer || (fromID && fromID !== peer) || !XUserID.safeParse(peer).success) return undefined;
    return peer;
  }
  const signer = (userID: string, row: SigningRecord) => ({
    userID,
    publicKeyVersion: row.public_key_version,
    publicKey: row.signing_public_key,
    identityPublicKey: row.public_key,
    identityPublicKeySignature: row.identity_public_key_signature,
  });
  const bytesOf = (value: unknown) => encoder.encode(JSON.stringify(value)).length;

  async function run() {
    const own = await keys("own_keys", owner, true);
    const recoverable = own.records
      .flatMap(({ row, record }) => {
        const config =
          typeof row === "object" && row !== null && "juicebox_config" in row
            ? JuiceboxConfig.safeParse(row.juicebox_config)
            : undefined;
        return config?.success ? [{ record, config: config.data }] : [];
      })
      .sort((a, b) =>
        BigInt(a.record.public_key_version) > BigInt(b.record.public_key_version) ? -1 : 1,
      )[0];
    if (!recoverable) throw new SetupFailure("no_recovery_key");
    // 選んだ鍵より新しい版の記録を読めなければ、古い鍵で黙って準備しない (PIN の復旧が古い設定に向く)。
    const newest = BigInt(recoverable.record.public_key_version);
    const unreadable = [
      ...own.dropped,
      ...own.records
        .filter(({ row }) => typeof row === "object" && row !== null && "juicebox_config" in row)
        .filter(
          ({ row }) =>
            !JuiceboxConfig.safeParse((row as { juicebox_config: unknown }).juicebox_config)
              .success,
        )
        .map(({ row }) => row),
    ];
    if (
      unreadable.some((row) => {
        const version = Version.safeParse(row);
        return !version.success || BigInt(version.data.public_key_version) > newest;
      })
    )
      throw new SetupFailure("own_keys", { problem: "newer_key_unreadable" });
    // 復旧の設定のない新しい版は止めずに数える。X の文書は、どの版にも juicebox_config が付くかを書いておらず、
    // 実際のアカウントで確かめた CLI (#413) も同じ選び方で準備できたため。
    const newerWithoutRecovery = own.records.filter(
      ({ record }) => BigInt(record.public_key_version) > newest,
    ).length;
    if (newerWithoutRecovery)
      count(skipped, "own_keys:newer_without_recovery", newerWithoutRecovery);

    const peers: string[] = [];
    let pagination: string | undefined;
    for (let page = 0; page < 5 && peers.length < 20; page += 1) {
      let result: z.infer<typeof Conversations>;
      try {
        result = parse(
          "conversations",
          Conversations,
          await get(
            "conversations",
            "/2/chat/conversations",
            {
              max_results: "20",
              type: "direct",
              expansions: "participant_ids",
              "chat_conversation.fields": "id,type",
              ...(pagination === undefined ? {} : { pagination_token: pagination }),
            },
            "data",
          ),
        );
      } catch (error) {
        // 2 ページ目からは、見つけた相手で続ける。
        if (page === 0 || !(error instanceof SetupFailure)) throw error;
        count(skipped, failureReason(error));
        break;
      }
      for (const row of result.data.slice(0, 20)) {
        const peer = peerOf(row);
        if (!peer) count(skipped, "conversation_shape");
        else if (!peers.includes(peer) && peers.length < 20) peers.push(peer);
      }
      const next = result.meta?.next_token;
      if (!next || result.meta?.has_more === false) break;
      if (next === pagination) {
        count(skipped, "conversations:repeated_page");
        break;
      }
      pagination = next;
    }

    const ownSigners = own.records.map(({ record }) => signer(owner, record));
    const signingKeys = [...ownSigners];
    const rotations: Record<string, string[]> = {};
    const material = () => ({
      userID: owner,
      identityKeyVersion: recoverable.record.public_key_version,
      identityPublicKey: recoverable.record.public_key,
      signingPublicKey: recoverable.record.signing_public_key,
      recoveryConfiguration: btoa(
        Array.from(encoder.encode(JSON.stringify(recoverable.config)), (byte) =>
          String.fromCharCode(byte),
        ).join(""),
      ),
      signingKeys,
      keyChangesByConversation: rotations,
    });
    // 会話を足すたびに全体を数え直さず、足す分だけを数える (区切りの `,` の分も足す)。
    let size = bytesOf(material());
    for (const peer of peers) {
      if (deadline <= Date.now() || !canReadConversation()) {
        count(skipped, deadline <= Date.now() ? "deadline" : "budget");
        continue;
      }
      try {
        const history = parse(
          "conversation_events",
          History,
          await get(
            "conversation_events",
            `/2/chat/conversations/${peer}/events`,
            { max_results: "1", "chat_message_event.fields": "conversation_key_version" },
            "events",
          ),
        );
        const listed = history.meta.conversation_key_events;
        const events = listed
          .flatMap((event) => (RotationEvent.safeParse(event).success ? [event as string] : []))
          .slice(0, 4);
        if (!events.length) {
          count(skipped, listed.length ? "invalid_key_change" : "no_key_change");
          continue;
        }
        const peerSigners = (await keys("peer_keys", peer)).records.map(({ record }) =>
          signer(peer, record),
        );
        if (!peerSigners.length) {
          count(skipped, "peer_keys:none");
          continue;
        }
        // アプリが保存する署名鍵は 100 件まで。超える会話は飛ばし、ほかの会話を残す。
        if (signingKeys.length + peerSigners.length > 100) {
          count(skipped, "signing_key_limit");
          continue;
        }
        const members = [owner, peer].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
        const conversation = members.join(":");
        const added =
          bytesOf({ [conversation]: events }) +
          peerSigners.reduce((sum, key) => sum + bytesOf(key) + 1, 0);
        if (size + added > materialLimit) {
          count(skipped, "material_size");
          continue;
        }
        size += added;
        signingKeys.push(...peerSigners);
        rotations[conversation] = events;
      } catch (error) {
        // 1 つの会話を読めなくても、ほかの会話の本文は出せるので続ける。
        if (!(error instanceof SetupFailure)) throw error;
        count(skipped, failureReason(error));
      }
    }
    if (!Object.keys(rotations).length) throw new SetupFailure("no_key_changes");
    return { material: material(), conversation_count: Object.keys(rotations).length };
  }

  try {
    const { material, conversation_count } = await run();
    return { material, summary: { conversation_count, ...counts() } };
  } catch (error) {
    if (error instanceof SetupFailure)
      throw new SetupFailure(error.stage, { ...error.detail, ...counts() });
    throw error;
  }
}
