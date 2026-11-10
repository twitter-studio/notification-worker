import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

const routeID = "12345678-1234-4234-8234-123456789abc";
function run(args, handler) {
  return spawnSync(
    process.execPath,
    [
      "--import",
      `data:text/javascript,${encodeURIComponent(`globalThis.fetch = ${handler};`)}`,
      "scripts/pair-device.mjs",
      ...args,
    ],
    {
      encoding: "utf8",
      env: { ...process.env, PAIRING_ADMIN_TOKEN: `tpa_${"A".repeat(43)}` },
    },
  );
}

test("接続コードの発行は通信せず拒否する", () => {
  const result = run(
    ["issue", "https://worker.example", "123"],
    `async () => { process.exit(2); }`,
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /list HTTPS_WORKER_ORIGIN or revoke/);
});

test("管理者は接続した配送先の一覧を確認できる", () => {
  const result = run(
    ["list", "https://worker.example"],
    `async (url, init) => {
    if (url.pathname !== "/v1/pairing/routes" || init.body !== "{}" || init.redirect !== "error") process.exit(2);
    return Response.json({routes:[{x_user_id:"123",route_id:${JSON.stringify(routeID)},event_types:["mention","reply"],dm_preview:false,x_login:true,connected_at:null}]});
  }`,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, `123 ${routeID} mention,reply - x-login -\n`);
});

test("管理者は指定した配送先だけを解除できる", () => {
  const result = run(
    ["revoke", "https://worker.example", routeID],
    `async (url, init) => {
    if (url.pathname !== "/v1/pairing/revoke" || JSON.parse(init.body).route_id !== ${JSON.stringify(routeID)} || init.redirect !== "error") process.exit(2);
    return new Response(null, {status:204});
  }`,
  );
  assert.equal(result.status, 0);
  assert.equal(result.stdout, "Connection removed.\n");
});
