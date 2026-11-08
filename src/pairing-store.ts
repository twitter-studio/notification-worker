import { DurableObject } from "cloudflare:workers";
import {
  defaultNotificationTypes,
  manualDmPreviewKeys,
  relayEndpoint,
  type XRelayTarget,
  xRelayTargets,
} from "./config";
import type { X_NOTIFICATION_TYPES } from "./normalize";

type NotificationType = (typeof X_NOTIFICATION_TYPES)[number];
type PairingRoute = {
  recipient: string;
  routeID: string;
  token: string;
  managementHash: string;
  eventTypes?: NotificationType[];
  dmPreviewKey?: string;
};
/** アプリに返すルートの設定。鍵の値は返さない (端末はもう持っていて、応答から鍵が漏れる経路を増やさない)。 */
export type RouteSettings = { event_types: readonly NotificationType[]; dm_preview: boolean };
export type RouteChanges = {
  eventTypes?: NotificationType[];
  dmPreviewKey?: string | null;
  token?: string;
};

function routeSettings(route: PairingRoute): RouteSettings {
  return {
    event_types: route.eventTypes ?? defaultNotificationTypes,
    dm_preview: route.dmPreviewKey !== undefined,
  };
}

/** ルートごとに、この時間のうちに書き換えられる回数。アプリの不具合で書き続けても、配送が読む Durable Object を詰まらせない。 */
const settingsWindow = 10 * 60_000;
const settingsWritesPerWindow = 30;

export type StoredRoute = PairingRoute & {
  nextTestAt?: number;
  settingsWrites?: number;
  settingsWindowEndsAt?: number;
};
type Reservation = { routeID: string; managementHash: string; cancelled?: boolean };
type Code = {
  recipient: string;
  hash: string;
  proofKey: string;
  expires: number;
  usedBy?: Reservation;
  reservations?: Reservation[];
};
type State = { codes: Code[]; routes: StoredRoute[] };

declare global {
  interface Env {
    PAIRING_ROUTES?: DurableObjectNamespace<PairingStore>;
    PAIRING_ADMIN_TOKEN?: string;
  }
}

/** 手動の配送先のうち、ルートの変更と重なりを比べるもの。鍵は重なりを除く前の値。 */
type ManualRoutes = { tokens: { recipient: string; token: string }[]; dmPreviewKeys: string[] };

/**
 * ルートに変更を当てた結果を決める。保存はしない。
 * Durable Object の中の `env` と時刻はテストから変えられないので、重なりと回数の判定をここに切り出して試す。
 */
export function applyRouteChanges(
  route: StoredRoute,
  others: StoredRoute[],
  manual: ManualRoutes,
  changes: RouteChanges,
  now: number,
):
  | { kind: "conflict" }
  | { kind: "limited" }
  | { kind: "unchanged" }
  | { kind: "changed"; route: StoredRoute } {
  // 生の値どうしで比べる。管理キーで認証した後の Durable Object の中の比較で、値は 256 ビットの乱数なので、時間の差から値は探れない。
  // 同じアカウントで同じ資格情報を2つ持つと、同じ端末に二重に届く。鍵が重なると、どの端末の鍵か決まらない。
  if (
    (changes.token !== undefined &&
      [...manual.tokens, ...others].some(
        (item) => item.recipient === route.recipient && item.token === changes.token,
      )) ||
    (typeof changes.dmPreviewKey === "string" &&
      (manual.dmPreviewKeys.includes(changes.dmPreviewKey) ||
        others.some((item) => item.dmPreviewKey === changes.dmPreviewKey)))
  )
    return { kind: "conflict" };
  const next: StoredRoute = { ...route };
  if (changes.token !== undefined) next.token = changes.token;
  if (changes.eventTypes !== undefined) next.eventTypes = [...new Set(changes.eventTypes)];
  if (changes.dmPreviewKey === null) delete next.dmPreviewKey;
  else if (changes.dmPreviewKey !== undefined) next.dmPreviewKey = changes.dmPreviewKey;
  if (JSON.stringify(next) === JSON.stringify(route)) return { kind: "unchanged" };
  // 鍵を外す・種類を減らすだけの変更は数えない。上限に達した後でも、受け取るものを絞れるようにする。
  const current = new Set(route.eventTypes ?? defaultNotificationTypes);
  const narrowing =
    changes.token === undefined &&
    typeof changes.dmPreviewKey !== "string" &&
    (changes.eventTypes ?? []).every((type) => current.has(type));
  if (!narrowing) {
    const windowEndsAt = route.settingsWindowEndsAt ?? 0;
    const windowOpen = windowEndsAt > now;
    const writes = windowOpen ? (route.settingsWrites ?? 0) : 0;
    if (writes >= settingsWritesPerWindow) return { kind: "limited" };
    next.settingsWrites = writes + 1;
    next.settingsWindowEndsAt = windowOpen ? windowEndsAt : now + settingsWindow;
  }
  return { kind: "changed", route: next };
}

