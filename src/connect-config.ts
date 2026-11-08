import { isEnabled } from "./config";
import { MIN_SECRET_LENGTH } from "./verify";
import { XUserID } from "./x-activity";

declare global {
  interface Env {
    /** `/connect` と `/oauth/callback` の回数を、接続元ごとに絞る Rate Limiting の binding。配置ごとに namespace の ID が要るので任意にする。 */
    CONNECT_LIMITER?: RateLimit;
  }
}

export type ConnectConfig = {
  clientID: string;
  clientSecret: string;
  webhookID: string;
  bearer: string;
  allowed: Set<string>;
  limiter: RateLimit;
};

/**
 * X でログインして接続するための設定。どれかが欠けていれば undefined で、`/connect` を見せず、接続コードの経路だけを使う。
 * `ENABLE_X_ACTIVITY` が "true" でなければ使わない (Webhook を受けられない Worker で購読を作ると、課金だけが進む)。
 */
export function connectConfig(env: Env): ConnectConfig | undefined {
  const allowed = new Set(
    (env.ALLOWED_X_USER_IDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter((value) => XUserID.safeParse(value).success),
  );
  const clientID = env.X_OAUTH2_CLIENT_ID ?? "";
  const clientSecret = env.X_OAUTH2_CLIENT_SECRET ?? "";
  const webhookID = env.X_WEBHOOK_ID ?? "";
  const bearer = env.X_APP_BEARER_TOKEN ?? "";
  const limiter = env.CONNECT_LIMITER;
  if (
    !isEnabled(env.ENABLE_X_ACTIVITY) ||
    clientID.length === 0 ||
    clientSecret.length < MIN_SECRET_LENGTH ||
    !/^[0-9]{1,19}$/.test(webhookID) ||
    bearer.length === 0 ||
    allowed.size === 0 ||
    limiter === undefined
  )
    return undefined;
  return { clientID, clientSecret, webhookID, bearer, allowed, limiter };
}
