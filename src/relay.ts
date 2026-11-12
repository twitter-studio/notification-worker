import type { RelayConfig } from "./config";
import type { RelayEvent } from "./normalize";

// 中継の API (notification-service の POST /v1/notifications) へ送る。やり直しの約束は ADR-0009 (notification-service)。

export type RelayOutcome =
  | { kind: "accepted" }
  | { kind: "duplicate" }
  /** 少し待てば送れる (409、429、5xx、つながらない)。Webhook を送ってきた側に、やり直してもらう。 */
  | { kind: "retry_later"; retryAfterSeconds: number }
  /** 資格情報が使えない (401、403)。やり直さず、利用者が RELAY_TOKEN を入れ替える。 */
  | { kind: "unauthorized"; status: 401 | 403 }
  /** 中継の API が受けない (413、415、422 など)。やり直さない。 */
  | { kind: "rejected" }
  /**
   * 中継の API でない先の答え (リダイレクト、404、405)。RELAY_URL の誤り。リダイレクトには、資格情報とイベントをほかの先へ
   * 送らないため、従わない。
   */
  | { kind: "misdirected" };

export type RelayDeps = {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
};

/**
 * 1 回の要求で外へ送れる回数。Workers の無料のプランの上限 (50 回) の内側に収める。尽きたら送らずに `retry_later` を返し、
 * Webhook を送ってきた側にやり直してもらう。
 */
export const MAX_SUBREQUESTS = 45;

export type SubrequestBudget = { remaining: number };

/** Retry-After の上限 (1 日)。イベントの時刻から 1 日を過ぎたものは送らないので、それより長く待たせても意味がない。 */
export const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;

/** 1 つのイベントを送る回数の上限 (1 回の要求の中で)。 */
export const MAX_ATTEMPTS = 3;
/** 1 回の要求の中で待つのは、この秒数までの Retry-After だけ。長いものは、Webhook を送ってきた側のやり直しに任せる。 */
export const MAX_INLINE_WAIT_SECONDS = 5;
/**
 * 1 回の送信の時間の上限。中継の API が端末へ送る時間の上限 (60 秒、notification-service の ADR-0009) より長くする。
 * 先に切ると、中継の API が送っている途中のまま、やり直しが 409 になる。
 */
export const REQUEST_TIMEOUT_MS = 70 * 1000;

/** Retry-After の秒数 (1 日まで)。ないとき、読めないときは `fallback`。 */
function retryAfterOf(response: Response, fallback: number): number {
  const value = response.headers.get("Retry-After");
  const seconds = value !== null && /^[0-9]{1,6}$/.test(value) ? Number(value) : fallback;
  return Math.min(seconds, MAX_RETRY_AFTER_SECONDS);
}

export async function sendToRelay(
  config: RelayConfig,
  event: RelayEvent,
  deps: RelayDeps,
  budget: SubrequestBudget,
): Promise<RelayOutcome> {
  let retryAfterSeconds = 1;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (budget.remaining <= 0) break;
    budget.remaining--;
    let response: Response;
    try {
      response = await deps.fetch(config.endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
        // リダイレクトに従わない (設定の誤りで、イベントをほかの先へ送らない。従った回数も、外へ送る回数に数えられる)。
        redirect: "manual",
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
    if (response.status === 401 || response.status === 403)
      return { kind: "unauthorized", status: response.status };
    if (
      (response.status >= 300 && response.status < 400) ||
      response.status === 404 ||
      response.status === 405
    )
      return { kind: "misdirected" };
    if (
      response.status >= 400 &&
      response.status < 500 &&
      response.status !== 409 &&
      response.status !== 429
    )
      return { kind: "rejected" };
    retryAfterSeconds = retryAfterOf(response, 60);
    if (retryAfterSeconds > MAX_INLINE_WAIT_SECONDS || attempt === MAX_ATTEMPTS) break;
    await deps.sleep(retryAfterSeconds * 1000);
  }
  return { kind: "retry_later", retryAfterSeconds };
}
