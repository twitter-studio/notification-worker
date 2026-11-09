import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { experimental_readRawConfig } from "wrangler";

const root = resolve(import.meta.dirname, "../..");
const read = (name) => experimental_readRawConfig({ config: resolve(root, name) }).rawConfig;
const secrets = [
  ...readFileSync(resolve(root, ".dev.vars.example"), "utf8").matchAll(/^([A-Z0-9_]+)=/gm),
].map(([, name]) => name);

/** 配置の画面で利用者が変えられる名前 (Worker と Queue) を除く。写した先のリポジトリで名前を変えても、比べられるように。 */
function withoutNames({ name: _name, queues, ...config }) {
  return {
    ...config,
    queues: {
      producers: queues.producers.map(({ queue: _queue, ...rest }) => rest),
      consumers: queues.consumers.map(({ queue: _queue, ...rest }) => rest),
    },
  };
}

test("ボタンの設定は、基本の設定に端末の接続と回数の上限を足しただけ", () => {
  const button = read("wrangler.jsonc");
  const base = read("wrangler.example.jsonc");
  const { main, durable_objects, migrations, ratelimits, ...rest } = withoutNames(button);
  const { main: _baseMain, ...baseRest } = withoutNames(base);
  assert.deepEqual(rest, baseRest);
  assert.equal(main, "src/pairing-worker.ts");
  assert.deepEqual(durable_objects, {
    bindings: [{ name: "PAIRING_ROUTES", class_name: "PairingStore" }],
  });
  assert.deepEqual(migrations, [{ tag: "pairing-v1", new_sqlite_classes: ["PairingStore"] }]);
  assert.deepEqual(
    ratelimits.map(({ name, simple }) => [name, simple]),
    [["CONNECT_LIMITER", { limit: 10, period: 60 }]],
  );
  // Queue の producer と consumer は、同じ Queue を指す。
  assert.equal(button.queues.producers[0].queue, button.queues.consumers[0].queue);
});

test("ボタンの設定は、入口を閉じたまま配置し、秘密を平文の変数に置かない", () => {
  const button = read("wrangler.jsonc");
  assert.equal(button.vars.ENABLE_X_ACTIVITY, "false");
  assert.equal(button.vars.ENABLE_MOCK_EVENTS, "false");
  assert.equal(button.preview_urls, false);
  for (const name of secrets) assert.equal(button.vars[name], undefined, name);
});

test("ボタンの配置の画面で入れる値と、説明が 1 対 1 で対応する", () => {
  const button = read("wrangler.jsonc");
  const described = Object.keys(
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).cloudflare.bindings,
  );
  assert.deepEqual(described.toSorted(), [...Object.keys(button.vars), ...secrets].toSorted());
});
