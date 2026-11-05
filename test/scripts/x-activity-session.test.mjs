import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ActivityFailure, planSession, runSession } from "../../scripts/x-activity-session.mjs";

const instant = Date.parse("2026-11-05T00:00:00Z");
const config = {
  user_id: "123",
  username: "synthetic",
  webhook_id: "456",
  webhook_url: "https://synthetic.example.workers.dev/webhooks/x",
};
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "activity-test-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const save = (name, value) =>
    writeFileSync(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  save("activity-setup.json", config);
  save("activity-approval.json", {
    live_x_api: true,
    dedicated_app: true,
    expires_at: new Date(instant + 60 * 60_000).toISOString(),
    billing_checked_at: new Date(instant).toISOString(),
    cycle_cap_usd: 1,
    auto_recharge: false,
  });
  save("app-bearer-token.txt", "synthetic-app-secret");
  save("client-id.txt", "synthetic-client");
  save("user-token.json", {
    access_token: "synthetic-user-secret",
    client_id: "synthetic-client",
    token_type: "bearer",
    scope: "tweet.read users.read",
    expires_at: instant + 7200_000,
  });
  return {
    directory,
    save,
    state: () => JSON.parse(readFileSync(join(directory, "activity-session.json"), "utf8")),
  };
}
function server(options = {}) {
  let subscriptions = [];
  const calls = [];
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.x.com");
    assert.equal(init.redirect, "error");
    assert.equal(
      init.headers.Authorization,
      `Bearer ${init.method === "POST" || parsed.pathname === "/2/users/me" ? "synthetic-user-secret" : "synthetic-app-secret"}`,
    );
    calls.push({ method: init.method, path: parsed.pathname });
    if (options.intercept) {
      const intercepted = await options.intercept({ url: parsed, init, calls, subscriptions });
      if (intercepted) return intercepted;
    }
    if (parsed.pathname === "/2/usage/credits")
      return Response.json({ data: { total_balance: options.balance ?? 2 } });
    if (parsed.pathname === "/2/users/me")
      return Response.json({ data: { id: options.user ?? "123", username: "synthetic" } });
    if (parsed.pathname === "/2/webhooks" && init.method === "GET") {
      assert.equal(parsed.searchParams.get("webhook_config.fields"), "id,url,valid");
      return Response.json({ data: [{ id: "456", url: config.webhook_url, valid: !options.crc }] });
    }
    if (parsed.pathname === "/2/webhooks/456" && init.method === "PUT")
      return Response.json({ data: { valid: true } });
    if (init.method === "GET") {
      assert.equal(parsed.pathname, "/2/activity/subscriptions");
      return Response.json({ data: subscriptions, meta: { result_count: subscriptions.length } });
    }
    if (init.method === "POST") {
      const body = JSON.parse(init.body);
      assert.deepEqual(body.filter, { user_id: "123" });
      assert.equal(Date.parse(body.expires_at), instant + 30 * 60_000);
      const row = { subscription_id: String(700 + subscriptions.length), ...body };
      subscriptions.push(row);
      if (options.lostCreate && subscriptions.length === 1)
        throw new Error("synthetic-secret-network-error");
      return Response.json({ data: { subscription: row } });
    }
    if (init.method === "DELETE") {
      subscriptions = subscriptions.filter(
        (row) => !parsed.pathname.endsWith(`/${row.subscription_id}`),
      );
      return Response.json({ data: { deleted: true } });
    }
    assert.fail("unexpected endpoint");
  };
  return { fetchImpl, calls, rows: () => subscriptions };
}
function run(fixture, remote, extra = {}) {
  return runSession({
    directory: fixture.directory,
    fetchImpl: remote.fetchImpl,
    now: () => instant,
    wait: async () => {},
    ...extra,
  });
}
function publicOutput(value) {
  const output = JSON.stringify(value);
  for (const forbidden of ["synthetic", "123", "456", "700", "secret", "Bearer", "workers.dev"])
    assert.equal(output.includes(forbidden), false);
}

