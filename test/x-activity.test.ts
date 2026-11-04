import { afterEach, describe, expect, it, vi } from "vitest";
import { handle, MAX_BODY_BYTES } from "../src/app";
import { handleXQueue, XJobSchema } from "../src/x-queue";
import { fakeRelay, testEnv } from "./helpers";

const recipient = "1111111111111111111";
const secret = "test-x-oauth2-client-secret-0123456789abcdef";
const canary = "private-content-canary-do-not-log";
const env = () => testEnv({ ENABLE_X_ACTIVITY: "true" });
function event(type = "post.mention.create", now = Date.now()) {
  return {
    data: {
      event_uuid: "synthetic-delivery",
      event_type: type,
      created_at: new Date(now).toISOString(),
      filter: { user_id: recipient },
      payload: {
        id: "2222222222222222222",
        author_id: "3333333333333333333",
        text: canary,
        entities: { mentions: [{ id: recipient }] },
        in_reply_to_user_id: recipient,
      },
      includes: { private: canary },
    },
  };
}
async function mac(body: string | Uint8Array, keyValue = secret) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(keyValue),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return `sha256=${btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes))))}`;
}
async function post(
  payload: unknown,
  options: {
    raw?: string | Uint8Array;
    headers?: Record<string, string>;
    environment?: Env;
    relay?: ReturnType<typeof fakeRelay>;
  } = {},
) {
  const body = options.raw ?? JSON.stringify(payload);
  return handle(
    new Request("https://worker.test/webhooks/x", {
      method: "POST",
      body,
      headers: options.headers ?? { "X-Twitter-Webhooks-Signature-OAuth2": await mac(body) },
    }),
    options.environment ?? env(),
    (options.relay ?? fakeRelay()).deps,
  );
}
afterEach(() => vi.restoreAllMocks());

