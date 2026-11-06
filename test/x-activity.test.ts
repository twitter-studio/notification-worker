import { afterEach, describe, expect, it, vi } from "vitest";
import { handle, MAX_BODY_BYTES } from "../src/app";
import { xRelayTargets } from "../src/config";
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
      new Request("https://worker.test/webhooks/x?crc_token=a%2Bb%2Fc_-%3D9"),
      env(),
      relay.deps,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ response_token: await mac("a+b/c_-=9") });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(relay.sent).toEqual([]);
  });
  it("CRCへJSON本文を署名させてPOSTを偽造できない", async () => {
    const payload = event();
    const body = JSON.stringify(payload);
    expect(body.length).toBeLessThan(1024);
    const relay = fakeRelay();
    const response = await handle(
      new Request(`https://worker.test/webhooks/x?crc_token=${encodeURIComponent(body)}`),
      env(),
      relay.deps,
    );
    expect(response.status).toBe(400);
    expect(relay.queued).toEqual([]);
    for (const token of ["{", "}", '"', "a:b", "a,b", "a b", "a\n", "a\u0000"]) {
      expect(
        (
          await handle(
            new Request(`https://worker.test/webhooks/x?crc_token=${encodeURIComponent(token)}`),
            env(),
            relay.deps,
          )
        ).status,
      ).toBe(400);
    }
    const accepted = await handle(
      new Request("https://worker.test/webhooks/x?crc_token=syntheticChallenge_123"),
      env(),
      relay.deps,
    );
    const proof = await accepted.json<{ response_token: string }>();
    expect(
      (
        await post(payload, {
          headers: { "X-Twitter-Webhooks-Signature-OAuth2": proof.response_token },
          relay,
        })
      ).status,
    ).toBe(401);
    expect(relay.queued).toEqual([]);
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
  it("署名のある 422 は固定の検証項目だけを記録し、署名のない入力は記録しない", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const reply = event("post.reply.create");
    const invalidReply = {
      data: { ...reply.data, payload: { ...reply.data.payload, in_reply_to_user_id: canary } },
    };
    const invalidMention = event();
    invalidMention.data.payload.entities.mentions = [{ id: recipient }, { id: canary }];
    const unknownEnvelope = { [canary]: reply.data, job_id: canary };
    const arrayEnvelope = { data: [reply.data] };

    for (const input of [invalidReply, invalidMention, unknownEnvelope, arrayEnvelope]) {
      const relay = fakeRelay();
      expect((await post(input, { headers: {}, relay })).status).toBe(401);
      expect((await post(input, { relay })).status).toBe(422);
      expect(relay.queued).toEqual([]);
    }
    expect(logs.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      {
        event: "x_webhook_validation_rejected",
        stage: "reply",
        fields: ["data.payload.in_reply_to_user_id"],
      },
      {
        event: "x_webhook_validation_rejected",
        stage: "mention",
        fields: ["data.payload.entities.mentions.*.id"],
      },
      {
        event: "x_webhook_validation_rejected",
        stage: "envelope",
        fields: ["data"],
        shape: { root: "object", data: "missing", markers: ["job_id"] },
      },
      {
        event: "x_webhook_validation_rejected",
        stage: "envelope",
        fields: ["data"],
        shape: { root: "object", data: "array", markers: [] },
      },
    ]);
  });
  it("署名済みの再送完了通知は配送せず受理し、未知の形式は引き続き拒む", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const relay = fakeRelay();
    const status = { webhook_id: canary, job_id: canary, job_state_description: canary };
    const completion = { replay_job_status: { ...status, job_state: "Complete" } };
    expect((await post(completion, { headers: {}, relay })).status).toBe(401);
    expect((await post(completion, { relay })).status).toBe(200);
    expect(
      (await post({ replay_job_status: { ...status, job_state: "Incomplete" } }, { relay })).status,
    ).toBe(200);
    expect(logs.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
      { event: "x_webhook_replay_status", state: "Complete" },
      { event: "x_webhook_replay_status", state: "Incomplete" },
    ]);
    for (const input of [
      { replay_job_status: { ...status, job_state: "unknown" } },
      { replay_job_status: { job_state: "Complete" } },
      { ...completion, data: { event_type: "post.reply.create" } },
    ]) {
      expect((await post(input, { relay })).status).toBe(422);
    }
    expect(relay.queued).toEqual([]);
    expect(relay.sent).toEqual([]);
  });
  it("設定のエラー・成功・拒否でも本文と資格情報をログへ出さない", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const infos = vi.spyOn(console, "info").mockImplementation(() => {});
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
    const logged = JSON.stringify([errors.mock.calls, logs.mock.calls, infos.mock.calls]);
    for (const value of [canary, secret, recipient, env().RELAY_TOKEN, "2222222222222222222"])
      expect(logged).not.toContain(value);
  });
});
describe("通知のプレビュー", () => {
  const author = { id: "3333333333333333333", username: "example", protected: false };
  const lookup = "https://api.x.com/2/users/3333333333333333333?user.fields=protected";
  const bearer = "synthetic-preview-bearer";

  it("メンションは本人や参照先でなく、投稿者と短い本文を中継する", async () => {
    const relay = fakeRelay();
    const payload = event();
    payload.data.payload.text = `投稿\n\u202E${"界".repeat(276)}👩🏽‍💻末尾`;
    payload.data.includes = Object.assign(payload.data.includes, {
      users: [{ id: recipient, username: "recipient", protected: false }, author],
    });
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    expect(
      (
        await post(payload, {
          relay,
          environment: testEnv({
            ENABLE_X_ACTIVITY: "true",
            ENABLE_X_NOTIFICATION_PREVIEW: "true",
          }),
        })
      ).status,
    ).toBe(200);
    await handleXQueue(
      [
        {
          body: relay.queued[0],
          attempts: 1,
          ack: vi.fn(),
          retry: vi.fn(),
        },
      ],
      env(),
      relay.deps,
    );
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]?.body).toMatchObject({
      preview: { author: "example", excerpt: `投稿 ${"界".repeat(276)}…` },
    });
    expect(JSON.stringify(info.mock.calls)).not.toContain("投稿");
  });

  it.each(["found", "mismatched", "protected", "unavailable", "redirect", "disabled"])(
    "返信の投稿者が展開されない場合の照会結果が %s でも配送する",
    async (result) => {
      const relay = fakeRelay();
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      const environment = {
        ...env(),
        ENABLE_X_NOTIFICATION_PREVIEW: result === "disabled" ? "false" : "true",
        X_PREVIEW_BEARER_TOKEN: bearer,
      };
      const fetch = vi.fn(relay.deps.fetch).mockImplementation(async (url, init) => {
        if (String(url) !== lookup) return relay.deps.fetch(url, init);
        // fetch を差し替えても、workerd が実際に受け付ける設定であることを検証する。
        new Request(url, init);
        if (result === "unavailable") return new Response(null, { status: 429 });
        if (result === "redirect") return Response.redirect("https://other.example/");
        return Response.json({
          data: {
            ...author,
            id: result === "mismatched" ? recipient : author.id,
            protected: result === "protected",
          },
        });
      });
      const deps = { ...relay.deps, fetch };
      const request = JSON.stringify(event("post.reply.create"));
      const response = await handle(
        new Request("https://worker.test/webhooks/x", {
          method: "POST",
          body: request,
          headers: { "X-Twitter-Webhooks-Signature-OAuth2": await mac(request) },
        }),
        environment,
        deps,
      );
      expect(response.status).toBe(200);
      if (result === "disabled") {
        expect(fetch).not.toHaveBeenCalled();
      } else {
        expect(fetch).toHaveBeenCalledExactlyOnceWith(new URL(lookup), {
          headers: { Authorization: `Bearer ${bearer}` },
          redirect: "manual",
          signal: expect.any(AbortSignal),
        });
      }
      const job = XJobSchema.parse(relay.queued[0]);
      expect(job.event.preview).toEqual(
        result === "found" ? { author: "example", excerpt: canary } : undefined,
      );
      expect(JSON.stringify(job)).not.toContain(bearer);
      const observations = info.mock.calls
        .map(([fields]) => fields)
        .filter((fields) => fields.event === "x_preview_lookup");
      const outcomes: Record<string, string> = {
        found: "found",
        mismatched: "invalid_response",
        protected: "unavailable_profile",
        unavailable: "http_error",
        redirect: "http_error",
      };
      expect(observations).toEqual(
        result === "disabled"
          ? []
          : [
              {
                event: "x_preview_lookup",
                outcome: outcomes[result],
                status: result === "unavailable" ? 429 : result === "redirect" ? 302 : 200,
              },
            ],
      );
    },
  );
});

