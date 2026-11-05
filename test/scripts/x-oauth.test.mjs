import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { OAuthFailure, runOAuth } from "../../scripts/x-oauth.mjs";

const clientID = "synthetic-id";
const secret = "synthetic-private-client-secret";
const tokenValue = "synthetic-private-access-token";
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "x-oauth-test-"));
  chmodSync(directory, 0o700);
  writeFileSync(join(directory, "client-id.txt"), clientID, { mode: 0o600 });
  writeFileSync(join(directory, "client-secret.txt"), secret, { mode: 0o600 });
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
function success() {
  return Response.json({
    access_token: tokenValue,
    token_type: "bearer",
    expires_in: 7200,
    scope: "users.read tweet.read",
    private_extra: secret,
  });
}
function callback(ready, values = {}) {
  const url = new URL(ready.callbackURL);
  url.search = new URLSearchParams({
    state: new URL(ready.authorizeURL).searchParams.get("state"),
    code: "synthetic-code",
    ...values,
  });
  return url;
}
function noSecrets(value) {
  const text = JSON.stringify(value);
  for (const item of [clientID, secret, tokenValue, "synthetic-code"])
    assert.equal(text.includes(item), false);
}

test("S256・最小scope・固定endpointで交換し、tokenだけを0600で保存する", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  let authorization;
  const result = await runOAuth({
    directory,
    port: 0,
    fetchImpl: async (url, init) => {
      calls++;
      assert.equal(url, "https://api.x.com/2/oauth2/token");
      assert.equal(init.redirect, "error");
      assert.equal(init.method, "POST");
      assert.equal(
        init.headers.Authorization,
        `Basic ${Buffer.from(`${clientID}:${secret}`).toString("base64")}`,
      );
      const form = init.body;
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("code"), "synthetic-code");
      assert.equal(form.get("redirect_uri"), authorization.searchParams.get("redirect_uri"));
      assert.equal(
        createHash("sha256").update(form.get("code_verifier")).digest("base64url"),
        authorization.searchParams.get("code_challenge"),
      );
      return success();
    },
    onReady: async (ready) => {
      authorization = new URL(ready.authorizeURL);
      assert.equal(authorization.origin, "https://x.com");
      assert.equal(authorization.searchParams.get("scope"), "tweet.read users.read");
      assert.equal(authorization.searchParams.get("code_challenge_method"), "S256");
      assert.equal(lstatSync(ready.htmlPath).mode & 0o077, 0);
      assert.equal(readFileSync(ready.htmlPath, "utf8").includes(secret), false);
      const response = await fetch(callback(ready));
      const body = await response.text();
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
      assert.equal(body.includes(tokenValue), false);
      assert.equal(body.includes("synthetic-code"), false);
      assert.match(body, /history.replaceState/);
    },
  });
  assert.equal(calls, 1);
  const saved = JSON.parse(readFileSync(result.tokenPath, "utf8"));
  assert.equal(saved.access_token, tokenValue);
  assert.equal(saved.client_id, clientID);
  assert.equal(saved.scope, "tweet.read users.read");
  assert.equal(saved.refresh_token, undefined);
  assert.equal(saved.client_secret, undefined);
  assert.equal(lstatSync(result.tokenPath).mode & 0o077, 0);
  assert.deepEqual(readdirSync(directory).sort(), [
    "client-id.txt",
    "client-secret.txt",
    "user-token.json",
  ]);
});
test("state不一致・Unicode・重複・別path・POSTは交換せず、その後の正しい認可を妨げない", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  await runOAuth({
    directory,
    port: 0,
    fetchImpl: async () => {
      calls++;
      return success();
    },
    onReady: async (ready) => {
      const actualState = new URL(ready.authorizeURL).searchParams.get("state");
      const otherState = (actualState[0] === "A" ? "B" : "A") + actualState.slice(1);
      for (const state of ["wrong", "あ".repeat(43), otherState])
        assert.equal((await fetch(callback(ready, { state }))).status, 400);
      const duplicate = callback(ready);
      duplicate.searchParams.append("state", "second");
      assert.equal((await fetch(duplicate)).status, 400);
      const other = callback(ready);
      other.pathname = "/other";
      assert.equal((await fetch(other)).status, 404);
      assert.equal((await fetch(callback(ready), { method: "POST" })).status, 400);
      assert.equal(calls, 0);
      assert.equal((await fetch(callback(ready))).status, 200);
    },
  });
  assert.equal(calls, 1);
});
test("Hostの取り違えを拒む", async (t) => {
  const directory = fixture(t);
  await runOAuth({
    directory,
    port: 0,
    fetchImpl: async () => success(),
    onReady: async (ready) => {
      const url = callback(ready);
      const status = await new Promise((resolve, reject) => {
        const req = request(url, { headers: { Host: "evil.example" } }, (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode));
        });
        req.on("error", reject);
        req.end();
      });
      assert.equal(status, 400);
      assert.equal((await fetch(url)).status, 200);
    },
  });
});
test("本人が拒否したら交換せず、予約したtokenファイルを消す", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  await assert.rejects(
    runOAuth({
      directory,
      port: 0,
      fetchImpl: async () => {
        calls++;
        return success();
      },
      onReady: async (ready) => {
        assert.equal((await fetch(callback(ready, { error: "access_denied" }))).status, 400);
      },
    }),
    OAuthFailure,
  );
  assert.equal(calls, 0);
  assert.equal(existsSync(join(directory, "user-token.json")), false);
  assert.equal(
    readdirSync(directory).some((name) => name.endsWith(".html")),
    false,
  );
});
for (const [name, response] of [
  [
    "redirect",
    () => new Response(null, { status: 302, headers: { Location: "https://evil.example" } }),
  ],
  ["error", () => new Response(secret, { status: 401 })],
  ["body_limit", () => new Response("x".repeat(16385))],
  ["bad_json", () => new Response(secret)],
  [
    "extra_scope",
    () =>
      Response.json({
        access_token: tokenValue,
        token_type: "bearer",
        expires_in: 7200,
        scope: "tweet.read users.read dm.read",
      }),
  ],
  [
    "refresh",
    () =>
      Response.json({
        access_token: tokenValue,
        token_type: "bearer",
        expires_in: 7200,
        scope: "tweet.read users.read",
        refresh_token: secret,
      }),
  ],
])
  test(`${name}を保存せず、秘密をエラーやcallbackページへ出さない`, async (t) => {
    const directory = fixture(t);
    let error;
    try {
      await runOAuth({
        directory,
        port: 0,
        fetchImpl: async () => response(),
        onReady: async (ready) => {
          const result = await fetch(callback(ready));
          assert.equal(result.status, 502);
          noSecrets(await result.text());
        },
      });
    } catch (value) {
      error = value;
    }
    assert.ok(error instanceof OAuthFailure);
    noSecrets({ name: error.name, message: error.message, stack: error.stack });
    assert.equal(existsSync(join(directory, "user-token.json")), false);
  });
