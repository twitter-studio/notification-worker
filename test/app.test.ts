import { exports } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handle, MAX_BODY_BYTES } from "../src/app";
import { fakeRelay, mockEvent, postMock, signedHeaders, testEnv } from "./helpers";

async function expectProblem(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get("Content-Type")).toBe("application/problem+json");
  return response.json<{ title: string; status: number }>();
}

describe("入口", () => {
  it("GET /health は状態だけを返し、設定を出さない", async () => {
    const response = await exports.default.fetch("https://worker.test/health");

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('{"status":"ok"}');
  });

  it("ない入口は 404、違うメソッドは 405", async () => {
    const { deps } = fakeRelay();
    const request = (path: string, method = "GET") =>
      handle(new Request(`https://worker.test${path}`, { method }), testEnv(), deps);

    await expectProblem(await request("/unknown"), 404);
    await expectProblem(await request("/health", "POST"), 405);
    await expectProblem(await request("/webhooks/mock", "GET"), 405);
  });

  it("模擬の入口は、ENABLE_MOCK_EVENTS が true のときだけ受ける", async () => {
    for (const value of ["false", "", "TRUE", "1"]) {
      await expectProblem(
        await postMock({ events: [mockEvent()] }, { env: testEnv({ ENABLE_MOCK_EVENTS: value }) }),
        404,
      );
    }
  });

  it("X の入口は、既定 (ENABLE_X_ACTIVITY=false) では 404。有効にしても、まだ受けない (501)", async () => {
    const { deps } = fakeRelay();
    const post = (value: string) =>
      handle(
        new Request("https://worker.test/webhooks/x", { method: "POST", body: "{}" }),
        testEnv({ ENABLE_X_ACTIVITY: value }),
        deps,
      );

    await expectProblem(await post("false"), 404);
    await expectProblem(await post("true"), 501);
  });
});

describe("模擬の Webhook の署名", () => {
  it("署名がない、違う鍵、書き換えた本文、古い・先の時刻、形の違う署名は 401 で、送らない", async () => {
    const relay = fakeRelay();
    const body = JSON.stringify({ events: [mockEvent()] });
    const now = Math.floor(Date.now() / 1000);
    const valid = await signedHeaders(body);

    for (const headers of [
      { "Content-Type": "application/json" },
      await signedHeaders(body, { secret: "another-secret-another-secret-another" }),
      await signedHeaders(`${body} `),
      await signedHeaders(body, { timestamp: now - 6 * 60 }),
      await signedHeaders(body, { timestamp: now + 6 * 60 }),
      { ...valid, "X-Mock-Signature": valid["X-Mock-Signature"]?.toUpperCase() ?? "" },
      { ...valid, "X-Mock-Timestamp": "not-a-number" },
    ]) {
      await expectProblem(
        await postMock(undefined, { rawBody: body, headers, deps: relay.deps }),
        401,
      );
    }
    expect(relay.sent).toEqual([]);
  });

  it("本文が大きすぎると 413、JSON として読めないと 400、形が違うと 422 (どれも送らない)", async () => {
    const relay = fakeRelay();

    await expectProblem(
      await postMock(undefined, { rawBody: "x".repeat(MAX_BODY_BYTES + 1), deps: relay.deps }),
      413,
    );
    await expectProblem(await postMock(undefined, { rawBody: "{", deps: relay.deps }), 400);
    for (const payload of [
      {},
      { events: [] },
      { events: [mockEvent({ kind: "dm" })] },
      { events: [mockEvent({ extra: "x" })] },
      { events: [mockEvent({ post_id: "abc" })] },
      { events: Array.from({ length: 21 }, () => mockEvent()) },
      { events: [mockEvent()], account_id: "x" },
    ]) {
      await expectProblem(await postMock(payload, { deps: relay.deps }), 422);
    }
    expect(relay.sent).toEqual([]);
  });
});

