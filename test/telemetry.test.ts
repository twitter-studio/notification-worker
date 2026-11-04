import { afterEach, describe, expect, it, vi } from "vitest";
import { BACKLOG_ALERT_SECONDS, recordObservation, recordQueueState } from "../src/telemetry";
import { testEnv } from "./helpers";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("利用者Workerの個人情報を含まない監視", () => {
  it("実Queue bindingから空Queueのheartbeatを取得する", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await recordQueueState(testEnv().X_EVENTS);
    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "queue_state",
        heartbeat_count: 1,
        backlog_count: 0,
        attention_count: 0,
      }),
    );
  });
  it.each([BACKLOG_ALERT_SECONDS - 1, BACKLOG_ALERT_SECONDS, BACKLOG_ALERT_SECONDS + 1])(
    "滞留の閾値%d秒を判定する",
    async (age) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const now = Date.now();
      await recordQueueState(
        {
          metrics: async () => ({
            backlogCount: 1,
            backlogBytes: 40,
            oldestMessageTimestamp: new Date(now - age * 1000),
          }),
        },
        now,
      );
      expect(age >= BACKLOG_ALERT_SECONDS ? error : info).toHaveBeenCalledWith(
        expect.objectContaining({
          heartbeat_count: 1,
          attention_count: Number(age >= BACKLOG_ALERT_SECONDS),
          oldest_age_seconds: age,
        }),
      );
    },
  );
  it.each([undefined, new Date(0), new Date(Date.now() + 60_000)])(
    "滞留があり年齢不明なら正常にしない",
    async (oldestMessageTimestamp) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await recordQueueState({
        metrics: async () => ({
          backlogCount: 1,
          backlogBytes: 40,
          ...(oldestMessageTimestamp === undefined ? {} : { oldestMessageTimestamp }),
        }),
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({ stage: "queue_state", attention_count: 1, unknown_age_count: 1 }),
      );
    },
  );
  it.each([undefined, new Date(Date.now() - BACKLOG_ALERT_SECONDS * 1000)])(
    "概数の件数が0でもbytesが残る滞留を検知する",
    async (oldestMessageTimestamp) => {
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      await recordQueueState({
        metrics: async () => ({
          backlogCount: 0,
          backlogBytes: 40,
          ...(oldestMessageTimestamp === undefined ? {} : { oldestMessageTimestamp }),
        }),
      });
      expect(error).toHaveBeenCalledWith(
        expect.objectContaining({
          stage: "queue_state",
          heartbeat_count: 1,
          attention_count: 1,
          backlog_count: 0,
          backlog_bytes: 40,
        }),
      );
    },
  );
  it("取得例外や不正な数値は入力値を出さず監視失敗にする", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await recordQueueState({
      metrics: async () => {
        throw new Error("private-canary");
      },
    });
    await recordQueueState({
      metrics: async () => ({ backlogCount: Number.NaN, backlogBytes: -1 }),
    });
    expect(error).toHaveBeenCalledTimes(2);
    for (const [entry] of error.mock.calls)
      expect(entry).toEqual(
        expect.objectContaining({
          stage: "metrics_unavailable",
          heartbeat_count: 0,
          attention_count: 1,
        }),
      );
    expect(JSON.stringify(error.mock.calls)).not.toContain("private-canary");
  });
  it("10秒で終わらない取得も監視失敗として終了する", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const pending = recordQueueState({ metrics: () => new Promise(() => {}) });
    await vi.advanceTimersByTimeAsync(10_000);
    await pending;
    expect(error).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "metrics_unavailable", attention_count: 1 }),
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each([
    "accepted",
    "duplicate",
    "unauthorized",
    "misdirected",
    "rejected",
    "retry_later",
    "configuration_or_transport_error",
  ] as const)("中継結果%sの警報と種類を数える", (outcome) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    recordObservation({ kind: "delivery", type: "reply", outcome });
    const successful = outcome === "accepted" || outcome === "duplicate";
    expect(successful ? info : error).toHaveBeenCalledWith(
      expect.objectContaining({
        stage: "delivery",
        outcome,
        reply_count: 1,
        mention_count: 0,
        accepted_count: Number(outcome === "accepted"),
        duplicate_count: Number(outcome === "duplicate"),
        attention_count: Number(!successful),
      }),
    );
  });
});
