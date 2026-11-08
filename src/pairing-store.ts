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
/** X のログインの途中の状態。verifier は PKCE のもので、Worker の外へ出さない。 */
export type Login = {
  state: string;
  verifier: string;
  /** ログインを始めたブラウザに置いた Cookie のハッシュ。別のブラウザで終えたログイン (罠のリンク) を断る。 */
  browserHash: string;
  /** ログインを始めたアプリの管理キーのハッシュ。出すコードをこれに結び付ける。 */
  managementHash: string;
  appState: string;
  recipient: string;
  eventTypes: NotificationType[];
  redirectURI: string;
  expires: number;
  /** X から戻った (使い切り)。 */
  used?: boolean;
  /**
   * 本人を確かめた後、購読を作ってコードを出すまでの期限。この間は、そのアカウントの購読を片付けで消さない。
   * 始めただけのログインや、本人を確かめる前のログインは守らない (外から `/connect` や戻り先を開くだけで、片付けを止められてしまうため)。
   */
  processingUntil?: number;
};
/** 消せなかった購読を、次に消し直す時刻。失敗が続くほど間を延ばす。 */
type Backoff = { failures: number; next: number };
type Reservation = { routeID: string; managementHash: string; cancelled?: boolean };
type Code = {
  recipient: string;
  hash: string;
  proofKey: string;
  expires: number;
  /**
   * X でログインして出したコードは、ログインを始めたアプリの管理キーでしか使えない (アプリの PKCE)。
   * コードがカスタムスキームやログから漏れても、管理キーを持たない人はルートを足せない。
   */
  managementHash?: string;
  /** X でログインしたときに選んだ種類。つないだルートの初めの種類にする (購読を作った種類と揃える)。 */
  eventTypes?: NotificationType[];
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
    next.token === route.token &&
    (next.dmPreviewKey === undefined || next.dmPreviewKey === route.dmPreviewKey) &&
    (next.eventTypes ?? defaultNotificationTypes).every((type) => current.has(type));
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

  /**
   * 同じアカウントの前のコードを消して、新しいコードを置く。X でログインして出すコードは、同じアプリのものだけを消す
   * (同じアカウントで 2 台をほぼ同時につないでも、先の端末のコードを消さない)。
   */
  issue(code: Code): boolean {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      state.codes = state.codes.filter(
        (entry) =>
          entry.expires > Date.now() &&
          (entry.recipient !== code.recipient || entry.managementHash !== code.managementHash),
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
        (code.managementHash !== undefined && code.managementHash !== managementHash) ||
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
        (code.managementHash !== undefined && code.managementHash !== route.managementHash) ||
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
        // X でログインして接続し直したら、選んだ種類を当てる (購読を作った種類と揃える)。
        if (code.eventTypes !== undefined) existing.eventTypes = code.eventTypes;
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
        state.routes.push(
          code.eventTypes === undefined ? route : { ...route, eventTypes: code.eventTypes },
        );
      }
      code.usedBy = { managementHash: route.managementHash, routeID: route.routeID };
      this.ctx.storage.kv.put("pairing", state);
      return "connected";
    });
  }

  /**
   * ルートを外す。外したルートのアカウントに、接続したルートがもう残っていなければ、そのアカウントを返す。
   * 呼び出し側は、手動の配送先もなければ、Worker が作った購読を消す。
   */
  disconnect(routeID: string, managementHash?: string): string | undefined {
    return this.ctx.storage.transactionSync(() => {
      const state = this.read();
      const removed = state.routes.filter(
        (route) =>
          route.routeID === routeID &&
          (managementHash === undefined || route.managementHash === managementHash),
      );
      const routes = state.routes.filter((route) => !removed.includes(route));
      let changed = removed.length > 0;
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
      const recipient = removed[0]?.recipient;
      return recipient !== undefined && !routes.some((route) => route.recipient === recipient)
        ? recipient
        : undefined;
    });
  }

  private logins(): Login[] {
    return this.ctx.storage.kv.get<Login[]>("logins") ?? [];
  }

  private subscriptions(): Record<string, string[]> {
    return this.ctx.storage.kv.get<Record<string, string[]>>("subscriptions") ?? {};
  }

  /** 片付けがそのアカウントの購読を消している間の期限。 */
  private releasing(): Record<string, number> {
    return this.ctx.storage.kv.get<Record<string, number>>("releasing") ?? {};
  }

  /** 結果の分からない作成があり、一覧で探して記録に取り込む要があるアカウント。 */
  private unsure(): string[] {
    return this.ctx.storage.kv.get<string[]>("unsure") ?? [];
  }

  private backoff(): Record<string, Backoff> {
    return this.ctx.storage.kv.get<Record<string, Backoff>>("cleanup") ?? {};
  }

  /**
   * そのアカウントの購読が、使われているか、使われようとしているか。
   * 接続したルート、使われていない有効なコード、本人を確かめて処理中のログインのどれかがあれば、消さない。
   * 手動の配送先は Worker の `env` で見る (呼び出し側)。
   */
  private inUse(recipient: string, now: number): boolean {
    const state = this.read();
    return (
      state.routes.some((route) => route.recipient === recipient) ||
      state.codes.some(
        (code) => code.recipient === recipient && code.expires > now && code.usedBy === undefined,
      ) ||
      this.logins().some(
        (login) => login.recipient === recipient && (login.processingUntil ?? 0) > now,
      )
    );
  }

  /**
   * X のログインの途中の状態を置く。期限の切れたものを除く。
   * 外から何度でも始められるので、断らずに古いものを置き換える (アカウントごとに 3 つ、全体で 16 まで)。
   * 断ると、他人が枠を埋めるだけで持ち主がログインできなくなる。
   */
  beginLogin(login: Login): void {
    this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      let logins = this.logins().filter((item) =>
        item.processingUntil === undefined ? item.expires > now : item.processingUntil > now,
      );
      // 処理中のログインは追い出さない。
      const waiting = logins.filter((item) => item.processingUntil === undefined);
      const same = waiting.filter((item) => item.recipient === login.recipient);
      if (same.length >= 3) logins = logins.filter((item) => item !== same[0]);
      if (logins.length >= 16) {
        const oldest = logins.find((item) => item.processingUntil === undefined);
        logins = logins.filter((item) => item !== oldest);
      }
      logins.push(login);
      this.ctx.storage.kv.put("logins", logins);
    });
  }

  /**
   * state でログインの途中の状態を引き、使い切りの印を付ける。期限が切れていても返し (`expired`)、アプリへ戻せるようにする。
   * 見つからなければ書き込まない (認証のない入口から、配送も読む Durable Object へ書き込ませない)。
   */
  takeLogin(state: string): { login?: Login; expired?: boolean } {
    return this.ctx.storage.transactionSync(() => {
      const logins = this.logins();
      const login = logins.find((item) => item.state === state);
      if (!login || login.used) return {};
      const expired = login.expires <= Date.now();
      this.ctx.storage.kv.put(
        "logins",
        expired
          ? logins.filter((item) => item !== login)
          : logins.map((item) => (item === login ? { ...item, used: true } : item)),
      );
      return { login, expired };
    });
  }

  /**
   * 本人を確かめた後、購読を作る前に、処理中の印を付ける。
   * 片付けがそのアカウントの購読を消している間は付けずに false を返す (消されている購読を「ある」とみなして使わないように)。
   */
  startProcessing(state: string, until: number): boolean {
    return this.ctx.storage.transactionSync(() => {
      const logins = this.logins();
      const login = logins.find(
        (item) => item.state === state && item.used === true && item.processingUntil === undefined,
      );
      if (!login || (this.releasing()[login.recipient] ?? 0) > Date.now()) return false;
      login.processingUntil = until;
      this.ctx.storage.kv.put("logins", logins);
      return true;
    });
  }

  /** X から戻った処理を終える (コードを出した、または失敗した)。処理中の印を消し、片付けで購読を消せるようにする。 */
  finishLogin(state: string): void {
    this.ctx.storage.transactionSync(() => {
      const logins = this.logins();
      const kept = logins.filter((item) => item.state !== state);
      if (kept.length !== logins.length) this.ctx.storage.kv.put("logins", kept);
    });
  }

  /** Worker が作った購読の ID を、作ったらすぐ覚える。持ち主が手で作った購読は覚えず、消さない。 */
  recordSubscriptions(recipient: string, ids: string[]): void {
    if (ids.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      const all = this.subscriptions();
      all[recipient] = [...new Set([...(all[recipient] ?? []), ...ids])];
      this.ctx.storage.kv.put("subscriptions", all);
    });
  }

  /**
   * 片付けの間 (`beginRelease` の後) に、一覧で見つけた Worker の tag の購読を記録に取り込み、確かめの印を外す。
   * 片付けの間は接続の処理が動いていないので、ここで読んだ一覧には、作りかけの購読が残っていない。
   */
  adoptSubscriptions(recipient: string, ids: string[]): void {
    this.ctx.storage.transactionSync(() => {
      if (ids.length > 0) {
        const all = this.subscriptions();
        all[recipient] = [...new Set([...(all[recipient] ?? []), ...ids])];
        this.ctx.storage.kv.put("subscriptions", all);
      }
      const unsure = this.unsure();
      if (unsure.includes(recipient))
        this.ctx.storage.kv.put(
          "unsure",
          unsure.filter((item) => item !== recipient),
        );
    });
  }

  /** 購読を作り始める。作ったかどうか分からない購読が残りうるので、片付けで一覧を探して記録に取り込むまで印を残す。 */
  markUnsure(recipient: string): void {
    this.ctx.storage.transactionSync(() => {
      const unsure = this.unsure();
      if (!unsure.includes(recipient)) this.ctx.storage.kv.put("unsure", [...unsure, recipient]);
    });
  }

  /** 消せた購読だけを記録から外す。 */
  forgetSubscriptions(recipient: string, ids: string[]): void {
    if (ids.length === 0) return;
    this.ctx.storage.transactionSync(() => {
      const all = this.subscriptions();
      const kept = (all[recipient] ?? []).filter((id) => !ids.includes(id));
      if (kept.length > 0) all[recipient] = kept;
      else delete all[recipient];
      this.ctx.storage.kv.put("subscriptions", all);
    });
  }

  /**
   * そのアカウントの購読の片付けを始める。使われていなければ、消している印を付けて、記録した ID と確かめの印の有無を返す。
   * 印を付けている間は、接続の処理を始めない (`startProcessing`)。使われているか、ほかの片付けの途中なら undefined。
   */
  beginRelease(recipient: string, until: number): { ids: string[]; unsure: boolean } | undefined {
    return this.ctx.storage.transactionSync(() => {
      const now = Date.now();
      const releasing = this.releasing();
      if (this.inUse(recipient, now) || (releasing[recipient] ?? 0) > now) return undefined;
      releasing[recipient] = until;
      this.ctx.storage.kv.put("releasing", releasing);
      return {
        ids: this.subscriptions()[recipient] ?? [],
        unsure: this.unsure().includes(recipient),
      };
    });
  }

  /**
   * 片付けを終える。消し残しがあれば、定期の処理で次に試すまでの間を延ばす (5 分から倍にし、1 日まで)。
   * X が消すのを断り続ける購読に、5 分ごとに要求を送り続けないため。
   */
  endRelease(recipient: string, remaining: boolean): void {
    this.ctx.storage.transactionSync(() => {
      const releasing = this.releasing();
      delete releasing[recipient];
      this.ctx.storage.kv.put("releasing", releasing);
      const backoff = this.backoff();
      if (remaining) {
        const failures = (backoff[recipient]?.failures ?? 0) + 1;
        backoff[recipient] = {
          failures,
          next: Date.now() + Math.min(5 * 60_000 * 2 ** (failures - 1), 24 * 60 * 60_000),
        };
      } else delete backoff[recipient];
      this.ctx.storage.kv.put("cleanup", backoff);
    });
  }

  /** 定期の処理で片付けるアカウント。購読の記録か確かめの印があり、使われておらず、次に試す時刻が来たもの。 */
  cleanupCandidates(): string[] {
    const now = Date.now();
    const backoff = this.backoff();
    return [...new Set([...Object.keys(this.subscriptions()), ...this.unsure()])].filter(
      (recipient) => (backoff[recipient]?.next ?? 0) <= now && !this.inUse(recipient, now),
    );
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
