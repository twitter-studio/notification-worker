import { env } from "cloudflare:workers";
import { handle } from "../src/app";

/** テストの環境 (vitest.config.ts の値)。`overrides` で一部を変える。 */
export function testEnv(overrides: Partial<Env> = {}): Env {
  return { ...env, ...overrides };
}

/** 模擬の Webhook の署名のヘッダー。 */
export async function signedHeaders(
  body: string | Uint8Array,
  options: { secret?: string; timestamp?: number } = {},
): Promise<Record<string, string>> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(options.secret ?? env.MOCK_WEBHOOK_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const prefix = new TextEncoder().encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.length + bytes.length);
  signed.set(prefix);
  signed.set(bytes, prefix.length);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  const hex = Array.from(mac, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return {
    "Content-Type": "application/json",
    "X-Mock-Timestamp": timestamp,
    "X-Mock-Signature": `sha256=${hex}`,
  };
}

type Sent = {
  url: string;
  authorization: string | null;
  redirect: RequestInit["redirect"];
  body: unknown;
};

/**
 * 中継の API の代わり。送られた要求を記録し、`responses` を順に返す (足りなければ 202 の accepted)。
 * `Error` を入れると、つながらなかったことにする。
 */
export function fakeRelay(responses: (Response | Error)[] = []) {
  const sent: Sent[] = [];
  const sleeps: number[] = [];
  const queued: unknown[] = [];
  const deps = {
    enqueueX: async (job: unknown) => {
      queued.push(job);
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      sent.push({
        url: request.url,
        authorization: request.headers.get("Authorization"),
        redirect: init?.redirect ?? "follow",
        body: await request.json(),
      });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return next ?? Response.json({ status: "accepted" }, { status: 202 });
    }) as typeof fetch,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  };
  return { deps, sent, sleeps, queued };
}

export function mockEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: `event-${crypto.randomUUID()}`,
    kind: "mention",
    post_id: "1234567890123456789",
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

/** 模擬の Webhook を送る。 */
export async function postMock(
  payload: unknown,
  options: {
    env?: Env;
    deps?: ReturnType<typeof fakeRelay>["deps"];
    headers?: Record<string, string>;
    rawBody?: string | Uint8Array;
  } = {},
) {
  const body = options.rawBody ?? JSON.stringify(payload);
  const headers = options.headers ?? (await signedHeaders(body));
  return handle(
    new Request("https://worker.test/webhooks/mock", { method: "POST", headers, body }),
    options.env ?? testEnv(),
    options.deps ?? fakeRelay().deps,
  );
}
