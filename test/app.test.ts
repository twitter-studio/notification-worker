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

  it("模擬の入口は、ENABLE_MOCK_EVENTS が true のときだけ受け、無効なら、どのメソッドでも 404", async () => {
    await expectProblem(
      await handle(
        new Request("https://worker.test/webhooks/mock"),
        testEnv({ ENABLE_MOCK_EVENTS: "false" }),
        fakeRelay().deps,
      ),
      404,
    );
    for (const value of ["false", "", "TRUE", "1"]) {
      await expectProblem(
        await postMock({ events: [mockEvent()] }, { env: testEnv({ ENABLE_MOCK_EVENTS: value }) }),
        404,
      );
    }
  });

  it("X の入口は、既定 (ENABLE_X_ACTIVITY=false) では 404。有効でも署名がなければ拒む (401)", async () => {
    const { deps } = fakeRelay();
    const post = (value: string) =>
      handle(
        new Request("https://worker.test/webhooks/x", { method: "POST", body: "{}" }),
        testEnv({ ENABLE_X_ACTIVITY: value }),
        deps,
      );

    await expectProblem(await post("false"), 404);
    await expectProblem(await post("true"), 401);
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
        redirect: "manual",
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

  it.each([200, 204, 501, 520])("中継の予期しない%sは503を返して再送を求める", async (status) => {
    const relay = fakeRelay([new Response(null, { status })]);
    const response = await postMock({ events: [mockEvent(), mockEvent()] }, { deps: relay.deps });
    await expectProblem(response, 503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(relay.sent).toHaveLength(1);
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

describe("送るのをやめるとき", () => {
  it("長い Retry-After の 429 では、残りを送らず、中継の API が求めた秒数を縮めずに返す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 429, headers: { "Retry-After": "86400" } }),
    ]);

    const response = await postMock(
      { events: [mockEvent(), mockEvent(), mockEvent()] },
      { deps: relay.deps },
    );

    expect(response.headers.get("Retry-After")).toBe("86400");
    await expectProblem(response, 503);
    expect(relay.sent).toHaveLength(1);
  });

  it("409 の Retry-After (中継の API は 30 秒) は待たずに、503 と同じ秒数を返す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 409, headers: { "Retry-After": "30" } }),
    ]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(response.headers.get("Retry-After")).toBe("30");
    await expectProblem(response, 503);
    expect(relay.sleeps).toEqual([]);
  });

  it("Retry-After が 0 なら待たずに送り直し、それでも送れなければ、返す秒数は 1 にする", async () => {
    const zero = () => new Response(null, { status: 503, headers: { "Retry-After": "0" } });
    const relay = fakeRelay([zero(), zero(), zero()]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(response.headers.get("Retry-After")).toBe("1");
    expect(relay.sleeps).toEqual([0, 0]);
  });

  it("資格情報が使えない (401、403) とき、中継の API でない先の答え (リダイレクト、404、405) のときは、残りを送らず、error のログに出す", async () => {
    for (const [status, kind] of [
      [401, "unauthorized"],
      [403, "unauthorized"],
      [302, "misdirected"],
      [308, "misdirected"],
      [404, "misdirected"],
      [405, "misdirected"],
    ] as const) {
      const relay = fakeRelay([
        new Response(null, { status, headers: { Location: "https://elsewhere.test/" } }),
      ]);
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});

      const response = await postMock(
        { events: [mockEvent(), mockEvent(), mockEvent()] },
        { deps: relay.deps },
      );

      expect(await response.json(), String(status)).toEqual({ counts: { [kind]: 1, not_sent: 2 } });
      expect(relay.sent).toHaveLength(1);
      expect(JSON.stringify(errors.mock.calls)).toContain(kind);
      errors.mockRestore();
    }
  });

  it("1 回の要求で外へ送るのは 45 回までで、尽きたら残りを送らずに 503", async () => {
    // どのイベントも 2 回つながらず、3 回目に送れる (20 件なら 60 回になる)。
    const relay = fakeRelay([]);
    let calls = 0;
    const deps = {
      ...relay.deps,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        calls++;
        if (calls % 3 !== 0) throw new Error("down");
        return relay.deps.fetch(input, init);
      }) as typeof fetch,
    };

    const response = await postMock(
      { events: Array.from({ length: 20 }, () => mockEvent()) },
      { deps },
    );

    await expectProblem(response, 503);
    expect(calls).toBe(45);
  });

  it("中継の API が求めた Retry-After は、1 日までにして返す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 503, headers: { "Retry-After": "999999" } }),
    ]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(response.headers.get("Retry-After")).toBe("86400");
  });

  it("502 と 504 は、短い Retry-After なら送り直す", async () => {
    const relay = fakeRelay([
      new Response(null, { status: 502, headers: { "Retry-After": "1" } }),
      new Response(null, { status: 504, headers: { "Retry-After": "1" } }),
    ]);

    const response = await postMock({ events: [mockEvent()] }, { deps: relay.deps });

    expect(await response.json()).toEqual({ counts: { accepted: 1 } });
  });
});

