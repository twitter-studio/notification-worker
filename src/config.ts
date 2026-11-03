// Worker の設定 (vars と秘密) を読む。値の誤りは、値を出さずに名前だけで知らせる。

/** 設定の誤り。`setting` は設定の名前 (値は入れない)。 */
export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(readonly setting: string) {
    super(`${setting} is invalid`);
  }
}

export type RelayConfig = {
  /** 中継の API の受け付けの入口 (`<RELAY_URL>/v1/notifications`)。 */
  endpoint: URL;
  token: string;
};

const RELAY_TOKEN = /^tsr_[A-Za-z0-9_-]{43}$/;

/**
 * 中継の API の URL と資格情報を読む。URL は https で、資格情報、パス、クエリを含まないものだけを受ける。
 * 要求ごとに外から URL を変えさせない (送り先は、利用者が置いた設定だけで決める)。
 */
export function relayConfig(env: Env): RelayConfig {
  let base: URL;
  try {
    base = new URL(env.RELAY_URL);
  } catch {
    throw new ConfigError("RELAY_URL");
  }
  if (
    base.protocol !== "https:" ||
    base.username !== "" ||
    base.password !== "" ||
    base.pathname !== "/" ||
    base.search !== "" ||
    base.hash !== ""
  ) {
    throw new ConfigError("RELAY_URL");
  }
  if (!RELAY_TOKEN.test(env.RELAY_TOKEN ?? "")) throw new ConfigError("RELAY_TOKEN");
  return { endpoint: new URL("/v1/notifications", base), token: env.RELAY_TOKEN };
}

/** "true" のときだけ有効 (書き間違いで有効にならないよう、ほかの値はすべて無効)。 */
export function isEnabled(value: string | undefined): boolean {
  return value === "true";
}
