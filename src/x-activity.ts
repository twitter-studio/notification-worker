import { z } from "zod";
import { CLOCK_SKEW_MS, MAX_EVENT_AGE_MS } from "./normalize";
import { type PreviewSource, previewSourceFor } from "./x-preview";
import type { XEvent } from "./x-queue";

export const XUserID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const PostID = XUserID;
const Envelope = z.object({ data: z.object({ event_type: z.string().min(1).max(100) }) });
const Payload = z.object({
  id: PostID,
  author_id: XUserID,
  text: z.string().optional().catch(undefined),
  possibly_sensitive: z.boolean().optional().catch(true),
});
const Common = {
  created_at: z.iso.datetime({ offset: true }),
  includes: z
    .object({ users: z.array(z.unknown()).max(100).optional() })
    .optional()
    .catch(undefined),
  filter: z.object({ user_id: XUserID }),
};
const Event = z.object({
  data: z.discriminatedUnion("event_type", [
    z.object({
      ...Common,
      event_type: z.literal("post.mention.create"),
      payload: Payload.extend({
        entities: z.object({ mentions: z.array(z.object({ id: XUserID })).max(100) }),
      }),
    }),
    z.object({
      ...Common,
      event_type: z.literal("post.reply.create"),
      payload: Payload.extend({ in_reply_to_user_id: XUserID }),
    }),
  ]),
});

const ValidationFields = [
  "data",
  "data.event_type",
  "data.created_at",
  "data.filter",
  "data.filter.user_id",
  "data.payload",
  "data.payload.id",
  "data.payload.author_id",
  "data.payload.in_reply_to_user_id",
  "data.payload.entities",
  "data.payload.entities.mentions",
  "data.payload.entities.mentions.*",
  "data.payload.entities.mentions.*.id",
] as const;
type ValidationField = (typeof ValidationFields)[number] | "other";

function invalidFields(error: z.ZodError): ValidationField[] {
  return [
    ...new Set(
      error.issues.map(({ path }) => {
        const normalized = path
          .map((part) => (typeof part === "number" ? "*" : String(part)))
          .join(".");
        return ValidationFields.find((field) => field === normalized) ?? "other";
      }),
    ),
  ];
}

const EnvelopeMarkers = [
  "event_type",
  "events",
  "job_id",
  "replay_event",
  "for_user_id",
  "tweet_create_events",
] as const;

function jsonKind(value: unknown) {
  if (Array.isArray(value)) return "array";
  if (value === null) return "null";
  if (typeof value === "object") return "object";
  return "scalar";
}

function envelopeShape(json: unknown) {
  const root = jsonKind(json);
  const object =
    typeof json === "object" && json !== null && !Array.isArray(json) ? json : undefined;
  return {
    root,
    data:
      object && "data" in object && Object.hasOwn(object, "data")
        ? jsonKind(object.data)
        : "missing",
    markers: object ? EnvelopeMarkers.filter((key) => Object.hasOwn(object, key)) : [],
  };
}

type NormalizedXEvent =
  | { kind: "invalid"; stage: "mention" | "reply"; fields: ValidationField[] }
  | {
      kind: "invalid";
      stage: "envelope";
      fields: ValidationField[];
      shape: ReturnType<typeof envelopeShape>;
    }
  | { kind: "dropped" }
  | {
      kind: "accepted";
      recipient: string;
      event: XEvent;
      previewSource: PreviewSource | undefined;
    };

export function normalizeXEvent(json: unknown, now: Date): NormalizedXEvent {
  const envelope = Envelope.safeParse(json);
  if (!envelope.success)
    return {
      kind: "invalid",
      stage: "envelope",
      fields: invalidFields(envelope.error),
      shape: envelopeShape(json),
    };
  const eventType = envelope.data.data.event_type;
  if (eventType !== "post.mention.create" && eventType !== "post.reply.create")
    return { kind: "dropped" };
  const type = eventType === "post.mention.create" ? "mention" : "reply";
  const parsed = Event.safeParse(json);
  if (!parsed.success) return { kind: "invalid", stage: type, fields: invalidFields(parsed.error) };
  const { data } = parsed.data;
  const recipient = data.filter.user_id;
  const time = Date.parse(data.created_at);
  if (
    data.payload.author_id === recipient ||
    time < now.getTime() - MAX_EVENT_AGE_MS ||
    time > now.getTime() + CLOCK_SKEW_MS
  )
    return { kind: "dropped" };
  if (data.event_type === "post.mention.create") {
    if (!data.payload.entities.mentions.some((mention) => mention.id === recipient))
      return { kind: "dropped" };
  } else if (data.payload.in_reply_to_user_id !== recipient) return { kind: "dropped" };
  return {
    kind: "accepted",
    recipient,
    previewSource: previewSourceFor(data.payload, data.includes?.users ?? []),
    event: { type, post_id: data.payload.id, occurred_at: new Date(time).toISOString() },
  };
}

export async function xCRC(secret: string, token: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(token)),
  );
  return `sha256=${btoa(String.fromCharCode(...mac))}`;
}

export async function verifyXSignature(
  secret: string,
  signature: string | null,
  body: Uint8Array,
): Promise<boolean> {
  const encoded = /^sha256=([A-Za-z0-9+/]{43}=)$/.exec(signature ?? "")?.[1];
  if (encoded === undefined) return false;
  const decoded = atob(encoded);
  if (btoa(decoded) !== encoded) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    Uint8Array.from(decoded, (value) => value.charCodeAt(0)),
    body,
  );
}