describe("中継の API へ送る", () => {
  it("正規化したイベントを、RELAY_URL の /v1/notifications へ、RELAY_TOKEN で送る", async () => {
    const relay = fakeRelay();
    const event = mockEvent({ created_at: "2026-11-04T09:00:00+09:00" });
    vi.useFakeTimers({ now: new Date("2026-11-04T00:10:00.000Z"), toFake: ["Date"] });

    const response = await postMock({ events: [event] }, { deps: relay.deps });

    vi.useRealTimers();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ counts: { accepted: 1 } });
    expect(relay.sent).toEqual([
      {
        url: "https://relay.test/v1/notifications",
        authorization: `Bearer ${testEnv().RELAY_TOKEN}`,
        body: {
          event_id: `mock:${event.id}`,
          type: "mention",
          post_id: "1234567890123456789",
          occurred_at: "2026-11-04T00:00:00.000Z",
        },
      },
    ]);
  });

  it("中継の API の答えを数える (受け付けた、重複、やり直さない、資格情報が使えない)", async () => {
    const relay = fakeRelay([
      Response.json({ status: "accepted" }, { status: 202 }),
      Response.json({ status: "duplicate" }, { status: 202 }),
      new Response(null, { status: 422 }),
      new Response(null, { status: 401 }),
    ]);
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await postMock(
      { events: [mockEvent(), mockEvent(), mockEvent(), mockEvent()] },
      { deps: relay.deps },
    );

    expect(await response.json()).toEqual({
      counts: { accepted: 1, duplicate: 1, rejected: 1, unauthorized: 1 },
    });
    // 資格情報が使えないことは、利用者が気づけるよう error で出す。秘密は出さない。
    const logged = JSON.stringify(errors.mock.calls);
    expect(logged).toContain("unauthorized");
    expect(logged).not.toContain(testEnv().RELAY_TOKEN);
    expect(logged).not.toContain(testEnv().MOCK_WEBHOOK_SECRET);
    errors.mockRestore();
  });

  it("短い Retry-After の 409 や 429 は、待って送り直す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 409, headers: { "Retry-After": "1" } }),
      new Response(null, { status: 429, headers: { "Retry-After": "2" } }),
    ]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(await response.json()).toEqual({ counts: { accepted: 1 } });
    expect(relay.sleeps).toEqual([1000, 2000]);
    expect(relay.sent).toHaveLength(3);
  });

  it("長い Retry-After の 503 は、待たずに、Webhook を送ってきた側へ 503 と Retry-After を返す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 503, headers: { "Retry-After": "60" } }),
    ]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(response.headers.get("Retry-After")).toBe("60");
    await expectProblem(response, 503);
    expect(relay.sleeps).toEqual([]);
  });

  it("つながらないときは、決まった回数だけ送り直し、それでもだめなら 503", async () => {
    const relay = fakeRelay([new Error("down"), new Error("down"), new Error("down")]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    await expectProblem(response, 503);
    expect(relay.sent).toHaveLength(3);
    expect(relay.sleeps).toEqual([1000, 1000]);
  });

  it("古すぎるイベント (1 日を過ぎた)、先の時刻のイベント、種類と post_id が合わないイベントは送らず、数える", async () => {
    const relay = fakeRelay();
    const now = Date.now();

    const response = await postMock(
      {
        events: [
          mockEvent({ created_at: new Date(now - 25 * 60 * 60 * 1000).toISOString() }),
          mockEvent({ created_at: new Date(now + 10 * 60 * 1000).toISOString() }),
          mockEvent({ kind: "follow" }),
          mockEvent({ post_id: undefined }),
          mockEvent({ kind: "follow", post_id: undefined }),
        ],
      },
      { deps: relay.deps },
    );

    expect(await response.json()).toEqual({ counts: { dropped: 4, accepted: 1 } });
    expect(relay.sent.map((item) => (item.body as { type: string }).type)).toEqual(["follow"]);
  });
});

describe("設定", () => {
  it("RELAY_URL、RELAY_TOKEN、MOCK_WEBHOOK_SECRET の誤りは 500 で、値を出さずに名前だけをログに出す", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [overrides, setting] of [
      [{ RELAY_URL: "http://relay.test" }, "RELAY_URL"],
      [{ RELAY_URL: "https://relay.test/other" }, "RELAY_URL"],
      [{ RELAY_URL: "https://user:pass@relay.test" }, "RELAY_URL"],
      [{ RELAY_URL: "https://relay.test/?next=x" }, "RELAY_URL"],
      [{ RELAY_URL: "not a url" }, "RELAY_URL"],
      [{ RELAY_TOKEN: "tss_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }, "RELAY_TOKEN"],
      [{ MOCK_WEBHOOK_SECRET: "short" }, "MOCK_WEBHOOK_SECRET"],
    ] as const) {
      const relay = fakeRelay();
      errors.mockClear();

      await expectProblem(
        await postMock({ events: [mockEvent()] }, { env: testEnv(overrides), deps: relay.deps }),
        500,
      );

      const logged = JSON.stringify(errors.mock.calls);
      expect(logged).toContain(setting);
      for (const value of Object.values(overrides)) expect(logged).not.toContain(value);
      expect(relay.sent).toEqual([]);
    }
    errors.mockRestore();
  });
});
