import { z } from "zod";
import type { DmPreviewSource } from "./dm-preview";
import { CLOCK_SKEW_MS, MAX_EVENT_AGE_MS } from "./normalize";
import {
  dmSenderFrom,
  excerptOf,
  isRestrictedPost,
  PostPreviewFields,
  type PreviewSource,
  previewSourceFor,
  previewSourceForReferencedPost,
} from "./x-preview";
import type { XEvent } from "./x-queue";

export const XUserID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const PostID = XUserID;
const ActivityEventID = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const EncodedChatEvent = z
  .string()
  .min(1)
  .max(2400)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);
const Envelope = z.object({ data: z.object({ event_type: z.string().min(1).max(100) }) });
const ReplayStatus = z.strictObject({
  replay_job_status: z.object({
    webhook_id: z.string().min(1),
    job_state: z.enum(["Complete", "Incomplete"]),
    job_id: z.string().min(1),
  }),
});
const Payload = PostPreviewFields.extend({
  id: PostID,
  author_id: XUserID,
});
const Common = {
  created_at: z.iso.datetime({ offset: true }),
  includes: z
    .object({
      users: z.array(z.unknown()).max(100).optional().catch(undefined),
      tweets: z.array(z.unknown()).max(100).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  filter: z.object({ user_id: XUserID }),
};
const PostReference = z.object({ type: z.string(), id: PostID });
const FollowUser = z.object({ data: z.object({ id: XUserID }) });
const ActivityKind = z.enum([
  "post.mention.create",
  "post.reply.create",
  "post.quote.create",
  "post.repost.create",
  "like.create",
  "follow.follow",
  "dm.received",
  "chat.received",
]);
const notificationTypes = {
  "post.mention.create": "mention",
  "post.reply.create": "reply",
  "post.quote.create": "quote",
  "post.repost.create": "retweet",
  "like.create": "like",
  "follow.follow": "follow",
  "dm.received": "dm",
  "chat.received": "dm",
} as const satisfies Record<z.infer<typeof ActivityKind>, XEvent["type"]>;
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
    z.object({
      ...Common,
      event_type: z.enum(["post.quote.create", "post.repost.create"]),
      payload: Payload.extend({ referenced_tweets: z.array(PostReference).max(20) }),
    }),
    z.object({
      ...Common,
      event_type: z.literal("like.create"),
      payload: z.object({
        id: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/),
        liked_tweet_id: PostID,
        liked_tweet_author_id: XUserID,
        liking_user_id: XUserID,
      }),
    }),
    z.object({
      ...Common,
      event_type: z.literal("follow.follow"),
      event_uuid: ActivityEventID,
      payload: z.object({ source: FollowUser, target: FollowUser }),
    }),
    z.object({
      ...Common,
      event_type: z.literal("dm.received"),
      payload: z.object({
        direct_message_events: z
          .array(
            z.object({
              type: z.literal("message_create"),
              id: PostID,
              message_create: z.object({
                target: z.object({ recipient_id: XUserID }),
                sender_id: XUserID,
                message_data: z
                  .object({ text: z.string().max(4000) })
                  .optional()
                  .catch(undefined),
              }),
            }),
          )
          .min(1)
          .max(10),
        // 送った人と受け手の記録。X の文書の例では入るが、いつも入るとは書かれていないので、なくても受ける。
        users: z
          .record(z.string(), z.object({ data: z.unknown() }))
          .optional()
          .catch(undefined),
      }),
    }),
    z.object({
      ...Common,
      event_type: z.literal("chat.received"),
      event_uuid: z.unknown(),
      payload: z.object({
        id: z.uuid().optional(),
        sender_id: XUserID,
        encoded_event: z.string().min(1),
        conversation_id: z
          .string()
          .regex(/^[A-Za-z0-9:-]{1,80}$/)
          .optional()
          .catch(undefined),
        conversation_key_version: z
          .string()
          .regex(/^[0-9]{1,20}$/)
          .optional()
          .catch(undefined),
        conversation_key_change_event: EncodedChatEvent.optional().catch(undefined),
      }),
    }),
  ]),
});