export class PairingStore extends DurableObject<Env> {
  private read(): State {
    return this.ctx.storage.kv.get<State>("pairing") ?? { codes: [], routes: [] };
  }

  issue(code: Code): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      state.codes = state.codes.filter(
        (entry) => entry.expires > Date.now() && entry.recipient !== code.recipient,
      );
      if (state.codes.length >= 8) return false;
      state.codes.push(code);
      this.ctx.storage.kv.put("pairing", state);
      return true;
    });
  }

  reserveCode(
    hash: string,
    recipient: string,
    routeID: string,
    managementHash: string,
  ): string | undefined {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const code = state.codes.find(
        (item) => item.hash === hash && item.recipient === recipient && item.expires > Date.now(),
      );
      if (
        !code ||
        (code.usedBy &&
          (code.usedBy.routeID !== routeID || code.usedBy.managementHash !== managementHash))
      )
        return undefined;
      code.reservations ??= [];
      const reservations = code.reservations;
      const existing = reservations.find(
        (item) => item.routeID === routeID && item.managementHash === managementHash,
      );
      if (existing) return existing.cancelled ? undefined : code.proofKey;
      if (reservations.length >= 4) return undefined;
      reservations.push({ routeID, managementHash });
      this.ctx.storage.kv.put("pairing", state);
      return code.proofKey;
    });
  }

  /** 管理者の一覧。端末が自分で選んだ種類と、DM プレビューの有無も出し、DM を受け取っている端末を外せるようにする。 */
  list(): ({ x_user_id: string; route_id: string } & RouteSettings)[] {
    return this.read().routes.map((route) => ({
      x_user_id: route.recipient,
      route_id: route.routeID,
      ...routeSettings(route),
    }));
  }

  registerRoute(codeHash: string, route: PairingRoute): "connected" | "invalid" | "conflict" {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const code = state.codes.find(
        (item) =>
          item.hash === codeHash && item.recipient === route.recipient && item.expires > Date.now(),
      );
      if (
        !code?.reservations?.some(
          (item) =>
            item.routeID === route.routeID &&
            item.managementHash === route.managementHash &&
            !item.cancelled,
        ) ||
        (code.usedBy !== undefined &&
          (code.usedBy.managementHash !== route.managementHash ||
            code.usedBy.routeID !== route.routeID))
      )
        return "invalid";
      const existing = state.routes.find((item) => item.routeID === route.routeID);
      if (existing) {
        if (
          existing.managementHash !== route.managementHash ||
          existing.recipient !== route.recipient ||
          existing.token !== route.token
        )
          return "conflict";
      } else {
        if (code.usedBy !== undefined) return "invalid";
        const manual = xRelayTargets(this.env, true);
        const all = [
          ...manual,
          ...state.routes.map((item) => ({
            recipient: item.recipient,
            routeID: item.routeID,
            config: { token: item.token },
          })),
        ];
        const sameRecipient = all.filter((item) => item.recipient === route.recipient);
        if (
          all.some((item) => item.routeID === route.routeID) ||
          sameRecipient.some((item) => item.config.token === route.token) ||
          sameRecipient.length >= 4 ||
          new Set([...all.map((item) => item.recipient), route.recipient]).size > 8
        )
          return "conflict";
        state.routes.push(route);
      }
      code.usedBy = { managementHash: route.managementHash, routeID: route.routeID };
      this.ctx.storage.kv.put("pairing", state);
      return "connected";
    });
  }

  disconnect(routeID: string, managementHash?: string): void {
    this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const routes = state.routes.filter(
        (route) =>
          route.routeID !== routeID ||
          (managementHash !== undefined && route.managementHash !== managementHash),
      );
      let changed = routes.length !== state.routes.length;
      for (const code of state.codes) {
        for (const reservation of code.reservations ?? []) {
          if (
            reservation.routeID !== routeID ||
            reservation.cancelled ||
            (managementHash !== undefined && reservation.managementHash !== managementHash)
          )
            continue;
          reservation.cancelled = true;
          changed = true;
        }
      }
      if (changed) this.ctx.storage.kv.put("pairing", { ...state, routes });
    });
  }

  updateRoute(
    routeID: string,
    managementHash: string,
    changes: RouteChanges,
  ): { kind: "missing" | "conflict" | "limited" } | { kind: "updated"; settings: RouteSettings } {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const index = state.routes.findIndex(
        (item) => item.routeID === routeID && item.managementHash === managementHash,
      );
      const route = state.routes[index];
      if (!route) return { kind: "missing" };
      const result = applyRouteChanges(
        route,
        state.routes.filter((item) => item !== route),
        {
          tokens: xRelayTargets(this.env, true).map((item) => ({
            recipient: item.recipient,
            token: item.config.token,
          })),
          dmPreviewKeys: manualDmPreviewKeys(this.env),
        },
        changes,
        Date.now(),
      );
      if (result.kind === "unchanged") return { kind: "updated", settings: routeSettings(route) };
      if (result.kind === "conflict" || result.kind === "limited") return { kind: result.kind };
      state.routes[index] = result.route;
      this.ctx.storage.kv.put("pairing", state);
      return { kind: "updated", settings: routeSettings(result.route) };
    });
  }

  reserveTest(
    routeID: string,
    managementHash: string,
  ): { kind: "missing" | "limited" } | { kind: "ready"; route: PairingRoute } {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const route = state.routes.find(
        (item) => item.routeID === routeID && item.managementHash === managementHash,
      );
      if (!route) return { kind: "missing" };
      const now = Date.now();
      if ((route.nextTestAt ?? 0) > now) return { kind: "limited" };
      route.nextTestAt = now + 60_000;
      this.ctx.storage.kv.put("pairing", state);
      return { kind: "ready", route };
    });
  }

  targets(): Omit<PairingRoute, "managementHash">[] {
    return this.read().routes.map(({ recipient, routeID, token, eventTypes, dmPreviewKey }) => ({
      recipient,
      routeID,
      token,
      ...(eventTypes === undefined ? {} : { eventTypes }),
      ...(dmPreviewKey === undefined ? {} : { dmPreviewKey }),
    }));
  }
}