test("timeout後はcallbackと一時ファイルを残さない", async (t) => {
  const directory = fixture(t);
  await assert.rejects(runOAuth({ directory, port: 0, timeoutMs: 20 }), OAuthFailure);
  assert.deepEqual(readdirSync(directory).sort(), ["client-id.txt", "client-secret.txt"]);
});
test("並行するcallbackは1回だけ交換する", async (t) => {
  const directory = fixture(t);
  let calls = 0;
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  await runOAuth({
    directory,
    port: 0,
    fetchImpl: async () => {
      calls++;
      entered.resolve();
      await release.promise;
      return success();
    },
    onReady: async (ready) => {
      const first = fetch(callback(ready));
      await entered.promise;
      assert.equal((await fetch(callback(ready))).status, 409);
      release.resolve();
      assert.equal((await first).status, 200);
    },
  });
  assert.equal(calls, 1);
});
test("公開ファイル・symlinkの資格情報・既存tokenを受けず、上書きしない", async (t) => {
  for (const kind of ["mode", "symlink", "existing"]) {
    const directory = fixture(t);
    if (kind === "mode") chmodSync(join(directory, "client-secret.txt"), 0o644);
    if (kind === "symlink") {
      rmSync(join(directory, "client-secret.txt"));
      symlinkSync(join(directory, "client-id.txt"), join(directory, "client-secret.txt"));
    }
    if (kind === "existing")
      writeFileSync(join(directory, "user-token.json"), "previous", { mode: 0o600 });
    await assert.rejects(runOAuth({ directory, port: 0 }), OAuthFailure);
    if (kind === "existing")
      assert.equal(readFileSync(join(directory, "user-token.json"), "utf8"), "previous");
  }
});
test("portが使用中なら固定エラーで終了し、ファイルを残さない", async (t) => {
  const directory = fixture(t);
  const { createServer } = await import("node:http");
  const occupied = createServer();
  await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
  try {
    await assert.rejects(runOAuth({ directory, port: occupied.address().port }), OAuthFailure);
    assert.equal(existsSync(join(directory, "user-token.json")), false);
  } finally {
    occupied.close();
  }
});
test("timeout後にtoken endpointが遅れて成功しても保存しない", async (t) => {
  const directory = fixture(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let callbackRequest;
  const run = runOAuth({
    directory,
    port: 0,
    timeoutMs: 50,
    fetchImpl: async () => {
      entered.resolve();
      await release.promise;
      return success();
    },
    onReady: (ready) => {
      callbackRequest = fetch(callback(ready)).catch(() => undefined);
    },
  });
  await entered.promise;
  await assert.rejects(run, OAuthFailure);
  release.resolve();
  await callbackRequest;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(existsSync(join(directory, "user-token.json")), false);
});
test("中断時もlistenerと予約ファイルを片付ける", async (t) => {
  const directory = fixture(t);
  const control = new AbortController();
  await assert.rejects(
    runOAuth({ directory, port: 0, signal: control.signal, onReady: () => control.abort() }),
    OAuthFailure,
  );
  assert.deepEqual(readdirSync(directory).sort(), ["client-id.txt", "client-secret.txt"]);
});
test("CLIは資格情報の内容をstdout・stderrへ出さない", async (t) => {
  const directory = fixture(t);
  chmodSync(join(directory, "client-secret.txt"), 0o644);
  const { spawnSync } = await import("node:child_process");
  const result = spawnSync(process.execPath, ["scripts/x-oauth.mjs", directory], {
    encoding: "utf8",
  });
  assert.equal(result.status, 1);
  noSecrets({ stdout: result.stdout, stderr: result.stderr });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr.includes("Error:"), false);
});
test("token交換が5秒を超えてもcallbackへ成功とURL消去を返す", { timeout: 15000 }, async (t) => {
  const directory = fixture(t);
  await runOAuth({
    directory,
    port: 0,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 5200));
      return success();
    },
    onReady: async (ready) => {
      const response = await fetch(callback(ready));
      assert.equal(response.status, 200);
      assert.match(await response.text(), /history.replaceState/);
    },
  });
  assert.equal(
    JSON.parse(readFileSync(join(directory, "user-token.json"), "utf8")).access_token,
    tokenValue,
  );
});
test("CLIと同じくonReadyがすぐ戻る場合も成功ページを最後まで届ける", async (t) => {
  const directory = fixture(t);
  const ready = Promise.withResolvers();
  const pending = runOAuth({
    directory,
    port: 0,
    fetchImpl: async () => success(),
    onReady: (value) => ready.resolve(value),
  });
  const response = await fetch(callback(await ready.promise));
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Authorization saved/);
  const saved = await pending;
  assert.ok(existsSync(saved.tokenPath));
});
