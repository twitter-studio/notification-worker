import { readBody } from "./body";
import {
  ConfigError,
  isEnabled,
  publicRelayTrialExpired,
  relayConfig,
  xRelayTargets,
} from "./config";
import { MockWebhookSchema, normalizeMockEvents } from "./normalize";
import { MAX_SUBREQUESTS, type RelayDeps, type RelayOutcome, sendToRelay } from "./relay";
import { recordObservation } from "./telemetry";
import { MIN_SECRET_LENGTH, verifyMockSignature } from "./verify";
import { normalizeXEvent, verifyXSignature, xCRC } from "./x-activity";
import { resolvePreview } from "./x-preview";
import { relayBinding, type XJob, xEventID } from "./x-queue";

export type AppDeps = RelayDeps & { enqueueX: (job: XJob) => Promise<void> };

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
  const body = await readBody(request, MAX_BODY_BYTES);
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

async function handleXWebhook(request: Request, env: Env, deps: AppDeps): Promise<Response> {
  const secret = env.X_OAUTH2_CLIENT_SECRET ?? "";
  if (secret.length < MIN_SECRET_LENGTH) {
    log("error", "invalid_configuration", { setting: "X_OAUTH2_CLIENT_SECRET" });
    return problem(500, "Internal Server Error");
  }
  if (request.method === "GET") {
    const tokens = new URL(request.url).searchParams.getAll("crc_token");
    const token = tokens[0];
    // 同じHMACをPOST署名へ転用する攻撃を防ぐため、JSON構造文字を含むchallengeを署名しない (ADR-0002)。
    if (
      tokens.length !== 1 ||
      token === undefined ||
      token.length === 0 ||
      token.length > 1024 ||
      /[^A-Za-z0-9_+/=-]/.test(token)
    )
      return problem(400, "Bad Request");
    return Response.json(
      { response_token: await xCRC(secret, token) },
      { headers: { "Cache-Control": "no-store" } },
    );
  }
  const body = await readBody(request, MAX_BODY_BYTES);
  if (body === undefined) return problem(413, "Content Too Large");
  // OAuth 1.0へのfallbackは設けず、OAuth 2.0の公式ヘッダーだけを検証する (ADR-0002)。
  if (
    !(await verifyXSignature(
      secret,
      request.headers.get("X-Twitter-Webhooks-Signature-OAuth2"),
      body,
    ))
  )
    return problem(401, "Unauthorized");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body));
  } catch {
    return problem(400, "Bad Request");
  }
  const normalized = normalizeXEvent(json, new Date());
  if (normalized.kind === "replay_status") {
    log("log", "x_webhook_replay_status", { state: normalized.state });
    return new Response(null, { status: 200 });
  }
  if (normalized.kind === "invalid") {
    // Zod の生のエラーには入力値が含まれ得るため、固定の項目名と分類だけを記録する。
    log("log", "x_webhook_validation_rejected", {
      stage: normalized.stage,
      fields: normalized.fields,
      ...(normalized.stage === "envelope" ? { shape: normalized.shape } : {}),
    });
    return problem(422, "Unprocessable Content");
  }
  if (
    normalized.kind === "dropped" ||
    publicRelayTrialExpired(env) ||
    (env.X_EVENT_NOT_BEFORE !== undefined &&
      Date.parse(normalized.event.occurred_at) <= Number(env.X_EVENT_NOT_BEFORE))
  )
    return Response.json({ counts: { dropped: 1 } });
  const { event, recipient } = normalized;
  let targets: ReturnType<typeof xRelayTargets>;
  try {
    targets = xRelayTargets(env).filter((target) => target.recipient === recipient);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    log("error", "invalid_configuration", { setting: error.setting });
    return problem(500, "Internal Server Error");
  }
  if (targets.length === 0) return Response.json({ counts: { dropped: 1 } });
  const idSecret = env.X_EVENT_ID_SECRET ?? "";
  if (idSecret.length < MIN_SECRET_LENGTH) {
    log("error", "invalid_configuration", { setting: "X_EVENT_ID_SECRET" });
    return problem(500, "Internal Server Error");
  }
  const [eventID, preview] = await Promise.all([
    xEventID(idSecret, recipient, event),
    isEnabled(env.ENABLE_X_NOTIFICATION_PREVIEW)
      ? resolvePreview(normalized.previewSource, env.X_PREVIEW_BEARER_TOKEN, deps.fetch)
      : undefined,
  ]);
  const jobs: XJob[] = await Promise.all(
    targets.map(async ({ config, routeID }) => ({
      event: {
        ...event,
        event_id: eventID,
        ...(preview === undefined ? {} : { preview }),
        ...(routeID === undefined ? {} : { route_id: routeID }),
      },
      relay_binding: await relayBinding(config, recipient, routeID),
    })),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.all(jobs.map((job) => deps.enqueueX(job))),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("enqueue_timeout")), 8000);
      }),
    ]);
  } catch {
    log("error", "x_enqueue_failed");
    recordObservation({ kind: "enqueue_failed" });
    return problem(503, "Service Unavailable", { "Retry-After": "60" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  for (const _ of jobs) recordObservation({ kind: "enqueued", type: event.type });
  return Response.json({ counts: { queued: jobs.length } });
}

export async function handle(request: Request, env: Env, deps: AppDeps): Promise<Response> {
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
    if (!isEnabled(env.ENABLE_X_ACTIVITY)) return problem(404, "Not Found");
    if (request.method !== "GET" && request.method !== "POST")
      return problem(405, "Method Not Allowed", { Allow: "GET, POST" });
    return handleXWebhook(request, env, deps);
  }
  return problem(404, "Not Found");
}
