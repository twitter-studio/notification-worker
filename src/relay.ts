import type { RelayConfig } from "./config";
import type { RelayEvent } from "./normalize";

// 中継の API (notification-service の POST /v1/notifications) へ送る。やり直しの約束は ADR-0009 (notification-service)。

export type RelayOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  /** 少し待てば送れる (409、429、5xx、つながらない)。Webhook を送ってきた側に、やり直してもらう。 */
  | { kind: "retry_later"; retryAfterSeconds: number }
  /** 資格情報が使えない (401、403)。やり直さず、利用者が RELAY_TOKEN を入れ替える。 */
  | { kind: "unauthorized" }
  /** 中継の API が受けない (413、415、422 など)。やり直さない。 */
  | { kind: "rejected" };

export type RelayDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

/** 1 つのイベントを送る回数の上限 (1 回の要求の中で)。 */
export const MAX_ATTEMPTS = 3;
/** 1 回の要求の中で待つのは、この秒数までの Retry-After だけ。長いものは、Webhook を送ってきた側のやり直しに任せる。 */
export const MAX_INLINE_WAIT_SECONDS = 5;
/** 1 回の送信の時間の上限。 */
export const REQUEST_TIMEOUT_MS = 10 * 1000;

const RETRYABLE = new Set([409, 429, 500, 502, 503, 504]);

/** Retry-After の秒数。ないとき、読めないときは `fallback`。 */
function retryAfterOf(response: Response, fallback: number): number {
  const value = response.headers.get("Retry-After");
  return value !== null && /^[0-9]{1,6}$/.test(value) ? Number(value) : fallback;
}

export async function sendToRelay(
  config: RelayConfig,
  event: RelayEvent,
  deps: RelayDeps,
): Promise<RelayOutcome> {
  let retryAfterSeconds = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let response: Response;
    try {
      response = await deps.fetch(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      // つながらない、時間切れ。少し待ってやり直す。
      retryAfterSeconds = 1;
      if (attempt < MAX_ATTEMPTS) await deps.sleep(retryAfterSeconds * 1000);
      continue;
    }
    if (response.status === 202) {
      const body = await response
        .json<{ status?: string }>()
        .catch(() => ({}) as { status?: string });
      return body.status === "duplicate" ? { kind: "duplicate" } : { kind: "accepted" };
    }
    // 本文は読まずに捨てる (中継の API のエラーの文を、ログに写さない)。
    await response.body?.cancel();
    if (response.status === 401 || response.status === 403) return { kind: "unauthorized" };
    if (!RETRYABLE.has(response.status)) return { kind: "rejected" };
    retryAfterSeconds = retryAfterOf(response, 60);
    if (retryAfterSeconds > MAX_INLINE_WAIT_SECONDS || attempt === MAX_ATTEMPTS) break;
    await deps.sleep(retryAfterSeconds * 1000);
  }
  return { kind: "retry_later", retryAfterSeconds };
}
