import { isEnabled } from "./config";
import type { pairingStore } from "./pairing-store";
import { MIN_SECRET_LENGTH } from "./verify";
import { XUserID } from "./x-activity";

declare global {
  interface Env {
    /** `/connect`、`/setup` と `/oauth/callback` の回数を、接続元ごとに絞る Rate Limiting の binding。配置ごとに namespace の ID が要るので任意にする。 */
    CONNECT_LIMITER?: RateLimit;
    /** 任意。ボタンの配置の画面が vars をどれも必須の欄にするので、設定に置かない (#59)。 */
    X_WEBHOOK_ID?: string;
  }
}

/** X でログインして、この Worker の Webhook を用意する (`/setup`) ための設定。 */
export type SetupConfig = {
  clientID: string;
  clientSecret: string;
  bearer: string;
  allowed: Set<string>;
  limiter: RateLimit;
};

export type ConnectConfig = SetupConfig & { webhookID: string };

export const WebhookID = /^[0-9]{1,19}$/;

/**
 * `/setup` と `/connect` に共通の設定。どれかが欠けていれば undefined で、どちらの入口も見せない。
 * `ENABLE_X_ACTIVITY` が "true" でなければ使わない (Webhook を受けられない Worker では X の CRC に答えられず、購読を作っても
 * 課金だけが進む)。
 */
export function setupConfig(env: Env): SetupConfig | undefined {
  const allowed = new Set(
    (env.ALLOWED_X_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => XUserID.safeParse(value).success),
  );
  const clientID = env.X_OAUTH2_CLIENT_ID ?? "";
  const clientSecret = env.X_OAUTH2_CLIENT_SECRET ?? "";
  const bearer = env.X_APP_BEARER_TOKEN ?? "";
  const limiter = env.CONNECT_LIMITER;
  if (
    !isEnabled(env.ENABLE_X_ACTIVITY) ||
    clientID.length === 0 ||
    clientSecret.length < MIN_SECRET_LENGTH ||
    bearer.length === 0 ||
    allowed.size === 0 ||
    limiter === undefined
  )
    return undefined;
  return { clientID, clientSecret, bearer, allowed, limiter };
}

/**
 * X でログインして接続するための設定。Webhook の ID は、`X_WEBHOOK_ID` を置いていればその値、なければ `/setup` で用意して
 * 保存した値を使う。どれかが欠けていれば undefined で、`/connect` を見せず、接続コードの経路だけを使う。
 */
export async function connectConfig(
  env: Env,
  store: ReturnType<typeof pairingStore>,
): Promise<ConnectConfig | undefined> {
  const setup = setupConfig(env);
  if (!setup) return undefined;
  const configured = env.X_WEBHOOK_ID ?? "";
  const webhookID = configured.length > 0 ? configured : await store?.webhookID();
  if (webhookID === undefined || !WebhookID.test(webhookID)) return undefined;
  return { ...setup, webhookID };
}
