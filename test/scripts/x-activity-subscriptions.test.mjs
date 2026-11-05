import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { manageSubscriptions } from "../../scripts/x-activity-subscriptions.mjs";

const instant = Date.parse("2026-11-06T00:00:00Z");
const first = "2026-11-07T00:00:00Z";
const next = "2026-11-08T00:00:00Z";
const config = {
  user_id: "123",
  username: "synthetic",
  webhook_id: "456",
  webhook_url: "https://synthetic.example.workers.dev/webhooks/x",
};
const endpoint = "/2/activity/subscriptions";

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "activity-subscriptions-test-"));
  chmodSync(directory, 0o700);
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const save = (name, value) =>
    writeFileSync(
      join(directory, name),
      typeof value === "string" ? value : JSON.stringify(value),
      { mode: 0o600 },
    );
  save("activity-setup.json", config);
  save("app-bearer-token.txt", "synthetic-app");
  save("client-id.txt", "synthetic-client");
  const token = {
    access_token: "synthetic-user",
    client_id: "synthetic-client",
    token_type: "bearer",
    scope: "tweet.read users.read",
    expires_at: instant + 7200_000,
  };
  save("user-token.json", token);

  const subscriptions = [];
  const mutations = [];
  let id = 700;
  const controls = {
    user: "123",
    hook: config.webhook_url,
    lose: "",
    pages: false,
    loop: false,
    hide: false,
    missingHook: false,
    rejectReply: false,
    loseReply: false,
    delayed: null,
    now: instant,
    expireOnList: false,
  };
  const fetchImpl = async (url, init) => {
    const path = new URL(url);
    assert.equal(path.origin, "https://api.x.com");
    assert.equal(init.redirect, "error");
    const userContext = init.method === "POST" || path.pathname === "/2/users/me";
    assert.equal(init.headers.Authorization, `Bearer synthetic-${userContext ? "user" : "app"}`);
    if (path.pathname === "/2/users/me")
      return Response.json({ data: { id: controls.user, username: "synthetic" } });
    if (path.pathname === "/2/webhooks")
      return Response.json({
        data: controls.missingHook ? [] : [{ id: "456", url: controls.hook, valid: true }],
      });
    if (init.method === "GET") {
      assert.equal(path.pathname, endpoint);
      assert.equal(path.searchParams.get("user_id"), "123");
      if (controls.expireOnList) controls.now = token.expires_at;
      const cursor = path.searchParams.get("pagination_token");
      if (controls.hide) return Response.json({ data: [], meta: { result_count: 0 } });
      const page =
        controls.pages && !cursor
          ? subscriptions.slice(0, 1)
          : cursor
            ? subscriptions.slice(1)
            : subscriptions;
      return Response.json({
        data: page,
        meta: {
          result_count: page.length,
          ...((controls.pages && !cursor) || controls.loop ? { next_token: "test-page" } : {}),
        },
      });
    }
    mutations.push(init.method);
    if (init.method === "POST") {
      assert.equal(path.pathname, endpoint);
      const body = JSON.parse(init.body);
      if (body.event_type === "post.reply.create" && controls.rejectReply)
        return Response.json({}, { status: 403 });
      if (body.event_type === "post.reply.create" && controls.loseReply) {
        controls.delayed = { subscription_id: String(++id), ...body };
        throw new Error("request outcome pending");
      }
      const row = subscriptions.find((row) => row.event_type === body.event_type);
      const result = { subscription_id: row?.subscription_id ?? String(++id), ...body };
      if (row) Object.assign(row, result);
      else subscriptions.push(result);
      if (controls.lose === "POST") {
        controls.lose = "";
        throw new Error("lost create or renew response");
      }
      return Response.json({ data: { subscription: result } });
    }
    assert.equal(init.method, "DELETE");
    const index = subscriptions.findIndex(
      (row) => path.pathname === `${endpoint}/${row.subscription_id}`,
    );
    assert.notEqual(index, -1);
    subscriptions.splice(index, 1);
    if (controls.lose === "DELETE") {
      controls.lose = "";
      throw new Error("lost delete response");
    }
    return Response.json({ data: { deleted: true } });
  };
  return {
    controls,
    mutations,
    subscriptions,
    save,
    token,
    run: (command, expiresAt, confirmed = true) =>
      manageSubscriptions({
        command,
        directory,
        expiresAt,
        confirmed,
        fetchImpl,
        now: () => controls.now,
      }),
  };
}

