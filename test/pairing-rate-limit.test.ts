import { env as workerEnv } from "cloudflare:workers";
import { describe, expect, test, vi } from "vitest";
import { handle } from "../src/app";
import { fakeRelay, testEnv } from "./helpers";

declare global {
  namespace Cloudflare {
    interface Env {
      PAIRING_TEST_LIMITER: RateLimit;
    }
  }
}

const admin = `tpa_${"A".repeat(43)}`;
const challenge = {
  x_user_id: "1111111111111111111",
  route_id: "00000000-0000-4000-8000-000000000093",
  lookup: "a".repeat(64),
  nonce: "b".repeat(64),
  management_hash: "c".repeat(64),
};
function request(path: string, ip = "2001:db8:93:1::1", method = "POST") {
  return new Request(`https://worker.test${path}`, {
    method,
    headers: { "CF-Connecting-IP": ip },
    ...(method === "POST" ? { body: JSON.stringify(challenge) } : {}),
  });
}

describe("接続用APIの認証前の回数制限", () => {
  test("拒否したchallengeはDurable Objectの処理に到達しない", async () => {
    const env = testEnv({ PAIRING_ADMIN_TOKEN: admin });
    const namespace = env.PAIRING_ROUTES;
    expect(namespace).toBeDefined();
    if (!namespace) return;
    const stub = namespace.getByName("routes");
    const reserve = vi.spyOn(stub, "reserveCode");
    const get = vi.spyOn(namespace, "getByName").mockReturnValue(stub);
    try {
      const limit = vi.fn(async () => ({ success: false }));
      const result = await handle(
        request("/v1/pairing/challenge"),
        { ...env, CONNECT_LIMITER: { limit } },
        fakeRelay().deps,
      );
      expect(result.status).toBe(429);
      expect(result.headers.get("Retry-After")).toBe("60");
      expect(limit).toHaveBeenCalledWith({ key: "pairing:2001:db8:93:1::/64" });
      expect(reserve).not.toHaveBeenCalled();
    } finally {
      get.mockRestore();
      reserve.mockRestore();
    }
  });

  test.each([
    "/v1/pairing",
    "/v1/pairing/challenge",
    "/v1/pairing/settings",
    "/v1/pairing/disconnect",
    "/v1/pairing/routes",
    "/v1/pairing/codes",
    "/v1/pairing/revoke",
    "/v1/pairing/dm-preview/start",
    "/v1/pairing/dm-preview/status",
  ])("%sも同じ制限で止まる", async (path) => {
    const response = await handle(
      request(path),
      testEnv({
        PAIRING_ADMIN_TOKEN: admin,
        CONNECT_LIMITER: { limit: async () => ({ success: false }) },
      }),
      fakeRelay().deps,
    );
    expect(response.status).toBe(429);
  });

  test("実際のbindingで繰り返した不正なchallengeを止め、別の接続元は通す", async () => {
    const env = testEnv({
      PAIRING_ADMIN_TOKEN: admin,
      CONNECT_LIMITER: workerEnv.PAIRING_TEST_LIMITER,
    });
    let limited = false;
    for (let i = 0; i < 21; i++) {
      const result = await handle(
        request("/v1/pairing/challenge", "192.0.2.193"),
        env,
        fakeRelay().deps,
      );
      if (result.status === 429) {
        limited = true;
        break;
      }
      expect(result.status).toBe(401);
    }
    expect(limited).toBe(true);
    expect(
      (await handle(request("/v1/pairing/challenge", "192.0.2.194"), env, fakeRelay().deps)).status,
    ).toBe(401);
  });

  test("制限が未設定なら503で止まり、GETの版確認も制限する", async () => {
    const env = testEnv({ PAIRING_ADMIN_TOKEN: admin });
    Reflect.deleteProperty(env, "CONNECT_LIMITER");
    expect((await handle(request("/v1/pairing/challenge"), env, fakeRelay().deps)).status).toBe(
      503,
    );
    const limit = vi.fn(async () => ({ success: false }));
    expect(
      (
        await handle(
          request("/v1/pairing", "192.0.2.93", "GET"),
          { ...env, CONNECT_LIMITER: { limit } },
          fakeRelay().deps,
        )
      ).status,
    ).toBe(429);
  });
});