test("planは秘密・承認・通信なしで上限だけを返す", (t) => {
  const f = fixture(t);
  rmSync(join(f.directory, "app-bearer-token.txt"));
  rmSync(join(f.directory, "activity-approval.json"));
  const plan = planSession(f.directory);
  assert.equal(plan.network_requests, 0);
  publicOutput(plan);
  assert.equal(existsSync(join(f.directory, "activity-session.json")), false);
});
test("本人・残高・Webhookを確かめ期限付き2購読を削除し不在を確認する", async (t) => {
  const f = fixture(t),
    remote = server();
  const ready = [];
  const result = await run(f, remote, { onReady: (value) => ready.push(value) });
  assert.equal(ready[0].subscriptions, 2);
  assert.equal(result.status, "cleaned");
  assert.equal(result.subscriptions_removed, 2);
  assert.equal(result.requests, remote.calls.length);
  assert.ok(remote.calls.length <= 20);
  assert.equal(remote.rows().length, 0);
  assert.equal(f.state().cleaned, true);
  assert.equal(lstatSync(join(f.directory, "activity-session.json")).mode & 0o077, 0);
  assert.equal(existsSync(join(f.directory, "activity-session.lock")), false);
  publicOutput([ready, result]);
  await assert.rejects(run(f, remote), ActivityFailure);
});
test("CRCが無効なら対象だけを再検証する", async (t) => {
  const f = fixture(t),
    remote = server({ crc: true });
  await run(f, remote);
  assert.equal(remote.calls.filter((call) => call.method === "PUT").length, 1);
});
for (const [name, mutate] of [
  ["承認なし", (f) => rmSync(join(f.directory, "activity-approval.json"))],
  ["有効でない承認", (f) => f.save("activity-approval.json", { live_x_api: false })],
  ["別clientのtoken", (f) => f.save("client-id.txt", "other-client")],
  [
    "token期限不足",
    (f) => {
      const token = JSON.parse(readFileSync(join(f.directory, "user-token.json")));
      token.expires_at = instant;
      f.save("user-token.json", token);
    },
  ],
  ["秘密が公開権限", (f) => chmodSync(join(f.directory, "app-bearer-token.txt"), 0o644)],
  ["ディレクトリが公開権限", (f) => chmodSync(f.directory, 0o755)],
  [
    "秘密がsymlink",
    (f) => {
      rmSync(join(f.directory, "app-bearer-token.txt"));
      symlinkSync(join(f.directory, "client-id.txt"), join(f.directory, "app-bearer-token.txt"));
    },
  ],
  ["既存lock", (f) => f.save("activity-session.lock", "999999")],
])
  test(`${name}ではAPIを呼ばない`, async (t) => {
    const f = fixture(t),
      remote = server();
    mutate(f);
    await assert.rejects(run(f, remote), ActivityFailure);
    assert.equal(remote.calls.length, 0);
  });
for (const [name, options] of [
  ["残高不足", { balance: 0.5 }],
  ["本人不一致", { user: "999" }],
  [
    "既存購読",
    {
      intercept: ({ url, init }) =>
        url.pathname === "/2/activity/subscriptions" && init.method === "GET"
          ? Response.json({
              data: [
                {
                  subscription_id: "999",
                  event_type: "post.mention.create",
                  filter: { user_id: "123" },
                },
              ],
            })
          : undefined,
    },
  ],
  [
    "一覧が途中",
    {
      intercept: ({ url, init }) =>
        url.pathname === "/2/activity/subscriptions" && init.method === "GET"
          ? Response.json({ data: [], meta: { next_token: "synthetic-next" } })
          : undefined,
    },
  ],
  [
    "HTTP200内のerrors",
    { intercept: () => Response.json({ errors: [{ detail: "synthetic-secret" }] }) },
  ],
  ["大きすぎる応答", { intercept: () => new Response("x".repeat(65537)) }],
  ["リダイレクト応答", { intercept: () => new Response(null, { status: 302 }) }],
])
  test(`${name}では購読を作らない`, async (t) => {
    const f = fixture(t),
      remote = server(options);
    await assert.rejects(run(f, remote), ActivityFailure);
    assert.equal(
      remote.calls.some((call) => call.method === "POST"),
      false,
    );
  });
