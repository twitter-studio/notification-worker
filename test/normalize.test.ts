import { describe, expect, it } from "vitest";
import { normalizeMockEvents } from "../src/normalize";

const now = new Date("2026-11-04T12:00:00.000Z");

describe("模擬のイベントの正規化", () => {
  it("ID に印を付け、時刻を UTC にそろえ、follow には post_id を付けない", () => {
    const result = normalizeMockEvents(
      {
        events: [
          {
            id: "a1",
            kind: "reply",
            post_id: "42",
            created_at: "2026-11-04T20:59:59.500+09:00",
          },
          { id: "f1", kind: "follow", created_at: "2026-11-04T11:00:00Z" },
        ],
      },
      now,
    );

    expect(result).toEqual({
      events: [
        {
          event_id: "mock:a1",
          type: "reply",
          post_id: "42",
          occurred_at: "2026-11-04T11:59:59.500Z",
        },
        { event_id: "mock:f1", type: "follow", occurred_at: "2026-11-04T11:00:00.000Z" },
      ],
      dropped: 0,
    });
  });

  it("イベントの時刻から 1 日を過ぎたものと、5 分より先のものは落とす (境目は送る)", () => {
    const at = (ms: number) => new Date(now.getTime() + ms).toISOString();
    const day = 24 * 60 * 60 * 1000;
    const minutes = 60 * 1000;

    const result = normalizeMockEvents(
      {
        events: [
          { id: "old", kind: "like", post_id: "1", created_at: at(-day - 1) },
          { id: "edge-old", kind: "like", post_id: "1", created_at: at(-day) },
          { id: "edge-new", kind: "like", post_id: "1", created_at: at(5 * minutes) },
          { id: "new", kind: "like", post_id: "1", created_at: at(5 * minutes + 1) },
        ],
      },
      now,
    );

    expect(result.events.map((event) => event.event_id)).toEqual([
      "mock:edge-old",
      "mock:edge-new",
    ]);
    expect(result.dropped).toBe(2);
  });
});
