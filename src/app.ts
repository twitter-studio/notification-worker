import { ConfigError, isEnabled, relayConfig } from "./config";
import { MockWebhookSchema, normalizeMockEvents } from "./normalize";
import { MAX_SUBREQUESTS, type RelayDeps, type RelayOutcome, sendToRelay } from "./relay";
import { MIN_SECRET_LENGTH, verifyMockSignature } from "./verify";

// 利用者の Worker の入口。Hono は使わない (入口が少なく、設計書 §6 のとおり、小さな処理で足りるため)。

/** Webhook の本文の大きさの上限。 */
export const MAX_BODY_BYTES = 16 * 1024;

function problem(status: number, title: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ type: "about:blank", title, status }), {
    status,
    headers: { ...headers, "Content-Type": "application/problem+json" },
  });
}

function log(level: "log" | "error", event: string, fields: Record<string, unknown> = {}) {
  console[level](JSON.stringify({ event, ...fields }));
}

/** 本文を、上限の大きさまで読む。越えたら undefined。 */
async function readBody(request: Request): Promise<Uint8Array | undefined> {
  const declared = request.headers.get("Content-Length");
  if (declared !== null && Number(declared) > MAX_BODY_BYTES) return undefined;
  if (request.body === null) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > MAX_BODY_BYTES) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}

/** 送るのをやめる答え。残りのイベントを送っても、同じ答えになるか、中継の API の回数の制限と D1 の枠を使うだけなので。 */
const STOP_KINDS: ReadonlySet<RelayOutcome["kind"]> = new Set([
  "retry_later",
  "unauthorized",
  "misdirected",
]);

async function handleMockWebhook(request: Request, env: Env, deps: RelayDeps): Promise<Response> {
  const secret = env.MOCK_WEBHOOK_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    log("error", "invalid_configuration", { setting: "MOCK_WEBHOOK_SECRET" });
    return problem(500, "Internal Server Error");
  }
  const body = await readBody(request);
  if (body === undefined) return problem(413, "Content Too Large");
  const now = new Date();
  // 署名は、生の本文を解析する前に、中継の API の設定より先に確かめる (署名のない要求で、設定の誤りのログを出させない)。
  const signed = await verifyMockSignature({
    secret,
    timestamp: request.headers.get("X-Mock-Timestamp"),
    signature: request.headers.get("X-Mock-Signature"),
    body,
    now,
  });
  if (!signed) return problem(401, "Unauthorized");
  let config: ReturnType<typeof relayConfig>;
  try {
    config = relayConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log("error", "invalid_configuration", { setting: error.setting });
    return problem(500, "Internal Server Error");
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return problem(400, "Bad Request");
  }
  const parsed = MockWebhookSchema.safeParse(json);
  if (!parsed.success) return problem(422, "Unprocessable Content");

  const { events, dropped } = normalizeMockEvents(parsed.data, now);
  const counts: Partial<Record<RelayOutcome["kind"] | "dropped" | "not_sent", number>> = {};
  if (dropped > 0) counts.dropped = dropped;
  let retryAfterSeconds = 0;
  const budget = { remaining: MAX_SUBREQUESTS };
  // 1 つずつ送る (中継の API のアカウントごとの回数の制限に、まとめて当たらないように)。
  for (const [index, event] of events.entries()) {
    const outcome = await sendToRelay(config, event, deps, budget);
    counts[outcome.kind] = (counts[outcome.kind] ?? 0) + 1;
    if (outcome.kind === "retry_later")
      retryAfterSeconds = Math.max(retryAfterSeconds, outcome.retryAfterSeconds);
    if (STOP_KINDS.has(outcome.kind)) {
      const rest = events.length - index - 1;
      if (rest > 0) counts.not_sent = rest;
      break;
    }
  }
  // 資格情報が使えない、設定の誤りは、利用者が直すまで続く。error で出して気づけるようにする。
  const needsAttention =
    counts.unauthorized !== undefined ||
    counts.misdirected !== undefined ||
    counts.rejected !== undefined;
  log(needsAttention ? "error" : "log", "relayed", { counts });
  if (counts.retry_later !== undefined) {
    // 送れなかったものがあれば、Webhook を送ってきた側に、中継の API が求めた秒数を待ってやり直してもらう
    // (縮めると、中継の API の約束より早くやり直させてしまう)。送れたものは、中継の API が重複として除く。
    return problem(503, "Service Unavailable", {
      "Retry-After": String(Math.max(retryAfterSeconds, 1)),
    });
  }
  return Response.json({ counts });
}

export async function handle(request: Request, env: Env, deps: RelayDeps): Promise<Response> {
  const { pathname } = new URL(request.url);
  if (pathname === "/health") {
    if (request.method !== "GET") return problem(405, "Method Not Allowed", { Allow: "GET" });
    // 状態だけを返す。版、設定、秘密の有無を返すと、外から構成を探られる手がかりになるため。
    return Response.json({ status: "ok" });
  }
  if (pathname === "/webhooks/mock") {
    // 無効なときは、入口があることも見せない (どのメソッドでも 404)。
    if (!isEnabled(env.ENABLE_MOCK_EVENTS)) return problem(404, "Not Found");
    if (request.method !== "POST") return problem(405, "Method Not Allowed", { Allow: "POST" });
    return handleMockWebhook(request, env, deps);
  }
  if (pathname === "/webhooks/x") {
    // X の連携 (X-001) は、X の規約の判断 (LEGAL-001) が通るまで作らない。有効にしても、まだ受けない。
    if (!isEnabled(env.ENABLE_X_ACTIVITY)) return problem(404, "Not Found");
    return problem(501, "Not Implemented");
  }
  return problem(404, "Not Found");
}
