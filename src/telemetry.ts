import type { RelayOutcome } from "./relay";
import type { XEvent } from "./x-queue";

type Observation =
  | { kind: "enqueued"; type: XEvent["type"] }
  | { kind: "enqueue_failed" }
  | {
      kind: "delivery";
      type: XEvent["type"];
      outcome: RelayOutcome["kind"] | "configuration_or_transport_error";
    }
  | { kind: "discarded"; reason: "inactive_invalid_or_expired" | "relay_changed" | "attempt_limit" }
  | { kind: "queue_state"; backlog: number; bytes: number; oldestAge: number; unknownAge: boolean }
  | { kind: "metrics_unavailable" };

export const BACKLOG_ALERT_SECONDS = 15 * 60;

export function recordObservation(observation: Observation): void {
  const counts = {
    heartbeat_count: 0,
    attention_count: 0,
    enqueued_count: 0,
    mention_count: 0,
    reply_count: 0,
    quote_count: 0,
    retweet_count: 0,
    like_count: 0,
    follow_count: 0,
    dm_count: 0,
    accepted_count: 0,
    duplicate_count: 0,
    discarded_count: 0,
  };
  if ("type" in observation) counts[`${observation.type}_count`] = 1;
  switch (observation.kind) {
    case "enqueued":
      counts.enqueued_count = 1;
      break;
    case "delivery":
      if (observation.outcome === "accepted") counts.accepted_count = 1;
      else if (observation.outcome === "duplicate") counts.duplicate_count = 1;
      else counts.attention_count = 1;
      break;
    case "discarded":
      counts.discarded_count = 1;
      counts.attention_count = 1;
      break;
    case "queue_state":
      counts.heartbeat_count = 1;
      counts.attention_count = Number(
        (observation.backlog > 0 || observation.bytes > 0) &&
          (observation.unknownAge || observation.oldestAge >= BACKLOG_ALERT_SECONDS),
      );
      break;
    case "enqueue_failed":
    case "metrics_unavailable":
      counts.attention_count = 1;
      break;
    default: {
      const exhaustive: never = observation;
      throw new Error(exhaustive);
    }
  }
  const fields = {
    event: "x_worker_observation",
    stage: observation.kind,
    ...counts,
    ...("outcome" in observation ? { outcome: observation.outcome } : {}),
    ...("reason" in observation ? { reason: observation.reason } : {}),
    ...(observation.kind === "queue_state"
      ? {
          backlog_count: observation.backlog,
          backlog_bytes: observation.bytes,
          oldest_age_seconds: observation.oldestAge,
          unknown_age_count: Number(observation.unknownAge),
        }
      : {}),
  };
  if (counts.attention_count) console.error(fields);
  else console.info(fields);
}

export async function recordQueueState(
  queue: Pick<Queue, "metrics">,
  now = Date.now(),
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const metrics = await Promise.race([
      queue.metrics(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("metrics_timeout")), 10_000);
      }),
    ]);
    const oldest = metrics.oldestMessageTimestamp?.getTime();
    if (
      !Number.isFinite(metrics.backlogCount) ||
      metrics.backlogCount < 0 ||
      !Number.isFinite(metrics.backlogBytes) ||
      metrics.backlogBytes < 0 ||
      (oldest !== undefined && !Number.isFinite(oldest))
    )
      throw new Error("invalid_metrics");
    recordObservation({
      kind: "queue_state",
      backlog: metrics.backlogCount,
      bytes: metrics.backlogBytes,
      oldestAge: oldest === undefined ? 0 : Math.max(0, Math.floor((now - oldest) / 1000)),
      unknownAge:
        (metrics.backlogCount > 0 || metrics.backlogBytes > 0) &&
        (oldest === undefined || oldest <= 0 || oldest > now),
    });
  } catch {
    // SDK例外には構成や応答が含まれうるため、固定の分類だけを記録する。
    recordObservation({ kind: "metrics_unavailable" });
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
