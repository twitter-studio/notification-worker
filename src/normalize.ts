import { z } from "zod";

// 模擬のイベントを、中継の API のイベント (notification-service の ADR-0009) にそろえる。
// 模擬の形は、このリポジトリで決めた試すための形 (ADR-0001)。X のイベントの形は、X の連携 (X-001) で決める。

/** 中継の API が受けるイベントの種類 (notification-service の ADR-0009 と同じ)。 */
export const EVENT_TYPES = ["mention", "reply", "quote", "retweet", "like", "follow"] as const;

export type RelayEvent = {
  event_id: string;
  type: (typeof EVENT_TYPES)[number];
  post_id?: string;
  occurred_at: string;
};

/** 中継の API は、イベントの時刻から 7 日より古いものを拒む。送り手は、イベントの時刻から 1 日以内に送り終える。 */
export const MAX_EVENT_AGE_MS = 24 * 60 * 60 * 1000;

/** 送り手とイベントの時計のずれとして許す幅 (中継の API と同じ)。 */
export const CLOCK_SKEW_MS = 5 * 60 * 1000;

/**
 * 1 回の Webhook で受けるイベントの数の上限。1 回の要求で外へ送れる回数 (Workers の無料のプランで 50 回) の内側に収める
 * (送れたイベントは 1 回、送れなかったイベントで送るのをやめるまでの最大 3 回)。
 */
export const MAX_EVENTS_PER_WEBHOOK = 20;

const MockEventSchema = z.strictObject({
  id: z.string().regex(/^[A-Za-z0-9._:-]{1,100}$/),
  kind: z.enum(EVENT_TYPES),
  post_id: z
    .string()
    .regex(/^[1-9][0-9]{0,18}$/)
    .optional(),
  // 時差の付いた形も受け、送るときに UTC にそろえる。
  created_at: z.iso.datetime({ offset: true }),
});

export const MockWebhookSchema = z.strictObject({
  events: z.array(MockEventSchema).min(1).max(MAX_EVENTS_PER_WEBHOOK),
});

export type MockWebhook = z.infer<typeof MockWebhookSchema>;

/**
 * 模擬のイベントを中継の API のイベントにする。古すぎるもの (イベントの時刻から 1 日を過ぎたもの) と、先の時刻のものは送らない
 * (中継の API がリプレイとして拒むものを送らない)。種類と post_id が合わないもの (follow に post_id がある、ほかの種類に
 * post_id がない) も送らない。
 */
export function normalizeMockEvents(
  webhook: MockWebhook,
  now: Date,
): { events: RelayEvent[]; dropped: number } {
  const events: RelayEvent[] = [];
  let dropped = 0;
  for (const event of webhook.events) {
    const occurredAt = Date.parse(event.created_at);
    const tooOld = occurredAt < now.getTime() - MAX_EVENT_AGE_MS;
    const tooNew = occurredAt > now.getTime() + CLOCK_SKEW_MS;
    const postMismatch = (event.kind === "follow") === (event.post_id !== undefined);
    if (tooOld || tooNew || postMismatch) {
      dropped++;
      continue;
    }
    events.push({
      // 模擬のイベントの ID は、X のイベントの ID とぶつからないよう、頭に印を付ける。
      event_id: `mock:${event.id}`,
      type: event.kind,
      ...(event.post_id === undefined ? {} : { post_id: event.post_id }),
      occurred_at: new Date(occurredAt).toISOString(),
    });
  }
  return { events, dropped };
}