export function pairingStore(env: Env) {
  if (
    env.PUBLIC_RELAY_TRIAL_UNTIL !== undefined ||
    env.PUBLIC_RELAY_TRIAL_ORIGIN !== undefined ||
    !/^tpa_[A-Za-z0-9_-]{43}$/.test(env.PAIRING_ADMIN_TOKEN ?? "")
  )
    return undefined;
  return env.PAIRING_ROUTES?.getByName("routes");
}

export async function deliveryTargets(env: Env): Promise<XRelayTarget[]> {
  const store = pairingStore(env);
  const manual = xRelayTargets(env, store !== undefined);
  const paired = await store?.targets();
  if (!paired?.length) return manual;
  const endpoint = relayEndpoint(env.RELAY_URL);
  const accounts = new Set(manual.map((item) => item.recipient));
  // 手動の鍵は重なりを除く前の値で数える。重なった鍵は、手動とペアリングのどちらのルートでも使わない。
  const keyCounts = new Map<string, number>();
  for (const key of [...manualDmPreviewKeys(env), ...paired.map((item) => item.dmPreviewKey)])
    if (key !== undefined) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
  for (const target of manual)
    if (target.dmPreviewKey !== undefined && keyCounts.get(target.dmPreviewKey) !== 1)
      target.dmPreviewKey = undefined;
  for (const { recipient, routeID, token, eventTypes, dmPreviewKey } of paired) {
    const sameRecipient = manual.filter((item) => item.recipient === recipient);
    if (
      manual.some((item) => item.routeID === routeID) ||
      sameRecipient.some((item) => item.config.token === token) ||
      sameRecipient.length >= 4 ||
      (!accounts.has(recipient) && accounts.size >= 8)
    )
      continue;
    accounts.add(recipient);
    manual.push({
      recipient,
      routeID,
      config: { endpoint, token },
      eventTypes: eventTypes ?? defaultNotificationTypes,
      dmPreviewKey:
        dmPreviewKey !== undefined && keyCounts.get(dmPreviewKey) === 1 ? dmPreviewKey : undefined,
    });
  }
  return manual;
}