describe("模擬の Webhook の境目", () => {
  it("署名の時刻は、5 分ちょうどまで受け、それより離れたら拒む", async () => {
    const body = JSON.stringify({ events: [mockEvent()] });
    const now = Math.floor(Date.now() / 1000);
    vi.useFakeTimers({ now: now * 1000, toFake: ["Date"] });

    const edge = await postMock(undefined, {
      rawBody: body,
      headers: await signedHeaders(body, { timestamp: now - 300 }),
    });
    const outside = await postMock(undefined, {
      rawBody: body,
      headers: await signedHeaders(body, { timestamp: now - 301 }),
    });

    vi.useRealTimers();
    expect(edge.status).toBe(200);
    expect(outside.status).toBe(401);
  });

  it("5 分のうちに同じ要求が繰り返されたら受け、同じ event_id で送る (中継の API が重複として除く)", async () => {
    const relay = fakeRelay([
      Response.json({ status: "accepted" }, { status: 202 }),
      Response.json({ status: "duplicate" }, { status: 202 }),
    ]);
    const body = JSON.stringify({ events: [mockEvent()] });
    const headers = await signedHeaders(body);

    await postMock(undefined, { rawBody: body, headers, deps: relay.deps });
    const again = await postMock(undefined, { rawBody: body, headers, deps: relay.deps });

    expect(await again.json()).toEqual({ counts: { duplicate: 1 } });
    const eventIds = relay.sent.map((item) => (item.body as { event_id: string }).event_id);
    expect(eventIds).toHaveLength(2);
    expect(new Set(eventIds).size).toBe(1);
  });

  it("UTF-8 として読めない本文は 400", async () => {
    const body = new Uint8Array([0x7b, 0xff, 0x7d]);

    await expectProblem(
      await postMock(undefined, { rawBody: body, headers: await signedHeaders(body) }),
      400,
    );
  });

  it("Content-Length のない分割の本文でも、上限を越えたら 413", async () => {
    const chunk = new Uint8Array(4096).fill(0x20);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 5; index++) controller.enqueue(chunk);
        controller.close();
      },
    });

    const response = await handle(
      new Request("https://worker.test/webhooks/mock", {
        method: "POST",
        headers: await signedHeaders(""),
        body: stream,
      }),
      testEnv(),
      fakeRelay().deps,
    );

    await expectProblem(response, 413);
  });

  it("署名のない要求には、中継の API の設定が誤っていても 401 を返し、設定のログを出さない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await postMock(undefined, {
      rawBody: JSON.stringify({ events: [mockEvent()] }),
      headers: { "Content-Type": "application/json" },
      env: testEnv({ RELAY_URL: "http://relay.test" }),
    });

    await expectProblem(response, 401);
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });

  it("送ったときのログには、イベントの中身を出さない", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const event = mockEvent({ post_id: "9876543210987654321" });

    await postMock({ events: [event] });

    const logged = JSON.stringify(logs.mock.calls);
    expect(logged).toContain("relayed");
    expect(logged).not.toContain(event.id);
    expect(logged).not.toContain("9876543210987654321");
    logs.mockRestore();
  });
});
