import { describe, expect, it, vi } from "vitest";
import { relayConfig } from "../src/config";
import { sendToRelay } from "../src/relay";
import { handleXQueue, relayBinding, XJobSchema, xEventID } from "../src/x-queue";
import { fakeRelay, testEnv } from "./helpers";

const event = {
  type: "mention",
  post_id: "2222222222222222222",
  occurred_at: new Date().toISOString(),
} as const;
const enabled = () => testEnv({ ENABLE_X_ACTIVITY: "true" });
it("公開試験の期限をまたぐと中継HTTPを再試行しない", async () => {
  const expiresAt = Date.now() + 500;
  const clock = vi.spyOn(Date, "now").mockReturnValue(expiresAt - 500);
  const fetch = vi.fn(
    async () => new Response(null, { status: 503, headers: { "Retry-After": "1" } }),
  );
  try {
    await sendToRelay(
      { ...relayConfig(enabled()), expiresAt },
      { ...event, event_id: "test-event" },
      {
        fetch,
        sleep: async () => {
          clock.mockReturnValue(expiresAt);
        },
      },
      { remaining: 3 },
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  } finally {
    clock.mockRestore();
  }
});
it("公開試験中は専用の送り先と資格情報を使い、期限後はsandboxへ戻さず停止する", () => {
  const config = {
    ...enabled(),
    PUBLIC_RELAY_TRIAL_UNTIL: String(Date.now() + 60_000),
    PUBLIC_RELAY_TRIAL_ORIGIN: "https://public.example",
    PUBLIC_RELAY_TRIAL_TOKEN: `tsr_${"x".repeat(43)}`,
  };
  expect(relayConfig(config)).toEqual({
    endpoint: new URL("https://public.example/v1/notifications"),
    token: config.PUBLIC_RELAY_TRIAL_TOKEN,
    expiresAt: Number(config.PUBLIC_RELAY_TRIAL_UNTIL),
  });
  expect(() =>
    relayConfig({ ...config, PUBLIC_RELAY_TRIAL_UNTIL: String(Date.now() - 1) }),
  ).toThrow();
  expect(() => relayConfig({ ...config, PUBLIC_RELAY_TRIAL_TOKEN: "" })).toThrow();
});
async function job() {
  return XJobSchema.parse({
    event: {
      ...event,
      occurred_at: new Date().toISOString(),
      event_id: await xEventID(enabled().X_EVENT_ID_SECRET, enabled().X_USER_ID, event),
    },
    relay_binding: await relayBinding(relayConfig(enabled()), enabled().X_USER_ID),
  });
}
function message(body: unknown, attempts = 1) {
  return { body, attempts, ack: vi.fn(), retry: vi.fn() };
}

describe("Xイベントの永続Queueからの配信", () => {
  it.each(["accepted", "duplicate"])("中継の%sを受けた後だけackする", async (status) => {
    const relay = fakeRelay([Response.json({ status }, { status: 202 })]);
    const input = await job();
    const item = message(input);
    await handleXQueue([item], enabled(), relay.deps);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(relay.sent[0]?.body).toEqual(input.event);
  });
  it("長い待機は縮めず、送り先の誤りや中継のほかの断りも成功としてackしない", async () => {
    for (const status of [302, 403, 404, 422, 429, 501, 503, 520]) {
      const relay = fakeRelay([new Response(null, { status, headers: { "Retry-After": "3600" } })]);
      const item = message(await job());
      await handleXQueue([item], enabled(), relay.deps);
      expect(item.ack, String(status)).not.toHaveBeenCalled();
      expect(item.retry).toHaveBeenCalledWith({
        delaySeconds: status === 429 || status === 503 ? 3600 : 60,
      });
    }
  });
  it("中継の401は1回だけ送り、やり直さずに捨てる", async () => {
    const relay = fakeRelay([new Response(null, { status: 401 })]);
    const item = message(await job());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleXQueue([item], enabled(), relay.deps);
      expect(relay.sent).toHaveLength(1);
      expect(item.ack).toHaveBeenCalledOnce();
      expect(item.retry).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "x_worker_observation",
          stage: "delivery",
          outcome: "unauthorized",
          attention_count: 1,
        }),
      );
      expect(JSON.stringify(errors.mock.calls)).not.toContain(enabled().RELAY_TOKEN);
    } finally {
      errors.mockRestore();
    }
  });
  it("上限で破棄し、無限に再送しない", async () => {
    const relay = fakeRelay([new Response(null, { status: 404 })]);
    const item = message(await job(), 6);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleXQueue([item], enabled(), relay.deps);
      expect(item.ack).toHaveBeenCalledOnce();
      expect(item.retry).not.toHaveBeenCalled();
      expect(errors).toHaveBeenCalledWith(
        expect.objectContaining({
          event: "x_worker_observation",
          stage: "discarded",
          reason: "attempt_limit",
          attention_count: 1,
        }),
      );
    } finally {
      errors.mockRestore();
    }
  });
  it("無効・不正・古い・未来・別アカウントへの変更後のjobは送らない", async () => {
    const input = await job();
    const old = {
      ...input,
      event: { ...input.event, occurred_at: new Date(Date.now() - 86400001).toISOString() },
    };
    const future = {
      ...input,
      event: { ...input.event, occurred_at: new Date(Date.now() + 600000).toISOString() },
    };
    const relay = fakeRelay();
    for (const [body, environment] of [
      [input, testEnv({ ENABLE_X_ACTIVITY: "false" })],
      [{ ...input, extra: "private" }, enabled()],
      [old, enabled()],
      [future, enabled()],
      [input, testEnv({ ENABLE_X_ACTIVITY: "true", RELAY_TOKEN: `tsr_${"B".repeat(43)}` })],
      [input, testEnv({ ENABLE_X_ACTIVITY: "true", X_USER_ID: "999" })],
    ] as const) {
      const item = message(body);
      await handleXQueue([item], environment, relay.deps);
      expect(item.ack).toHaveBeenCalledOnce();
      expect(item.retry).not.toHaveBeenCalled();
    }
    expect(relay.sent).toEqual([]);
  });
  it("イベントIDは種類や時刻に依存せず、鍵と本人とツイートで変わる", async () => {
    const first = await xEventID(enabled().X_EVENT_ID_SECRET, "111", event);
    expect(
      await xEventID(enabled().X_EVENT_ID_SECRET, "111", {
        ...event,
        occurred_at: new Date(0).toISOString(),
      }),
    ).toBe(first);
    expect(await xEventID(enabled().X_EVENT_ID_SECRET, "111", { ...event, type: "reply" })).toBe(
      first,
    );
    for (const id of [
      await xEventID("different-secret", "111", event),
      await xEventID(enabled().X_EVENT_ID_SECRET, "333", event),
      await xEventID(enabled().X_EVENT_ID_SECRET, "111", { ...event, post_id: "444" }),
    ])
      expect(id).not.toBe(first);
    expect(first).toMatch(/^x2_[A-Za-z0-9_-]{43}$/);
  });
  it("切り替え前のjobを新しい通知として送り直さない", async () => {
    const input = await job();
    const relay = fakeRelay();
    const item = message({ ...input, event: { ...input.event, event_id: `x1_${"A".repeat(43)}` } });
    await handleXQueue([item], enabled(), relay.deps);
    expect(item.ack).toHaveBeenCalledOnce();
    expect(item.retry).not.toHaveBeenCalled();
    expect(relay.sent).toEqual([]);
  });
  it("誤設定は入力値を出さず、成功にせず再送する", async () => {
    const relay = fakeRelay();
    const item = message(await job());
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await handleXQueue(
        [item],
        testEnv({ ENABLE_X_ACTIVITY: "true", RELAY_URL: "private-canary" }),
        relay.deps,
      );
      expect(item.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
      expect(JSON.stringify(errors.mock.calls)).not.toContain("private-canary");
      expect(relay.sent).toEqual([]);
    } finally {
      errors.mockRestore();
    }
  });
});
