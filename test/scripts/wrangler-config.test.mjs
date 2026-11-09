import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import { experimental_readRawConfig } from "wrangler";

const root = resolve(import.meta.dirname, "../..");
const read = (name) => experimental_readRawConfig({ config: resolve(root, name) }).rawConfig;

test("ボタンの設定は、基本の設定に端末の接続と回数の上限を足しただけ", () => {
  const button = read("wrangler.jsonc");
  const base = read("wrangler.example.jsonc");
  const { main, durable_objects, migrations, ratelimits, ...rest } = button;
  const { main: _baseMain, ...baseRest } = base;
  assert.deepEqual(rest, baseRest);
  assert.equal(main, "src/pairing-worker.ts");
  assert.deepEqual(durable_objects, {
    bindings: [{ name: "PAIRING_ROUTES", class_name: "PairingStore" }],
  });
  assert.deepEqual(migrations, [{ tag: "pairing-v1", new_sqlite_classes: ["PairingStore"] }]);
  assert.deepEqual(
    ratelimits.map(({ name }) => name),
    ["CONNECT_LIMITER"],
  );
});

test("ボタンの配置の画面で入れる値には、どれも説明がある", () => {
  const button = read("wrangler.jsonc");
  const secrets = [
    ...readFileSync(resolve(root, ".dev.vars.example"), "utf8").matchAll(/^([A-Z0-9_]+)=/gm),
  ].map(([, name]) => name);
  const described = Object.keys(
    JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).cloudflare.bindings,
  );
  for (const name of [...Object.keys(button.vars), ...secrets])
    assert.ok(described.includes(name), name);
});
