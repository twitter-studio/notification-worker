import { z } from "zod";
import { CLOCK_SKEW_MS, MAX_EVENT_AGE_MS } from "./normalize";
import type { XEvent } from "./x-queue";

export const XUserID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const PostID = XUserID;
const Envelope = z.object({ data: z.object({ event_type: z.string().min(1).max(100) }) });
const Payload = z.object({ id: PostID, author_id: XUserID });
const Common = {
  created_at: z.iso.datetime({ offset: true }),
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

export function normalizeXEvent(json: unknown, recipient: string, now: Date): XEvent | undefined {
  const envelope = Envelope.parse(json);
  if (
    envelope.data.event_type !== "post.mention.create" &&
    envelope.data.event_type !== "post.reply.create"
  )
    return undefined;
  const { data } = Event.parse(json);
  const time = Date.parse(data.created_at);
  if (
    data.filter.user_id !== recipient ||
    data.payload.author_id === recipient ||
    time < now.getTime() - MAX_EVENT_AGE_MS ||
    time > now.getTime() + CLOCK_SKEW_MS
  )
    return undefined;
  if (data.event_type === "post.mention.create") {
    if (!data.payload.entities.mentions.some((mention) => mention.id === recipient))
      return undefined;
  } else if (data.payload.in_reply_to_user_id !== recipient) return undefined;
  const type = data.event_type === "post.mention.create" ? "mention" : "reply";
  return {
    type,
    post_id: data.payload.id,
    occurred_at: new Date(time).toISOString(),
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