const ValidationFields = [
  "data",
  "data.event_type",
  "data.created_at",
  "data.event_uuid",
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
  "data.payload.referenced_tweets",
  "data.payload.liked_tweet_id",
  "data.payload.liked_tweet_author_id",
  "data.payload.liking_user_id",
  "data.payload.source.data.id",
  "data.payload.target.data.id",
  "data.payload.direct_message_events",
  "data.payload.sender_id",
  "data.payload.encoded_event",
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
  "replay_job_status",
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

type AcceptedEvent = {
  sourceID: string;
  event: XEvent;
  previewSource: PreviewSource | undefined;
  dmPreviewSource?: DmPreviewSource | undefined;
  /** DM の送った人。端末向けに暗号化するときに、名前とアイコンを引くのに使う。 */
  dmSenderID?: string | undefined;
};

type NormalizedXEvent =
  | { kind: "invalid"; stage: XEvent["type"]; fields: ValidationField[] }
  | {
      kind: "invalid";
      stage: "envelope";
      fields: ValidationField[];
      shape: ReturnType<typeof envelopeShape>;
    }
  | { kind: "dropped" }
  | { kind: "replay_status"; state: "Complete" | "Incomplete" }
  | ({ kind: "accepted"; recipient: string } & AcceptedEvent)
  | { kind: "batch"; recipient: string; events: AcceptedEvent[] };

export function normalizeXEvent(json: unknown, now: Date): NormalizedXEvent {
  const envelope = Envelope.safeParse(json);
  if (!envelope.success) {
    // 再送の完了通知は投稿ではない (#35)。未知の形式は引き続き拒否する。
    const replay = ReplayStatus.safeParse(json);
    if (replay.success)
      return { kind: "replay_status", state: replay.data.replay_job_status.job_state };
    return {
      kind: "invalid",
      stage: "envelope",
      fields: invalidFields(envelope.error),
      shape: envelopeShape(json),
    };
  }
  const eventType = ActivityKind.safeParse(envelope.data.data.event_type);
  if (!eventType.success) return { kind: "dropped" };
  const type = notificationTypes[eventType.data];
  const parsed = Event.safeParse(json);
  if (!parsed.success) return { kind: "invalid", stage: type, fields: invalidFields(parsed.error) };
  const { data } = parsed.data;
  const recipient = data.filter.user_id;
  const time = Date.parse(data.created_at);
  if (time < now.getTime() - MAX_EVENT_AGE_MS || time > now.getTime() + CLOCK_SKEW_MS)
    return { kind: "dropped" };
  const occurred_at = new Date(time).toISOString();
  if (data.event_type === "dm.received") {
    const events = data.payload.direct_message_events.flatMap(({ id, message_create }) => {
      if (
        message_create.target.recipient_id !== recipient ||
        message_create.sender_id === recipient
      )
        return [];
      const excerpt = excerptOf(message_create.message_data?.text);
      const sender = dmSenderFrom(
        message_create.sender_id,
        data.payload.users?.[message_create.sender_id]?.data,
      );
      return [
        {
          sourceID: id,
          // 本文がない DM (画像だけなど) でも、送った人は端末に届ける。
          dmPreviewSource: {
            kind: "legacy" as const,
            ...(excerpt === undefined ? {} : { excerpt }),
            ...(sender === undefined ? {} : { sender }),
          },
          dmSenderID: message_create.sender_id,
          previewSource: undefined,
          event: { type: "dm" as const, occurred_at },
        },
      ];
    });
    return events.length === 0 ? { kind: "dropped" } : { kind: "batch", recipient, events };
  }
  if (data.event_type === "chat.received") {
    // 既存配送と同じ重複判定を維持する。公式の形式では payload.id が省略される。
    const sourceID = ActivityEventID.safeParse(data.payload.id ?? data.event_uuid);
    if (!sourceID.success)
      return { kind: "invalid", stage: "dm", fields: ["data.event_uuid", "data.payload.id"] };
    const { sender_id, conversation_id, conversation_key_version, conversation_key_change_event } =
      data.payload;
    if (sender_id === recipient) return { kind: "dropped" };
    const encodedEvent = EncodedChatEvent.safeParse(data.payload.encoded_event);
    return {
      kind: "accepted",
      recipient,
      sourceID: sourceID.data,
      previewSource: undefined,
      dmSenderID: sender_id,
      dmPreviewSource:
        encodedEvent.success &&
        conversation_id !== undefined &&
        conversation_key_version !== undefined
          ? {
              kind: "x_chat",
              sender_id,
              conversation_id,
              conversation_key_version,
              encoded_event: encodedEvent.data,
              ...(conversation_key_change_event === undefined
                ? {}
                : { conversation_key_change_event }),
            }
          : undefined,
      event: { type: "dm", occurred_at },
    };
  }
  const users = data.includes?.users ?? [];
  const tweets = data.includes?.tweets ?? [];
  if (data.event_type === "like.create") {
    const { id, liked_tweet_id, liked_tweet_author_id, liking_user_id } = data.payload;
    if (liked_tweet_author_id !== recipient || liking_user_id === recipient)
      return { kind: "dropped" };
    return {
      kind: "accepted",
      recipient,
      sourceID: id,
      previewSource: previewSourceForReferencedPost({
        actorID: liking_user_id,
        postID: liked_tweet_id,
        postAuthorID: recipient,
        users,
        tweets,
      }),
      event: { type: "like", post_id: liked_tweet_id, occurred_at },
    };
  }
  if (data.event_type === "follow.follow") {
    if (data.payload.target.data.id !== recipient || data.payload.source.data.id === recipient)
      return { kind: "dropped" };
    return {
      kind: "accepted",
      recipient,
      sourceID: data.event_uuid,
      previewSource: undefined,
      event: { type: "follow", occurred_at },
    };
  }
  if (data.payload.author_id === recipient) return { kind: "dropped" };
  if (data.event_type === "post.quote.create" || data.event_type === "post.repost.create") {
    const isQuote = data.event_type === "post.quote.create";
    const original = data.payload.referenced_tweets.find(
      ({ type }) => type === (isQuote ? "quoted" : "retweeted"),
    );
    if (original === undefined || original.id === data.payload.id) return { kind: "dropped" };
    return {
      kind: "accepted",
      recipient,
      sourceID: data.payload.id,
      previewSource: isQuote
        ? previewSourceFor(data.payload, users)
        : isRestrictedPost(data.payload)
          ? undefined
          : previewSourceForReferencedPost({
              actorID: data.payload.author_id,
              postID: original.id,
              postAuthorID: recipient,
              users,
              tweets,
            }),
      event: {
        type: isQuote ? "quote" : "retweet",
        post_id: isQuote ? data.payload.id : original.id,
        occurred_at,
      },
    };
  }
  if (data.event_type === "post.mention.create") {
    if (!data.payload.entities.mentions.some((mention) => mention.id === recipient))
      return { kind: "dropped" };
  } else if (
    data.event_type === "post.reply.create" &&
    data.payload.in_reply_to_user_id !== recipient
  )
    return { kind: "dropped" };
  return {
    kind: "accepted",
    recipient,
    sourceID: data.payload.id,
    previewSource: previewSourceFor(data.payload, users),
    event: { type, post_id: data.payload.id, occurred_at },
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