test("作成・延長・解除で本人の二つの購読と全ページを照合する", async (t) => {
  const f = fixture(t);
  f.controls.pages = true;
  assert.deepEqual(await f.run("start", first), {
    status: "active",
    subscriptions: 2,
    expires_at: first,
  });
  const ids = f.subscriptions.map(({ subscription_id }) => subscription_id);
  assert.deepEqual(await f.run("renew", next), {
    status: "active",
    subscriptions: 2,
    expires_at: next,
  });
  assert.deepEqual(
    f.subscriptions.map(({ subscription_id }) => subscription_id),
    ids,
  );
  assert.deepEqual(await f.run("stop"), { status: "stopped", subscriptions: 0 });
  assert.deepEqual(f.mutations, ["POST", "POST", "POST", "POST", "DELETE", "DELETE"]);
});

test("作成・延長・解除の応答を失っても、再実行で残りだけを操作する", async (t) => {
  const f = fixture(t);
  for (const [command, expiry, method] of [
    ["start", first, "POST"],
    ["renew", next, "POST"],
    ["stop", undefined, "DELETE"],
  ]) {
    f.controls.lose = method;
    await assert.rejects(f.run(command, expiry), { message: "activity_session_failed" });
    await f.run(command, expiry);
  }
  assert.deepEqual(f.mutations, ["POST", "POST", "POST", "POST", "DELETE", "DELETE"]);
  assert.equal(f.subscriptions.length, 0);
});

test("本人・Webhook・認可期限・明示確認が合わなければ変更しない", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("start", first, false));
  f.controls.user = "999";
  await assert.rejects(f.run("start", first));
  f.controls.user = "123";
  f.controls.hook = "https://other.example.workers.dev/webhooks/x";
  await assert.rejects(f.run("start", first));
  f.controls.hook = config.webhook_url;
  f.save("user-token.json", { ...f.token, expires_at: instant });
  await assert.rejects(f.run("start", first));
  assert.deepEqual(f.mutations, []);
});

test("別の管理者の購読や不完全な一覧があれば作成しない", async (t) => {
  const f = fixture(t);
  f.subscriptions.push({
    subscription_id: "999",
    event_type: "post.mention.create",
    filter: { user_id: "123" },
    webhook_id: "999",
    tag: "unrelated",
  });
  await assert.rejects(f.run("start", first));
  f.subscriptions.length = 0;
  f.controls.loop = true;
  await assert.rejects(f.run("start", first));
  assert.deepEqual(f.mutations, []);
});

test("無期限は明示時だけ作成でき、保存した購読IDの照合が崩れたら解除しない", async (t) => {
  const f = fixture(t);
  await assert.rejects(f.run("start"));
  await f.run("start", null);
  assert.ok(f.subscriptions.every((row) => !("expires_at" in row)));
  f.subscriptions[0].webhook_id = "999";
  await assert.rejects(f.run("stop"));
  assert.deepEqual(f.mutations, ["POST", "POST"]);
});

test("応答不明の無期限購読が一覧へ現れるまで停止済みにしない", async (t) => {
  const f = fixture(t);
  f.controls.lose = "POST";
  await assert.rejects(f.run("start", null));
  f.controls.hide = true;
  await assert.rejects(f.run("stop"));
  await assert.rejects(f.run("start", null));
  assert.deepEqual(f.mutations, ["POST"]);
  f.controls.hide = false;
  f.controls.missingHook = true;
  assert.deepEqual(await f.run("stop"), { status: "stopped", subscriptions: 0 });
  assert.deepEqual(f.mutations, ["POST", "DELETE"]);
});

test("片方の応答が不明でも、照合済みの別の購読を解除する", async (t) => {
  const f = fixture(t);
  f.controls.loseReply = true;
  await assert.rejects(f.run("start", null));
  await assert.rejects(f.run("stop"));
  assert.equal(f.subscriptions.length, 0);
  f.subscriptions.push(f.controls.delayed);
  assert.deepEqual(await f.run("stop"), { status: "stopped", subscriptions: 0 });
  assert.deepEqual(f.mutations, ["POST", "POST", "DELETE", "DELETE"]);
});

test("作成が明示的に拒否されたときは、既存分の解除を完了できる", async (t) => {
  const f = fixture(t);
  f.controls.rejectReply = true;
  await assert.rejects(f.run("start", null));
  assert.deepEqual(await f.run("stop"), { status: "stopped", subscriptions: 0 });
  assert.deepEqual(f.mutations, ["POST", "POST", "DELETE"]);
});

test("一覧取得中に本人認可が期限切れになっても未送信の購読を保留しない", async (t) => {
  const f = fixture(t);
  f.controls.expireOnList = true;
  await assert.rejects(f.run("start", null));
  assert.deepEqual(f.mutations, []);
  assert.deepEqual(await f.run("stop"), { status: "stopped", subscriptions: 0 });
});
