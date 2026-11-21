import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, test, vi } from "vitest";
import { PairingStore } from "../src/pairing-store";
import { type Authorization, refreshAuthorization } from "../src/x-oauth";
import { testEnv } from "./helpers";

const user = "1111111111111111111";
const configured = () =>
  testEnv({
    ENABLE_X_ACTIVITY: "true",
    ALLOWED_X_USER_IDS: user,
    X_OAUTH2_CLIENT_ID: "test-client",
    RELAY_TOKEN: "",
    X_USER_ID: "",
  });
const grant = (): Authorization => ({
  refreshToken: "test-old-refresh",
  scopes: ["tweet.read", "users.read", "offline.access"],
  expiresAt: Date.now() + 30 * 60_000,
  next: Date.now() - 1,
  failures: 0,
});
const reply = () => ({
  access_token: "test-new-access",
  refresh_token: "test-new-refresh",
  token_type: "bearer",
  expires_in: 7200,
  scope: grant().scopes.join(" "),
});
const stub = () => {
  const found = testEnv().PAIRING_ROUTES?.getByName("oauth-tests");
  if (!found) throw new Error("Missing test store");
  return found;
};
afterEach(async () => {
  vi.restoreAllMocks();
  await runInDurableObject(stub(), (_, state) => state.storage.deleteAll());
});

test("refresh uses the fixed token endpoint without redirects and rotates the refresh token", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(reply()));
  const now = Date.now();
  const result = await refreshAuthorization(grant(), configured());
  expect(result.kind).toBe("refreshed");
  if (result.kind !== "refreshed") throw new Error("Not refreshed");
  expect(result.grant.refreshToken).toBe("test-new-refresh");
  expect(result.grant.next).toBeGreaterThanOrEqual(now + 90 * 60_000);
  expect(result.grant.expiresAt).toBeGreaterThanOrEqual(now + 120 * 60_000);
  expect(result.grant).not.toHaveProperty("accessToken");
  const [url, init] = fetch.mock.calls[0] ?? [];
  expect(url).toBe("https://api.x.com/2/oauth2/token");
  expect(init?.redirect).toBe("manual");
  expect(new URLSearchParams(String(init?.body)).get("refresh_token")).toBe("test-old-refresh");
});

test.each([429, 503, 302])("HTTP %i retains the grant for retry", async (status) => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("", { status }));
  expect(await refreshAuthorization(grant(), configured())).toEqual({ kind: "retry" });
});

test("invalid_grant requires reauthorization", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );
  expect(await refreshAuthorization(grant(), configured())).toEqual({ kind: "reauthorize" });
});

test("a successful response with missing scopes must not reuse an invalidated refresh token", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    Response.json({ ...reply(), scope: "users.read" }),
  );
  expect(await refreshAuthorization(grant(), configured())).toEqual({ kind: "reauthorize" });
});

test("the Durable Object persists rotation once and skips an overlapping run", async () => {
  const fetch = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => Response.json(reply()));
  await runInDurableObject(stub(), async (_, state) => {
    state.storage.kv.put("pairing", { codes: [], routes: [{ recipient: user }] });
    state.storage.kv.put("x_authorizations", { [user]: grant() });
    const store = new PairingStore(state, configured());
    await Promise.all([store.refreshAuthorizations(), store.refreshAuthorizations()]);
    const saved = state.storage.kv.get<Record<string, Authorization>>("x_authorizations");
    expect(saved?.[user]?.refreshToken).toBe("test-new-refresh");
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("the Durable Object removes unused grants without making an X request", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  await runInDurableObject(stub(), async (_, state) => {
    state.storage.kv.put("x_authorizations", { [user]: grant() });
    await new PairingStore(state, configured()).refreshAuthorizations();
    expect(state.storage.kv.get("x_authorizations")).toEqual({});
  });
  expect(fetch).not.toHaveBeenCalled();
});

test("the Durable Object backs off on failure and does not retry before the next run", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
  await runInDurableObject(stub(), async (_, state) => {
    state.storage.kv.put("pairing", { codes: [], routes: [{ recipient: user }] });
    state.storage.kv.put("x_authorizations", { [user]: grant() });
    const store = new PairingStore(state, configured());
    await store.refreshAuthorizations();
    await store.refreshAuthorizations();
    const saved = state.storage.kv.get<Record<string, Authorization>>("x_authorizations");
    expect(saved?.[user]?.refreshToken).toBe("test-old-refresh");
    expect(saved?.[user]?.failures).toBe(1);
    expect(saved?.[user]?.next).toBeGreaterThan(Date.now());
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("an in-flight refresh does not block reads or overwrite a later reconnection", async () => {
  let finish: ((response: Response) => void) | undefined;
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await runInDurableObject(stub(), async (_, state) => {
    state.storage.kv.put("pairing", {
      codes: [],
      routes: [{ recipient: user, eventTypes: ["mention"] }],
    });
    state.storage.kv.put("x_authorizations", { [user]: grant() });
    const store = new PairingStore(state, configured());
    const pending = store.refreshAuthorizations();
    expect(store.authorizationScopes(user)).toContain("offline.access");
    expect(
      store.saveAuthorization(user, { ...grant(), refreshToken: "test-reconnected-refresh" }),
    ).toBe(true);
    if (!finish) throw new Error("No pending refresh");
    finish(Response.json(reply()));
    await pending;
    expect(
      state.storage.kv.get<Record<string, Authorization>>("x_authorizations")?.[user]?.refreshToken,
    ).toBe("test-reconnected-refresh");
  });
  expect(fetch).toHaveBeenCalledTimes(1);
});

test("a narrower reconnection cannot replace an existing DM authorization", async () => {
  await runInDurableObject(stub(), (_, state) => {
    state.storage.kv.put("x_authorizations", {
      [user]: { ...grant(), scopes: [...grant().scopes, "dm.read"] },
    });
    const store = new PairingStore(state, configured());
    expect(store.saveAuthorization(user, grant())).toBe(false);
    expect(store.authorizationScopes(user)).toContain("dm.read");
  });
});