describe("XAAのCRCと入口", () => {
  it("無効フラグではすべて404、違うメソッドは405", async () => {
    for (const value of ["false", "", "TRUE", "1"]) {
      for (const method of ["GET", "POST", "PUT"])
        expect(
          (
            await handle(
              new Request("https://worker.test/webhooks/x", { method }),
              testEnv({ ENABLE_X_ACTIVITY: value }),
              fakeRelay().deps,
            )
          ).status,
        ).toBe(404);
    }
    const response = await handle(
      new Request("https://worker.test/webhooks/x", { method: "DELETE" }),
      env(),
      fakeRelay().deps,
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("Allow")).toBe("GET, POST");
  });
  it("CRCはURL復号したchallengeのHMACを返しキャッシュしない", async () => {
    const relay = fakeRelay();
    const response = await handle(
      new Request("https://worker.test/webhooks/x?crc_token=a%2Bb%26c"),
      env(),
      relay.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_token: await mac("a+b&c") });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(relay.sent).toEqual([]);
  });
  it.each(["", "?crc_token=", "?crc_token=a&crc_token=b", `?crc_token=${"a".repeat(1025)}`])(
    "不正なCRC %sを拒む",
    async (query) => {
      expect(
        (
          await handle(
            new Request(`https://worker.test/webhooks/x${query}`),
            env(),
            fakeRelay().deps,
          )
        ).status,
      ).toBe(400);
    },
  );
});
describe("XAAの署名と本文", () => {
  it("未署名・異なる鍵・改変・OAuth1のみ・OAuth2不正時のlegacy fallbackを拒む", async () => {
    const body = JSON.stringify(event());
    const valid = await mac(body);
    const relay = fakeRelay();
    for (const headers of [
      {},
      {
        "X-Twitter-Webhooks-Signature-OAuth2": await mac(
          body,
          "another-secret-another-secret-123456",
        ),
      },
      { "X-Twitter-Webhooks-Signature-OAuth2": await mac(`${body} `) },
      { "X-Twitter-Webhooks-Signature": valid },
      { "X-Twitter-Webhooks-Signature-OAuth2": "invalid", "X-Twitter-Webhooks-Signature": valid },
      { "X-Twitter-Webhooks-Signature-OAuth2": valid.replace(/=$/, "") },
    ]) {
      expect((await post(undefined, { raw: body, headers, relay })).status).toBe(401);
    }
    expect(relay.sent).toEqual([]);
  });
  it("JSONの再直列化をせずUTF-8の生バイトで検証する", async () => {
    const raw = JSON.stringify(event(), null, 2).replace(canary, "通知の本文");
    expect((await post(undefined, { raw })).status).toBe(200);
    expect(
      (
        await post(undefined, {
          raw,
          headers: {
            "X-Twitter-Webhooks-Signature-OAuth2": await mac(JSON.stringify(JSON.parse(raw))),
          },
        })
      ).status,
    ).toBe(401);
  });
  it("署名をJSON解析より先に確認し、過大・壊れたUTF8・不正なJSONを拒む", async () => {
    expect((await post(undefined, { raw: "{", headers: {} })).status).toBe(401);
    expect((await post(undefined, { raw: "{" })).status).toBe(400);
    expect((await post(undefined, { raw: new Uint8Array([0xff]) })).status).toBe(400);
    expect((await post(undefined, { raw: "x".repeat(MAX_BODY_BYTES + 1) })).status).toBe(413);
    const response = await post({ data: { event_type: "post.mention.create" } });
    expect(response.status).toBe(422);
  });
  it("設定のエラー・成功・拒否でも本文と資格情報をログへ出さない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(
      (
        await post(event(), {
          environment: testEnv({ ENABLE_X_ACTIVITY: "true", X_OAUTH2_CLIENT_SECRET: "short" }),
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await post(event(), {
          environment: testEnv({ ENABLE_X_ACTIVITY: "true", X_USER_ID: canary }),
        })
      ).status,
    ).toBe(500);
    expect(
      (
        await post(event(), {
          environment: testEnv({ ENABLE_X_ACTIVITY: "true", RELAY_URL: canary }),
        })
      ).status,
    ).toBe(500);
    expect((await post(event())).status).toBe(200);
    const logged = JSON.stringify([errors.mock.calls, logs.mock.calls]);
    for (const value of [canary, secret, recipient, env().RELAY_TOKEN, "2222222222222222222"])
      expect(logged).not.toContain(value);
  });
});
describe("許可イベントの正規化と再送", () => {
  it.each([
    ["post.mention.create", "mention"],
    ["post.reply.create", "reply"],
  ])("%sは本文・本人IDを除いて中継する", async (kind, type) => {
    const relay = fakeRelay();
    const payload = event(kind);
    expect((await post(payload, { relay })).status).toBe(200);
    expect(relay.sent).toHaveLength(0);
    expect(relay.queued).toHaveLength(1);
    const job = XJobSchema.parse(relay.queued[0]);
    expect(job.event).toEqual({
      event_id: expect.stringMatching(/^x1_[A-Za-z0-9_-]{43}$/),
      type,
      post_id: "2222222222222222222",
      occurred_at: payload.data.created_at,
    });
    expect(JSON.stringify(relay.queued)).not.toContain(recipient);
    expect(JSON.stringify(relay.queued)).not.toContain(canary);
  });
  it("本人以外・自己発信・宛先不一致・未許可のイベントを送らない", async () => {
    const other = event();
    other.data.filter.user_id = "999";
    const self = event();
    self.data.payload.author_id = recipient;
    const mention = event();
    mention.data.payload.entities.mentions = [{ id: "999" }];
    const reply = event("post.reply.create");
    reply.data.payload.in_reply_to_user_id = "999";
    const relay = fakeRelay();
    for (const payload of [
      other,
      self,
      mention,
      reply,
      event("post.quote.create"),
      event("like.create"),
      event("dm.received"),
      event("chat.received"),
      event("future.event"),
    ]) {
      const response = await post(payload, { relay });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ counts: { dropped: 1 } });
    }
    expect(relay.sent).toEqual([]);
  });
  it("時刻の許容境界を守り、署名付きの古いイベント・未来時刻も送らない", async () => {
    const now = Date.now();
    vi.useFakeTimers({ now, toFake: ["Date"] });
    const relay = fakeRelay();
    try {
      for (const offset of [-86400000, 300000])
        expect((await post(event("post.mention.create", now + offset), { relay })).status).toBe(
          200,
        );
      for (const offset of [-86400001, 300001])
        expect(
          await (await post(event("post.mention.create", now + offset), { relay })).json(),
        ).toEqual({ counts: { dropped: 1 } });
      expect(relay.queued).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("配信IDを変えた再送も同じ中継IDになりduplicateとして処理する", async () => {
    const relay = fakeRelay([
      Response.json({ status: "accepted" }, { status: 202 }),
      Response.json({ status: "duplicate" }, { status: 202 }),
    ]);
    const payload = event();
    await post(payload, { relay });
    payload.data.event_uuid = "another-delivery";
    const response = await post(payload, { relay });
    expect(await response.json()).toEqual({ counts: { queued: 1 } });
    const messages = relay.queued.map((body) => ({
      body,
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    }));
    await handleXQueue(messages, env(), relay.deps);
    expect(relay.sent[0]?.body).toEqual(relay.sent[1]?.body);
    expect(messages.every((message) => message.ack.mock.calls.length === 1)).toBe(true);
  });
  it("Queue保存が8秒で終わらなければ503で応答し、後から保存されても同じIDを使う", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const relay = fakeRelay();
    const entered = Promise.withResolvers<void>();
    const save = Promise.withResolvers<void>();
    relay.deps.enqueueX = async (body) => {
      relay.queued.push(body);
      entered.resolve();
      await save.promise;
    };
    try {
      const pending = post(event(), { relay });
      await entered.promise;
      await vi.advanceTimersByTimeAsync(8000);
      expect((await pending).status).toBe(503);
      expect(relay.sent).toEqual([]);
      expect(relay.queued).toHaveLength(1);
    } finally {
      save.resolve();
      vi.useRealTimers();
    }
  });
  it("Queueへ保存できないときは503で、成功と応答しない", async () => {
    const relay = fakeRelay();
    relay.deps.enqueueX = async () => {
      throw new Error(canary);
    };
    const response = await post(event(), { relay });
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(relay.sent).toEqual([]);
  });
  it.each(["", "0", "01", "abc", "1".repeat(20)])("不正なツイートID %sを中継しない", async (id) => {
    const payload = event();
    payload.data.payload.id = id;
    const relay = fakeRelay();
    expect((await post(payload, { relay })).status).toBe(422);
    expect(relay.sent).toEqual([]);
  });
});
