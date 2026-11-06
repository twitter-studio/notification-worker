import { z } from "zod";
import { DmPreviewKey } from "./dm-preview";
import { X_NOTIFICATION_TYPES } from "./normalize";
import { XUserID } from "./x-activity";

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
  expiresAt?: number;
};

const RELAY_TOKEN = /^tsr_[A-Za-z0-9_-]{43}$/;
export const RelayRouteID = z.uuid().transform((value) => value.toLowerCase());
const NotificationTypes = z.array(z.enum(X_NOTIFICATION_TYPES)).max(X_NOTIFICATION_TYPES.length);
const defaultNotificationTypes = ["mention", "reply"] as const;
const XRelayRoutes = z.record(
  XUserID,
  z
    .array(
      z.strictObject({
        relay_token: z.string().regex(RELAY_TOKEN),
        route_id: RelayRouteID,
        event_types: NotificationTypes.optional(),
        dm_preview_key: DmPreviewKey.optional(),
      }),
    )
    .min(1)
    .max(4),
);

export type XRelayTarget = {
  recipient: string;
  config: RelayConfig;
  routeID?: string;
  dmPreviewKey?: string | undefined;
  eventTypes: readonly (typeof X_NOTIFICATION_TYPES)[number][];
};

declare global {
  interface Env {
    X_RELAY_ROUTES?: string;
    X_NOTIFICATION_TYPES?: string;
    ENABLE_X_NOTIFICATION_PREVIEW?: string;
    ENABLE_X_POST_PREVIEW_LOOKUP?: string;
    PUBLIC_RELAY_TRIAL_UNTIL?: string;
    PUBLIC_RELAY_TRIAL_ORIGIN?: string;
    PUBLIC_RELAY_TRIAL_TOKEN?: string;
    X_EVENT_NOT_BEFORE?: string;
  }
}

export function publicRelayTrialExpired(env: Env): boolean {
  return (
    env.PUBLIC_RELAY_TRIAL_UNTIL !== undefined && Number(env.PUBLIC_RELAY_TRIAL_UNTIL) <= Date.now()
  );
}

/**
 * 中継の API の URL と資格情報を読む。URL は https で、資格情報、パス、クエリを含まないものだけを受ける。
 * 要求ごとに外から URL を変えさせない (送り先は、利用者が置いた設定だけで決める)。
 */
export function relayConfig(env: Env): RelayConfig {
  const trial = usesPublicRelayTrial(env);
  if (
    trial &&
    (!/^[0-9]{13}$/.test(env.PUBLIC_RELAY_TRIAL_UNTIL ?? "") ||
      Number(env.PUBLIC_RELAY_TRIAL_UNTIL) <= Date.now() ||
      env.PUBLIC_RELAY_TRIAL_ORIGIN === undefined)
  )
    throw new ConfigError("PUBLIC_RELAY_TRIAL_UNTIL");
  const origin = trial ? env.PUBLIC_RELAY_TRIAL_ORIGIN : env.RELAY_URL;
  const token = trial ? env.PUBLIC_RELAY_TRIAL_TOKEN : env.RELAY_TOKEN;
  const endpoint = relayEndpoint(origin);
  if (token === undefined || !RELAY_TOKEN.test(token))
    throw new ConfigError(trial ? "PUBLIC_RELAY_TRIAL_TOKEN" : "RELAY_TOKEN");
  return {
    endpoint,
    token,
    ...(trial ? { expiresAt: Number(env.PUBLIC_RELAY_TRIAL_UNTIL) } : {}),
  };
}

function usesPublicRelayTrial(env: Env): boolean {
  return env.PUBLIC_RELAY_TRIAL_UNTIL !== undefined || env.PUBLIC_RELAY_TRIAL_ORIGIN !== undefined;
}

export function xRelayTargets(env: Env): XRelayTarget[] {
  // 期限付きの公開試験には、試験専用の資格情報だけを使う。
  if (usesPublicRelayTrial(env) || env.X_RELAY_ROUTES === undefined) {
    const recipient = XUserID.safeParse(env.X_USER_ID);
    if (!recipient.success) throw new ConfigError("X_USER_ID");
    const types = env.X_NOTIFICATION_TYPES;
    const parsed = NotificationTypes.safeParse(types === "" ? [] : types?.split(","));
    if (
      !usesPublicRelayTrial(env) &&
      types !== undefined &&
      (!parsed.success || parsed.data.includes("dm"))
    )
      throw new ConfigError("X_NOTIFICATION_TYPES");
    const eventTypes =
      !usesPublicRelayTrial(env) && parsed.success ? parsed.data : defaultNotificationTypes;
    return [{ recipient: recipient.data, config: relayConfig(env), eventTypes }];
  }

  const failure = new ConfigError("X_RELAY_ROUTES");
  if (env.X_RELAY_ROUTES.length > 5_000) throw failure;
  let value: unknown;
  try {
    value = JSON.parse(env.X_RELAY_ROUTES);
  } catch {
    throw failure;
  }
  const routes = XRelayRoutes.safeParse(value);
  if (!routes.success) throw failure;
  const entries = Object.entries(routes.data);
  if (entries.length === 0 || entries.length > 8) throw failure;
  const endpoint = relayEndpoint(env.RELAY_URL);
  const routeIDs = new Set<string>();
  const previewKeys = new Set<string>();
  return entries.flatMap(([recipient, targets]) => {
    const tokens = new Set<string>();
    return targets.map(({ relay_token, route_id, event_types, dm_preview_key }) => {
      if (routeIDs.has(route_id) || tokens.has(relay_token)) throw failure;
      if (dm_preview_key !== undefined) {
        if (previewKeys.has(dm_preview_key)) throw failure;
        previewKeys.add(dm_preview_key);
      }
      routeIDs.add(route_id);
      tokens.add(relay_token);
      return {
        recipient,
        config: { endpoint, token: relay_token },
        routeID: route_id,
        dmPreviewKey: dm_preview_key,
        eventTypes: event_types ?? defaultNotificationTypes,
      };
    });
  });
}

function relayEndpoint(origin: string | undefined): URL {
  let base: URL;
  try {
    base = new URL(origin ?? "");
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
  return new URL("/v1/notifications", base);
}

/** "true" のときだけ有効 (書き間違いで有効にならないよう、ほかの値はすべて無効)。 */
export function isEnabled(value: string | undefined): boolean {
  return value === "true";
}
