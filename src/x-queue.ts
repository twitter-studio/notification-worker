import { z } from "zod";
import { isEnabled, type RelayConfig, relayConfig } from "./config";
import { CLOCK_SKEW_MS, MAX_EVENT_AGE_MS } from "./normalize";
import { type RelayDeps, sendToRelay } from "./relay";
import { recordObservation } from "./telemetry";
import { XUserID } from "./x-activity";

const Encoded = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const XJobSchema = z.strictObject({
  relay_binding: Encoded,
  event: z.strictObject({
    event_id: z.string().regex(/^x2_[A-Za-z0-9_-]{43}$/),
    type: z.enum(["mention", "reply"]),
    post_id: z.string().regex(/^[1-9][0-9]{0,18}$/),
    occurred_at: z.iso.datetime(),
  }),
});
export type XJob = z.infer<typeof XJobSchema>;
export type XEvent = Omit<XJob["event"], "event_id">;
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function xEventID(secret: string, recipient: string, event: XEvent): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return `x2_${encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`twitter-studio/x-post/v2\n${recipient}\n${event.post_id}`)))}`;
}
export async function relayBinding(config: RelayConfig, recipient: string): Promise<string> {
  return encode(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        `twitter-studio/x-relay/v1\n${recipient}\n${config.endpoint.href}\n${config.token}`,
      ),
    ),
  );
}

type QueueMessage = Pick<Message, "body" | "attempts" | "ack" | "retry">;
export async function handleXQueue(
  messages: readonly QueueMessage[],
  env: Env,
  deps: RelayDeps,
): Promise<void> {
  for (const message of messages) {
    const parsed = XJobSchema.safeParse(message.body);
    const now = Date.now();
    const eventTime = parsed.success ? Date.parse(parsed.data.event.occurred_at) : 0;
    if (
      !isEnabled(env.ENABLE_X_ACTIVITY) ||
      !parsed.success ||
      eventTime < now - MAX_EVENT_AGE_MS ||
      eventTime > now + CLOCK_SKEW_MS
    ) {
      recordObservation({ kind: "discarded", reason: "inactive_invalid_or_expired" });
      message.ack();
      continue;
    }
    let delay = 60;
    try {
      const config = relayConfig(env);
      // 別アカウントの資格情報へ変更した後に、保存済みイベントをそのアカウントへ送らない (ADR-0002)。
      if (
        (await relayBinding(config, XUserID.parse(env.X_USER_ID))) !== parsed.data.relay_binding
      ) {
        recordObservation({ kind: "discarded", reason: "relay_changed" });
        message.ack();
        continue;
      }
      const outcome = await sendToRelay(config, parsed.data.event, deps, { remaining: 3 });
      recordObservation({ kind: "delivery", type: parsed.data.event.type, outcome: outcome.kind });
      if (outcome.kind === "accepted" || outcome.kind === "duplicate") {
        message.ack();
        continue;
      }
      if (outcome.kind === "retry_later") delay = Math.max(1, outcome.retryAfterSeconds);
    } catch {
      recordObservation({
        kind: "delivery",
        type: parsed.data.event.type,
        outcome: "configuration_or_transport_error",
      });
    }
    if (message.attempts >= 6) {
      recordObservation({ kind: "discarded", reason: "attempt_limit" });
      message.ack();
    } else message.retry({ delaySeconds: delay });
  }
}