describe("許可イベントの正規化と再送", () => {
  it.each([
    ["post.mention.create", "mention"],
    ["post.reply.create", "reply"],
  ])("%sは投稿者が不明なら定型通知として中継する", async (kind, type) => {
    const relay = fakeRelay();
    const payload = event(kind);
    expect((await post(payload, { relay })).status).toBe(200);
    expect(relay.sent).toHaveLength(0);
    expect(relay.queued).toHaveLength(1);
    const job = XJobSchema.parse(relay.queued[0]);
    expect(job.event).toEqual({
      event_id: expect.stringMatching(/^x2_[A-Za-z0-9_-]{43}$/),
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
    for (const payload of [other, self, mention, reply, event("future.event")]) {
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
  it.each([
    ["post.mention.create", "post.reply.create"],
    ["post.reply.create", "post.mention.create"],
  ])("%sから%sへ到着しても同じ通知IDで1件にまとめる", async (first, second) => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const relay = fakeRelay();
    for (const kind of [first, second, first])
      expect((await post(event(kind), { relay })).status).toBe(200);
    const jobs = relay.queued.map((value) => XJobSchema.parse(value));
    expect(jobs[0]?.event.post_id).toBe(jobs[1]?.event.post_id);
    expect(jobs[0]?.event.event_id).toBe(jobs[1]?.event.event_id);
    expect(jobs[0]?.event.event_id).toBe(jobs[2]?.event.event_id);
    expect(info.mock.calls.map(([entry]) => entry)).toEqual(
      [first, second, first].map((kind) =>
        expect.objectContaining({
          stage: "enqueued",
          mention_count: Number(kind === "post.mention.create"),
          reply_count: Number(kind === "post.reply.create"),
        }),
      ),
    );
    const logged = JSON.stringify(info.mock.calls);
    for (const input of jobs) {
      expect(logged).not.toContain(input.event.event_id);
      expect(logged).not.toContain(input.event.post_id);
      expect(logged).not.toContain(input.relay_binding);
    }
    const consumer = fakeRelay([
      Response.json({ status: "accepted" }, { status: 202 }),
      Response.json({ status: "duplicate" }, { status: 202 }),
      Response.json({ status: "duplicate" }, { status: 202 }),
    ]);
    const messages = jobs.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
    await handleXQueue(messages, env(), consumer.deps);
    expect(consumer.sent.map((sent) => XJobSchema.shape.event.parse(sent.body).event_id)).toEqual(
      jobs.map((input) => input.event.event_id),
    );
    expect(
      messages.every(
        (message) => message.ack.mock.calls.length === 1 && message.retry.mock.calls.length === 0,
      ),
    ).toBe(true);
    expect(
      info.mock.calls
        .map(([entry]) => entry)
        .filter((entry) => entry.stage === "delivery")
        .map((entry) => entry.outcome),
    ).toEqual(["accepted", "duplicate", "duplicate"]);
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

describe("通知種類の許可リスト", () => {
  const actor = "3333333333333333333";
  const original = "4444444444444444444";
  const payloads = {
    "post.quote.create": {
      ...event().data.payload,
      referenced_tweets: [{ type: "quoted", id: original }],
    },
    "post.repost.create": {
      ...event().data.payload,
      referenced_tweets: [{ type: "retweeted", id: original }],
    },
    "like.create": {
      id: "like-one",
      liking_user_id: actor,
      liked_tweet_author_id: recipient,
      liked_tweet_id: original,
    },
    "follow.follow": { source: { data: { id: actor } }, target: { data: { id: recipient } } },
  };
  it.each([
    ["post.quote.create", "quote", "引用の本文"],
    ["post.repost.create", "retweet", "元のツイート"],
    ["like.create", "like", "元のツイート"],
  ] as const)("%s の公開本文を中継する", async (event_type, type, excerpt) => {
    const actorID = event_type === "like.create" ? actor : event().data.payload.author_id;
    const input = {
      data: {
        ...event().data,
        event_type,
        payload: { ...payloads[event_type], text: "引用の本文" },
        includes: {
          users: [
            { id: recipient, username: "recipient", protected: false },
            { id: actorID, username: "example", protected: false },
          ],
          tweets: [
            { id: original, author_id: recipient, text: "元のツイート", possibly_sensitive: false },
          ],
        },
      },
    };
    const relay = fakeRelay();
    const environment = {
      ...env(),
      X_NOTIFICATION_TYPES: type,
      ENABLE_X_NOTIFICATION_PREVIEW: "true",
    };
    expect((await post(input, { relay, environment })).status).toBe(200);
    await handleXQueue(
      [{ body: relay.queued[0], attempts: 1, ack: vi.fn(), retry: vi.fn() }],
      environment,
      relay.deps,
    );
    expect(relay.sent[0]?.body).toMatchObject({ type, preview: { author: "example", excerpt } });
  });

  it("閲覧者が制限されたツイートは公開アカウントのいいねでも照会・表示しない", async () => {
    const relay = fakeRelay();
    const fetch = vi.fn<typeof globalThis.fetch>();
    const input = {
      data: {
        ...event().data,
        event_type: "like.create",
        payload: payloads["like.create"],
        includes: {
          users: [
            { id: actor, username: "example", protected: false },
            { id: recipient, username: "recipient", protected: false },
          ],
          tweets: [
            {
              id: original,
              author_id: recipient,
              text: canary,
              possibly_sensitive: false,
              scopes: { followers: true },
            },
          ],
        },
      },
    };
    const environment = {
      ...env(),
      X_NOTIFICATION_TYPES: "like",
      ENABLE_X_NOTIFICATION_PREVIEW: "true",
      ENABLE_X_POST_PREVIEW_LOOKUP: "true",
      X_PREVIEW_BEARER_TOKEN: "synthetic-preview-bearer",
    };
    expect(
      (await post(input, { relay: { ...relay, deps: { ...relay.deps, fetch } }, environment }))
        .status,
    ).toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect(XJobSchema.parse(relay.queued[0]).event.preview).toBeUndefined();
  });

  it.each(["public", "sensitive", "restricted", "disabled"])(
    "いいねで元のツイートを照会できる場合にだけ本文を表示する (%s)",
    async (mode) => {
      const relay = fakeRelay();
      const input = {
        data: {
          ...event().data,
          event_type: "like.create",
          payload: payloads["like.create"],
          includes: {
            users:
              mode === "disabled" ? [] : [{ id: actor, username: "example", protected: false }],
          },
        },
      };
      const environment = {
        ...env(),
        X_NOTIFICATION_TYPES: "like",
        ENABLE_X_NOTIFICATION_PREVIEW: "true",
        ENABLE_X_POST_PREVIEW_LOOKUP: mode === "disabled" ? "false" : "true",
        X_PREVIEW_BEARER_TOKEN: "synthetic-preview-bearer",
      };
      const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json({
          includes: { users: [{ id: recipient, protected: false }] },
          data: {
            id: original,
            author_id: recipient,
            possibly_sensitive: mode === "sensitive",
            ...(mode === "restricted" ? { scopes: { followers: true } } : {}),
            text: "元のツイート",
          },
        }),
      );
      expect(
        (await post(input, { relay: { ...relay, deps: { ...relay.deps, fetch } }, environment }))
          .status,
      ).toBe(200);
      if (mode === "disabled") expect(fetch).not.toHaveBeenCalled();
      else
        expect(fetch).toHaveBeenCalledExactlyOnceWith(
          new URL(
            `https://api.x.com/2/tweets/${original}?post.fields=possibly_sensitive%2Cscopes%2Cwithheld&expansions=author_id&user.fields=protected`,
          ),
          expect.objectContaining({
            redirect: "manual",
          }),
        );
      expect(XJobSchema.parse(relay.queued[0]).event.preview).toEqual(
        mode === "public" ? { author: "example", excerpt: "元のツイート" } : undefined,
      );
    },
  );

  it.each([
    ["post.quote.create", "quote", "2222222222222222222"],
    ["post.repost.create", "retweet", original],
    ["like.create", "like", original],
    ["follow.follow", "follow", undefined],
  ] as const)("%s は明示的に有効な配送先にだけ送る", async (event_type, type, postID) => {
    const input = { data: { ...event().data, event_type, payload: payloads[event_type] } };
    const relay = fakeRelay();
    expect(await (await post(input, { relay })).json()).toEqual({ counts: { dropped: 1 } });
    expect(relay.queued).toHaveLength(0);
    const environment = { ...env(), X_NOTIFICATION_TYPES: type };
    expect(await (await post(input, { relay, environment })).json()).toEqual({
      counts: { queued: 1 },
    });
    const queued = XJobSchema.parse(relay.queued[0]);
    expect(queued.event.type).toBe(type);
    expect(queued.event.post_id).toBe(postID);
    const message = { body: relay.queued[0], attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleXQueue([message], { ...environment, X_NOTIFICATION_TYPES: "" }, relay.deps);
    expect(message.ack).toHaveBeenCalledOnce();
    expect(relay.sent).toHaveLength(0);
  });

  it("DM は宛先を確認し、本文・X Chat の暗号文・トークンを転送しない", async () => {
    const relay = fakeRelay([
      Response.json({}, { status: 202 }),
      Response.json({}, { status: 202 }),
    ]);
    const routeA = "00000000-0000-4000-8000-000000000001";
    const routeB = "00000000-0000-4000-8000-000000000002";
    const environment = {
      ...env(),
      X_RELAY_ROUTES: JSON.stringify({
        [recipient]: [{ route_id: routeA, relay_token: env().RELAY_TOKEN, event_types: ["dm"] }],
        [original]: [
          { route_id: routeB, relay_token: `tsr_${"b".repeat(43)}`, event_types: ["dm"] },
        ],
      }),
    };
    const message_create = {
      target: { recipient_id: recipient },
      sender_id: actor,
      message_data: { text: canary },
    };
    const legacy = {
      data: {
        ...event("dm.received").data,
        payload: {
          direct_message_events: [
            { type: "message_create", id: original, message_create },
            {
              type: "message_create",
              id: actor,
              message_create: { ...message_create, target: { recipient_id: "999" } },
            },
          ],
        },
      },
    };
    const chat = {
      data: {
        ...event("chat.received").data,
        event_uuid: "00000000-0000-4000-8000-000000000001",
        payload: {
          sender_id: actor,
          encoded_event: "private-ciphertext",
          conversation_token: "private-token",
        },
      },
    };
    const activityChat = {
      data: {
        ...chat.data,
        event_uuid: "8511582263942905822",
        payload: { ...chat.data.payload, id: "00000000-0000-4000-8000-000000000002" },
      },
    };
    for (const input of [legacy, chat, activityChat])
      expect(await (await post(input, { relay, environment })).json()).toEqual({
        counts: { queued: 1 },
      });
    expect(JSON.stringify(relay.queued)).not.toContain(canary);
    expect(JSON.stringify(relay.queued)).not.toContain("private-token");
    expect(JSON.stringify(relay.queued)).not.toContain("private-ciphertext");
    await handleXQueue(
      relay.queued.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() })),
      environment,
      relay.deps,
    );
    expect(relay.sent).toHaveLength(3);
    for (const { body } of relay.sent) {
      expect(body).toMatchObject({ type: "dm", route_id: routeA });
      expect(body).not.toHaveProperty("post_id");
      expect(JSON.stringify(body)).not.toContain(canary);
      expect(JSON.stringify(body)).not.toContain("private-");
    }
  });
  it("DM プレビューを設定したルートだけに暗号化し、解除・鍵交換したルートは定型通知に戻す", async () => {
    const relay = fakeRelay([
      Response.json({}, { status: 202 }),
      Response.json({}, { status: 202 }),
      Response.json({}, { status: 202 }),
    ]);
    const route = {
      route_id: crypto.randomUUID(),
      relay_token: env().RELAY_TOKEN,
      event_types: ["dm"],
    };
    const key = new Uint8Array(32).fill(7);
    const encodedKey = btoa(String.fromCharCode(...key)).replace(/=+$/, "");
    const enabled = {
      ...env(),
      X_RELAY_ROUTES: JSON.stringify({ [recipient]: [{ ...route, dm_preview_key: encodedKey }] }),
    };
    const disabled = { ...enabled, X_RELAY_ROUTES: JSON.stringify({ [recipient]: [route] }) };
    const rotated = {
      ...enabled,
      X_RELAY_ROUTES: JSON.stringify({
        [recipient]: [{ ...route, dm_preview_key: "A".repeat(43) }],
      }),
    };
    const input = {
      data: {
        ...event("dm.received").data,
        payload: {
          direct_message_events: [
            {
              type: "message_create",
              id: original,
              message_create: {
                target: { recipient_id: recipient },
                sender_id: actor,
                message_data: { text: canary },
              },
            },
          ],
        },
      },
    };
    expect(await (await post(input, { relay, environment: enabled })).json()).toEqual({
      counts: { queued: 1 },
    });
    const job = XJobSchema.parse(relay.queued[0]);
    expect(JSON.stringify(job)).not.toContain(canary);
    expect(JSON.stringify(job)).not.toContain(encodedKey);
    const sealed = job.event.dm_preview;
    if (sealed === undefined) throw new Error("Expected encrypted DM preview");
    const bytes = Uint8Array.from(atob(sealed.replaceAll("-", "+").replaceAll("_", "/")), (value) =>
      value.charCodeAt(0),
    );
    const cryptoKey = await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]);
    const decrypt = (id: string, account = recipient) =>
      crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(0, 12),
          additionalData: new TextEncoder().encode(
            `twitter-studio/dm-preview/v1\n${account}\n${id}\n${job.event.event_id}`,
          ),
        },
        cryptoKey,
        bytes.slice(12),
      );
    const plain = await decrypt(route.route_id);
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({
      kind: "legacy",
      excerpt: canary,
      occurred_at: job.event.occurred_at,
    });
    await expect(decrypt(crypto.randomUUID())).rejects.toThrow();
    await expect(decrypt(route.route_id, original)).rejects.toThrow();
    const message = { body: job, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleXQueue([message], enabled, relay.deps);
    await handleXQueue([message], disabled, relay.deps);
    await handleXQueue([message], rotated, relay.deps);
    expect(relay.sent[0]?.body).toMatchObject({ dm_preview: sealed });
    expect(relay.sent[1]?.body).not.toHaveProperty("dm_preview");
    expect(relay.sent[2]?.body).not.toHaveProperty("dm_preview");
    expect(JSON.stringify(relay.sent)).not.toContain(canary);
  });

  it.each([false, true])(
    "X Chat を端末ルートで暗号化し、大きな鍵変更は省く（%s）",
    async (large) => {
      const relay = fakeRelay();
      const key = new Uint8Array(32).fill(7);
      const routeID = crypto.randomUUID();
      const environment = {
        ...env(),
        X_RELAY_ROUTES: JSON.stringify({
          [recipient]: [
            {
              route_id: routeID,
              relay_token: env().RELAY_TOKEN,
              event_types: ["dm"],
              dm_preview_key: btoa(String.fromCharCode(...key)).replace(/=+$/, ""),
            },
          ],
        }),
      };
      const chat = {
        sender_id: actor,
        conversation_id: `${recipient}:${actor}`,
        conversation_key_version: "123",
        encoded_event: btoa(large ? "m".repeat(600) : "synthetic-chat-message"),
        conversation_key_change_event: btoa(large ? "k".repeat(1800) : "synthetic-key-change"),
      };
      const response = await post(
        {
          data: {
            ...event("chat.received").data,
            event_uuid: crypto.randomUUID(),
            payload: { ...chat, conversation_token: canary },
          },
        },
        { relay, environment },
      );
      expect(await response.json()).toEqual({ counts: { queued: 1 } });
      const { event: job } = XJobSchema.parse(relay.queued[0]);
      expect(JSON.stringify(job)).not.toContain(chat.encoded_event);
      expect(JSON.stringify(job)).not.toContain(chat.conversation_key_change_event);
      if (!job.dm_preview) throw new Error("Expected encrypted X Chat preview");
      const bytes = Uint8Array.from(
        atob(job.dm_preview.replaceAll("-", "+").replaceAll("_", "/")),
        (value) => value.charCodeAt(0),
      );
      const plaintext = await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: bytes.slice(0, 12),
          additionalData: new TextEncoder().encode(
            `twitter-studio/dm-preview/v1\n${recipient}\n${routeID}\n${job.event_id}`,
          ),
        },
        await crypto.subtle.importKey("raw", key, "AES-GCM", false, ["decrypt"]),
        bytes.slice(12),
      );
      expect(JSON.parse(new TextDecoder().decode(plaintext))).toEqual({
        kind: "x_chat",
        ...chat,
        ...(large ? { conversation_key_change_event: undefined } : {}),
        occurred_at: job.occurred_at,
      });
    },
  );
});

