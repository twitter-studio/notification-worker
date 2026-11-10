import { z } from "zod";
import {
  isEnabled,
  publicRelayTrialExpired,
  type RelayConfig,
  RelayRouteID,
  type XRelayTarget,
} from "./config";
import { dmPreviewKeyID, SealedDmPreview } from "./dm-preview";
import { CLOCK_SKEW_MS, MAX_EVENT_AGE_MS, X_NOTIFICATION_TYPES } from "./normalize";
import { deliveryTargets } from "./pairing-store";
import { type RelayDeps, sendToRelay } from "./relay";
import { recordObservation } from "./telemetry";

import { XNotificationPreview } from "./x-preview";

const Encoded = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const XJobSchema = z
  .strictObject({
    relay_binding: Encoded,
    dm_preview_key_id: Encoded.optional(),
    event: z
      .strictObject({
        event_id: z.string().regex(/^x2_[A-Za-z0-9_-]{43}$/),
        type: z.enum(X_NOTIFICATION_TYPES),
        post_id: z
          .string()
          .regex(/^[1-9][0-9]{0,18}$/)
          .optional(),
        occurred_at: z.iso.datetime(),
        route_id: RelayRouteID.optional(),
        preview: XNotificationPreview.optional(),
        dm_preview: SealedDmPreview.optional(),
      })
      .refine(
        ({ type, post_id, preview, route_id, dm_preview }) =>
          (type === "follow" || type === "dm") === (post_id === undefined) &&
          (preview === undefined || (type !== "follow" && type !== "dm")) &&
          (type !== "dm" || route_id !== undefined) &&
          (dm_preview === undefined || type === "dm"),
      ),
  })
  .refine((job) => (job.dm_preview_key_id === undefined) === (job.event.dm_preview === undefined));
export type XJob = z.infer<typeof XJobSchema>;
export type XEvent = Omit<XJob["event"], "event_id" | "route_id" | "dm_preview">;
function encode(value: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(value)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
export async function xEventID(
  secret: string,
  recipient: string,
  event: XEvent,
  sourceID = event.post_id,
): Promise<string> {
  if (sourceID === undefined) throw new Error("Missing event identity");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const input =
    event.type === "mention" || event.type === "reply"
      ? ["twitter-studio/x-post/v2", recipient, sourceID]
      : ["twitter-studio/x-action/v1", recipient, event.type, sourceID];
  return `x2_${encode(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input.join("\n"))))}`;
}
export async function relayBinding(
  config: RelayConfig,
  recipient: string,
  routeID?: string,
): Promise<string> {
  const prefix = routeID === undefined ? "twitter-studio/x-relay/v1" : "twitter-studio/x-relay/v2";
  const fields = [prefix, recipient, config.endpoint.href, config.token];
  if (routeID !== undefined) fields.push(routeID);
  return encode(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(fields.join("\n"))));
}

type QueueMessage = Pick<Message, "body" | "attempts" | "ack" | "retry">;

async function targetForJob(env: Env, job: XJob): Promise<XRelayTarget | undefined> {
  const routeID = job.event.route_id;
  let match: XRelayTarget | undefined;
  for (const target of await deliveryTargets(env)) {
    if (routeID !== undefined && target.routeID !== routeID) continue;
    // 旧形式の job も、本人・送り先・資格情報が揃う既存の配送先だけに引き継ぐ。
    if ((await relayBinding(target.config, target.recipient, routeID)) !== job.relay_binding)
      continue;
    if (match !== undefined) return undefined;
    match = target;
  }
  return match?.eventTypes.includes(job.event.type) ? match : undefined;
}

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
      publicRelayTrialExpired(env) ||
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
      const target = await targetForJob(env, parsed.data);
      if (target === undefined) {
        recordObservation({ kind: "discarded", reason: "relay_changed" });
        message.ack();
        continue;
      }
      const { dm_preview, ...queuedEvent } = parsed.data.event;
      const event = {
        ...queuedEvent,
        ...(dm_preview !== undefined &&
        target.dmPreviewKey !== undefined &&
        parsed.data.dm_preview_key_id === (await dmPreviewKeyID(target.dmPreviewKey))
          ? { dm_preview }
          : {}),
        ...(target.routeID === undefined ? {} : { route_id: target.routeID }),
      };
      const outcome = await sendToRelay(target.config, event, deps, { remaining: 3 });
      if (outcome.kind === "expired") {
        recordObservation({ kind: "discarded", reason: "inactive_invalid_or_expired" });
        message.ack();
        continue;
      }
      recordObservation({ kind: "delivery", type: parsed.data.event.type, outcome: outcome.kind });
      // 中継が資格情報を断った (401) ときは、やり直しても通らないので捨てる (notification-service の ADR-0007)。やり直すと、
      // 認証の通らない要求を中継へ繰り返し送る。利用者は delivery の記録 (unauthorized) で気づき、中継の資格情報を入れ替える。
      // 403 は捨てない: 中継は返さず、Cloudflare の edge の保護から一時的に来ることがある。
      if (
        outcome.kind === "accepted" ||
        outcome.kind === "duplicate" ||
        outcome.kind === "rejected" ||
        (outcome.kind === "unauthorized" && outcome.status === 401)
      ) {
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
    if (publicRelayTrialExpired(env)) {
      recordObservation({ kind: "discarded", reason: "inactive_invalid_or_expired" });
      message.ack();
    } else if (message.attempts >= 6) {
      recordObservation({ kind: "discarded", reason: "attempt_limit" });
      message.ack();
    } else message.retry({ delaySeconds: delay });
  }
}