test("作成の応答を失ってもtagで発見して解除する", async (t) => {
  const f = fixture(t),
    remote = server({ lostCreate: true });
  await assert.rejects(run(f, remote), ActivityFailure);
  assert.equal(remote.rows().length, 0);
  assert.equal(f.state().cleaned, true);
});
test("待機中の中断でも購読を残さない", async (t) => {
  const f = fixture(t),
    remote = server(),
    controller = new AbortController();
  await run(f, remote, {
    signal: controller.signal,
    onReady: () => controller.abort(),
    wait: undefined,
  });
  assert.equal(remote.rows().length, 0);
});
test("recoverは期限切れの本人token・承認がなくても保存済み範囲だけ解除する", async (t) => {
  const f = fixture(t),
    remote = server();
  await assert.rejects(
    run(f, remote, {
      onReady: () => {
        throw new Error("interrupt");
      },
      fetchImpl: async (url, init) => {
        if (init.method === "DELETE") throw new Error("offline");
        return remote.fetchImpl(url, init);
      },
    }),
    ActivityFailure,
  );
  assert.equal(f.state().cleaned, false);
  rmSync(join(f.directory, "user-token.json"));
  rmSync(join(f.directory, "activity-approval.json"));
  const callsBefore = remote.calls.length;
  const result = await run(f, remote, { recover: true });
  assert.equal(result.status, "cleaned");
  assert.equal(remote.rows().length, 0);
  assert.ok(
    remote.calls
      .slice(callsBefore)
      .every(
        (call) =>
          call.method === "DELETE" ||
          (call.method === "GET" && call.path === "/2/activity/subscriptions"),
      ),
  );
});
test("recoverでも累積20要求を超えず、解除未確認を成功としない", async (t) => {
  const f = fixture(t),
    remote = server({ lostCreate: true });
  await assert.rejects(run(f, remote), ActivityFailure);
  const state = f.state();
  state.requests = 20;
  state.cleaned = false;
  f.save("activity-session.json", state);
  const before = remote.calls.length;
  await assert.rejects(run(f, remote, { recover: true }), ActivityFailure);
  assert.equal(remote.calls.length, before);
});

test("途中で承認期限を過ぎたら新しい購読を作らず、作成済みだけ解除する", async (t) => {
  const f = fixture(t);
  let current = instant;
  const remote = server({
    intercept: ({ init }) => {
      if (init.method === "POST") current = instant + 61 * 60_000;
    },
  });
  await assert.rejects(run(f, remote, { now: () => current }), ActivityFailure);
  assert.equal(remote.calls.filter((call) => call.method === "POST").length, 1);
  assert.equal(remote.rows().length, 0);
  assert.equal(f.state().cleaned, true);
});

test("今回のtag以外の購読を解除しない", async (t) => {
  const f = fixture(t);
  let added = false;
  const remote = server({
    intercept: ({ init, subscriptions }) => {
      if (init.method === "GET" && subscriptions.length === 2 && !added) {
        subscriptions.push({
          subscription_id: "999",
          event_type: "post.mention.create",
          filter: { user_id: "123" },
          webhook_id: "456",
          tag: "other-session",
        });
        added = true;
      }
    },
  });
  await assert.rejects(run(f, remote), ActivityFailure);
  assert.deepEqual(
    remote.rows().map((row) => row.subscription_id),
    ["999"],
  );
  assert.equal(f.state().cleaned, true);
});

test("30分の購読期限が承認範囲をはみ出す場合は作成しない", async (t) => {
  const f = fixture(t);
  let current = instant;
  const remote = server({
    intercept: ({ url }) => {
      if (url.pathname === "/2/activity/subscriptions") current = instant + 40 * 60_000;
    },
  });
  await assert.rejects(run(f, remote, { now: () => current }), ActivityFailure);
  assert.equal(
    remote.calls.some((call) => call.method === "POST"),
    false,
  );
});