describe("DM プレビューの配送設定", () => {
  it("不正な鍵や使い回された鍵だけを無効にして配送ルートは維持する", () => {
    const duplicate = "A".repeat(43);
    const valid = `${"B".repeat(42)}A`;
    const keys = [duplicate, duplicate, "invalid", valid];
    const routes = keys.map((dm_preview_key, index) => ({
      route_id: crypto.randomUUID(),
      relay_token: `tsr_${String(index).repeat(43)}`,
      event_types: ["dm"],
      dm_preview_key,
    }));
    const targets = xRelayTargets({
      ...env(),
      X_RELAY_ROUTES: JSON.stringify({ [recipient]: routes }),
    });
    expect(targets.map((target) => target.routeID)).toEqual(routes.map((route) => route.route_id));
    expect(targets.map((target) => target.dmPreviewKey)).toEqual([
      undefined,
      undefined,
      undefined,
      valid,
    ]);
  });
});

describe("Xアカウントごとの複数端末配送", () => {
  const other = "4444444444444444444";
  const phone = {
    relay_token: `tsr_${"A".repeat(43)}`,
    route_id: "123e4567-e89b-42d3-a456-426614174000",
  };
  const tablet = {
    relay_token: `tsr_${"B".repeat(43)}`,
    route_id: "123e4567-e89b-42d3-a456-426614174001",
  };
  const otherAccountOnPhone = {
    relay_token: phone.relay_token,
    route_id: "123e4567-e89b-42d3-a456-426614174002",
  };
  const routes = { [recipient]: [phone, tablet], [other]: [otherAccountOnPhone] };
  const environment = (value: unknown = routes) =>
    testEnv({
      ENABLE_X_ACTIVITY: "true",
      X_USER_ID: "",
      RELAY_TOKEN: "",
      X_RELAY_ROUTES: JSON.stringify(value),
    });

  it("署名された受信者の端末だけに送り、同じ端末上の別アカウントと混ぜない", async () => {
    const relay = fakeRelay();
    const configured = environment({
      ...routes,
      [recipient]: [{ ...phone, route_id: phone.route_id.toUpperCase() }, tablet],
    });
    const first = await post(event(), { environment: configured, relay });
    expect(await first.json()).toEqual({ counts: { queued: 2 } });
    const second = event("post.reply.create");
    second.data.filter.user_id = other;
    second.data.payload.in_reply_to_user_id = other;
    expect(await (await post(second, { environment: configured, relay })).json()).toEqual({
      counts: { queued: 1 },
    });

    const queued = JSON.stringify(relay.queued);
    for (const privateValue of [recipient, other, phone.relay_token, tablet.relay_token, canary])
      expect(queued).not.toContain(privateValue);
    const jobs = relay.queued.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
    await handleXQueue(jobs, configured, relay.deps);
    expect(jobs.every((job) => job.ack.mock.calls.length === 1)).toBe(true);
    expect(relay.sent).toEqual(
      [phone, tablet, otherAccountOnPhone].map((destination) =>
        expect.objectContaining({
          authorization: `Bearer ${destination.relay_token}`,
          body: expect.objectContaining({ route_id: destination.route_id }),
        }),
      ),
    );
    const [firstJob, secondJob, thirdJob] = relay.queued.map((job) => XJobSchema.parse(job));
    expect(firstJob?.event.event_id).toBe(secondJob?.event.event_id);
    expect(firstJob?.event.event_id).not.toBe(thirdJob?.event.event_id);
  });

  it("資格情報を変えた端末への古いjobだけを破棄する", async () => {
    const relay = fakeRelay();
    await post(event(), { environment: environment(), relay });
    const jobs = relay.queued.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
    await handleXQueue(
      jobs,
      environment({ [recipient]: [phone, { ...tablet, relay_token: `tsr_${"C".repeat(43)}` }] }),
      relay.deps,
    );
    expect(jobs.every((job) => job.ack.mock.calls.length === 1)).toBe(true);
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]?.body).toMatchObject({ route_id: phone.route_id });
  });

  it("複数配送先へ切り替えても、切り替え前の通知を元の端末だけに届ける", async () => {
    const relay = fakeRelay();
    const legacy = testEnv({ ENABLE_X_ACTIVITY: "true", RELAY_TOKEN: phone.relay_token });
    expect((await post(event(), { environment: legacy, relay })).status).toBe(200);
    expect(relay.queued).toHaveLength(1);
    const body = XJobSchema.parse(relay.queued[0]);
    expect(body.event).not.toHaveProperty("route_id");

    const original = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleXQueue([original], environment(), relay.deps);
    expect(original.ack).toHaveBeenCalledOnce();
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]).toMatchObject({
      authorization: `Bearer ${phone.relay_token}`,
      body: { event_id: body.event.event_id, route_id: phone.route_id },
    });

    const removed = { body, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await handleXQueue(
      [removed],
      environment({ [recipient]: [tablet], [other]: [otherAccountOnPhone] }),
      relay.deps,
    );
    expect(removed.ack).toHaveBeenCalledOnce();
    expect(relay.sent).toHaveLength(1);
  });

  it("曖昧な配送先を拒み、公開試験中は試験専用の送り先だけを使う", async () => {
    const relay = fakeRelay();
    for (const value of [
      {},
      { [recipient]: [] },
      { [recipient]: [phone, { ...tablet, route_id: phone.route_id }] },
      { [recipient]: [phone, { ...tablet, relay_token: phone.relay_token }] },
    ]) {
      expect((await post(event(), { environment: environment(value), relay })).status).toBe(500);
    }
    expect(relay.queued).toEqual([]);
    const trial = testEnv({
      ENABLE_X_ACTIVITY: "true",
      X_RELAY_ROUTES: JSON.stringify(routes),
      PUBLIC_RELAY_TRIAL_UNTIL: String(Date.now() + 60_000),
      PUBLIC_RELAY_TRIAL_ORIGIN: "https://public.example",
      PUBLIC_RELAY_TRIAL_TOKEN: `tsr_${"Z".repeat(43)}`,
    });
    expect(await (await post(event(), { environment: trial, relay })).json()).toEqual({
      counts: { queued: 1 },
    });
    const jobs = relay.queued.map((body) => ({ body, attempts: 1, ack: vi.fn(), retry: vi.fn() }));
    await handleXQueue(jobs, trial, relay.deps);
    expect(relay.sent).toHaveLength(1);
    expect(relay.sent[0]).toMatchObject({
      url: "https://public.example/v1/notifications",
      authorization: `Bearer ${trial.PUBLIC_RELAY_TRIAL_TOKEN}`,
    });
    expect(relay.sent[0]?.body).not.toHaveProperty("route_id");
  });
});
