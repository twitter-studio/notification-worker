import { z } from "zod";
import { discardBody, readBody } from "./body";
import { ConfigError, xRelayTargets } from "./config";
import type { X_NOTIFICATION_TYPES } from "./normalize";
import type { pairingStore } from "./pairing-store";
import type { RelayDeps } from "./relay";

type NotificationType = (typeof X_NOTIFICATION_TYPES)[number];
type Store = NonNullable<ReturnType<typeof pairingStore>>;

/** X の購読の 1 つ。`direction` は OpenAPI の `filter.direction` で送る (概要は、`filter.qualifiers.direction` と同じものとしている)。 */
type Spec = { event_type: string; direction?: "inbound" };

/** 通知の種類ごとに要る X の購読。DM は従来の DM と X Chat を別々に購読する。 */
const specs: Record<NotificationType, Spec[]> = {
  mention: [{ event_type: "post.mention.create" }],
  reply: [{ event_type: "post.reply.create" }],
  quote: [{ event_type: "post.quote.create" }],
  retweet: [{ event_type: "post.repost.create" }],
  like: [{ event_type: "like.create", direction: "inbound" }],
  follow: [{ event_type: "follow.follow", direction: "inbound" }],
  dm: [{ event_type: "dm.received" }, { event_type: "chat.received" }],
};

/**
 * Worker が作った購読に付ける tag の頭。後ろに Worker の印と試みごとの印を付ける (`tweetbot-worker-connect-<Worker>-<試み>`)。
 * 記録をなくしても一覧からこの Worker が作ったものを見分けられ (同じ X アプリを使うほかの Worker の購読には触れない)、
 * 結果の分からない作成を拾い直すときに、今回の試みのものだけを拾える。
 */
export const workerTag = "tweetbot-worker-connect";

/** この Worker が作った購読の tag の頭。 */
function workerPrefix(workerID: string): string {
  return `${workerTag}-${workerID}-`;
}

/** 外への要求を 1 回で打ち切る時間。 */
const callTimeout = 10_000;

/**
 * 選んだ種類の購読に要る scope。`users.read` は本人の ID を確かめるために常に要る。
 * `offline.access` は求めない (refresh token を Worker に残さない。ADR-0008)。
 */
export function scopesFor(types: readonly NotificationType[]): string[] {
  const scopes = new Set(["tweet.read", "users.read"]);
  if (types.includes("like")) scopes.add("like.read");
  if (types.includes("dm")) scopes.add("dm.read");
  return [...scopes];
}

const api = "https://api.x.com";
/** DELETE のパスに入れる値なので、`..` などでほかのパスへ飛ばないよう、形を決めて受ける。 */
const SubscriptionID = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const Row = z.object({
  subscription_id: SubscriptionID,
  event_type: z.string(),
  webhook_id: z.string().optional(),
  tag: z.string().optional(),
  filter: z
    .object({
      user_id: z.string().optional(),
      direction: z.string().optional(),
      qualifiers: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
type Subscription = z.infer<typeof Row>;
const Page = z.object({
  data: z.array(Row).optional(),
  meta: z.object({ next_token: z.string().optional() }).optional(),
});
const Created = z.object({
  data: z.object({ subscription: z.object({ subscription_id: SubscriptionID }) }),
});
const Deleted = z.object({ data: z.object({ deleted: z.literal(true) }) });

/** X の応答を、読む前に大きさを絞って JSON で読む。読めなければ undefined。 */
export async function readJSON(response: Response, limit = 65_536): Promise<unknown> {
  const body = await readBody(response, limit).catch(() => undefined);
  if (body === undefined || body.length === 0) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(body));
  } catch {
    return undefined;
  }
}

/**
 * X の API を呼ぶ。1 回 10 秒で打ち切り、`deadline` を過ぎたら呼ばない (処理中の印や、片付けの印の期限の中で終える)。
 * Workers の fetch は redirect の "error" を受け付けない。"manual" にし、3xx は状態コードの確かめで失敗にする (#33 と同じ)。
 */
async function call(
  deps: RelayDeps,
  method: "GET" | "POST" | "DELETE",
  path: string,
  token: string,
  options: { body?: unknown; deadline?: number | undefined } = {},
): Promise<Response | undefined> {
  const { body, deadline = Number.POSITIVE_INFINITY } = options;
  const left = deadline - Date.now();
  if (left <= 0) return undefined;
  return deps
    .fetch(`${api}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      redirect: "manual",
      signal: AbortSignal.timeout(Math.min(callTimeout, left)),
    })
    .catch(() => undefined);
}

function direction(row: Subscription): unknown {
  return row.filter?.direction ?? row.filter?.qualifiers?.direction;
}

/** 選んだ種類を、その購読がそのまま受け取れるか。向き以外で絞った購読 (投稿の ID など) は、受け取れないものとする。 */
function covers(row: Subscription, spec: Spec): boolean {
  return (
    row.event_type === spec.event_type &&
    direction(row) === spec.direction &&
    Object.keys(row.filter?.qualifiers ?? {}).every((key) => key === "direction")
  );
}

/**
 * そのアカウントの購読を、すべてのページから読む。`webhookID` を渡せば、その Webhook のものに絞る。読めなければ undefined。
 */
async function listSubscriptions(
  recipient: string,
  bearer: string,
  deps: RelayDeps,
  options: { webhookID?: string | undefined; deadline?: number | undefined } = {},
): Promise<Subscription[] | undefined> {
  const { webhookID, deadline } = options;
  const rows: Subscription[] = [];
  const query = new URLSearchParams({ max_results: "100", user_id: recipient });
  // 購読の上限 (1,500) を 100 件ずつ読んでも足りる回数に絞る。
  for (let page = 0; page < 16; page += 1) {
    const response = await call(deps, "GET", `/2/activity/subscriptions?${query}`, bearer, {
      deadline,
    });
    if (response?.status !== 200) {
      await discardBody(response);
      return undefined;
    }
    const parsed = Page.safeParse(await readJSON(response, 1_048_576));
    if (!parsed.success) return undefined;
    rows.push(
      ...(parsed.data.data ?? []).filter(
        (row) =>
          row.filter?.user_id === recipient &&
          (webhookID === undefined || row.webhook_id === webhookID),
      ),
    );
    const next = parsed.data.meta?.next_token;
    if (next === undefined) return rows;
    query.set("pagination_token", next);
  }
  return undefined;
}

/** この Worker が作った購読 (tag が `workerPrefix` で始まる) の ID。 */
function workerRows(rows: readonly Subscription[], workerID: string): string[] {
  return rows
    .filter((row) => row.tag?.startsWith(workerPrefix(workerID)) === true)
    .map((row) => row.subscription_id);
}

/**
 * 選んだ種類の購読のうち、まだないものを本人のトークンで作り、作ったらすぐ記録する (後で失敗しても、記録のない購読を残さない)。
 * 持ち主が手で作った購読はそのまま使い、記録しない。Worker の tag の購読は、前に作って記録をなくしたもの、
 * またはほかの端末の接続が作ったものとして記録し直す (接続したルートがあれば、片付けでは消さない)。
 * 途中で失敗したら、今回作ったものを消して false を返す。消せなかったものは記録に残り、定期の処理で片付ける。
 * 期限は付けない (購読は消すまで続く)。期限のある購読が既にあれば、それを使う (手順書に書く)。
 */
export async function ensureSubscriptions(options: {
  store: Store;
  recipient: string;
  types: readonly NotificationType[];
  webhookID: string;
  userToken: string;
  bearer: string;
  workerID: string;
  attempt: string;
  deadline: number;
  /** 戻しを始める前に、処理中の印をこの時刻まで延ばす。印が切れていて延ばせなければ false。 */
  extendLease: (until: number) => Promise<boolean>;
  deps: RelayDeps;
}): Promise<boolean> {
  const { store, recipient, types, webhookID, userToken, bearer, workerID, deadline, deps } =
    options;
  const tag = `${workerPrefix(workerID)}${options.attempt}`;
  const created: string[] = [];
  const list = () => listSubscriptions(recipient, bearer, deps, { webhookID, deadline });
  let marked = false;
  try {
    let existing = await list();
    if (existing === undefined) return false;
    await store.recordSubscriptions(recipient, workerRows(existing, workerID));
    for (const spec of [...new Set(types)].flatMap((type) => specs[type])) {
      if (existing.some((row) => covers(row, spec))) continue;
      // 締め切りの後は送らない。送っていないので、作られていないと分かる。
      if (Date.now() >= deadline) throw new Error("deadline");
      // 作る前に、確かめの印を残す。要求を送った後に処理が打ち切られても (アプリを閉じて接続が切れたなど)、
      // 定期の処理が一覧で探して記録に取り込める。印は片付けが一覧を読んだときに外す (処理中の接続がないと分かっているとき)。
      if (!marked) {
        await store.markUnsure(recipient);
        marked = true;
      }
      const response = await call(deps, "POST", "/2/activity/subscriptions", userToken, {
        body: {
          event_type: spec.event_type,
          filter: { user_id: recipient, ...(spec.direction ? { direction: spec.direction } : {}) },
          webhook_id: webhookID,
          tag,
        },
        deadline,
      });
      const status = response?.status;
      const parsed =
        response !== undefined && (status === 200 || status === 201)
          ? Created.safeParse(await readJSON(response))
          : undefined;
      await discardBody(response);
      if (parsed?.success) {
        created.push(parsed.data.data.subscription.subscription_id);
        await store.recordSubscriptions(recipient, [parsed.data.data.subscription.subscription_id]);
        continue;
      }
      // 409 のほかの 4xx は、作られなかったと分かる。
      if (status !== undefined && status >= 400 && status < 500 && status !== 409)
        throw new Error("create");
      // 結果が分からない (応答がない、2xx で読めない、3xx、5xx) か、同じ購読が既にある (409)。一覧し直して確かめる。
      // 今回作ったものとして拾うのは、今回の試みの tag の購読だけ (ほかの端末の接続が作った購読を、戻すときに消さない)。
      const again = await list();
      if (again !== undefined) {
        for (const row of again)
          if (row.tag === tag && !created.includes(row.subscription_id))
            created.push(row.subscription_id);
        await store.recordSubscriptions(recipient, workerRows(again, workerID));
        existing = again;
        if (again.some((row) => covers(row, spec))) continue;
      }
      // 作られたかどうか分からないまま終わる。一覧に後から出てくることがあるので、確かめの印のとおり、定期の処理が探す。
      throw new Error("create");
    }
    return true;
  } catch {
    // 戻すときは、作るのに使えた本人のトークンで消す (App-only の Bearer で消せるかは、まだ確かめていない)。
    // 締め切りは付けない (締め切りで打ち切った後も、作ったものは消しておく)。処理中の印が切れた後なら、片付けと同じ ID を
    // 消し合うことがあるが、どちらも消すだけなので害はない。印は、消し終えるまで延ばしておく。
    // 印が切れていたら消さない。同じアカウントのほかの接続が、これから消す購読を使い始めているかもしれない。
    // 作ったものは記録に残っているので、使われていなければ片付けが消す。
    const extended = await options
      .extendLease(Date.now() + created.length * callTimeout + 60_000)
      .catch(() => false);
    if (!extended) return false;
    const removed = await deleteSubscriptions(created, userToken, deps);
    await store.forgetSubscriptions(recipient, removed).catch(() => undefined);
    return false;
  }
}

/** 購読を消す。`deleted: true` が返って消えたと分かった ID を返す。404 は、トークンからは見えないだけのこともあるので含めない。 */
export async function deleteSubscriptions(
  ids: readonly string[],
  token: string,
  deps: RelayDeps,
  deadline?: number,
): Promise<string[]> {
  const deleted: string[] = [];
  for (const id of ids) {
    if (!SubscriptionID.safeParse(id).success) continue;
    const response = await call(deps, "DELETE", `/2/activity/subscriptions/${id}`, token, {
      deadline,
    });
    const gone = response?.status === 200 && Deleted.safeParse(await readJSON(response)).success;
    await discardBody(response);
    if (gone) deleted.push(id);
  }
  return deleted;
}

/** 定期の処理で、片付けにかけてよい時間。 */
export const cleanupBudget = 4 * 60_000;

/**
 * アカウントの購読が使われていなければ (接続したルート、有効なコード、処理中の接続、手動の配送先のどれもない)、
 * Worker が作った購読を消す。消えたと分かったものだけを記録から外し、残りは定期の処理でやり直す。
 * 購読を作り始めたアカウントは、先に Worker の tag の購読を一覧で探して記録に取り込む。
 * `budget` の後は要求を出さない。片付けの印は、それより 1 分長く付け、その間はそのアカウントの接続を始めない。
 */
export async function releaseWorkerSubscriptions(
  env: Env,
  store: Store,
  recipient: string,
  deps: RelayDeps,
  budget = cleanupBudget,
): Promise<void> {
  const bearer = env.X_APP_BEARER_TOKEN ?? "";
  if (bearer.length === 0) return;
  if (xRelayTargets(env, true).some((target) => target.recipient === recipient)) return;
  const release = await store.beginRelease(recipient, Date.now() + budget + 60_000);
  if (release === undefined) return;
  const deadline = Date.now() + budget;
  let failed = true;
  let retryAt: number | undefined;
  try {
    let ids = release.ids;
    let listFailed = false;
    if (release.unsure) {
      // Webhook では絞らない。Webhook を付け替えた後や、設定が欠けていても、この Worker の tag の購読を拾う。
      const workerID = await store.workerID();
      const listedAt = Date.now();
      const rows = await listSubscriptions(recipient, bearer, deps, { deadline });
      if (rows === undefined) listFailed = true;
      else {
        retryAt = await store.adoptSubscriptions(recipient, workerRows(rows, workerID), listedAt);
        ids = [...new Set([...ids, ...workerRows(rows, workerID)])];
      }
    }
    const deleted = await deleteSubscriptions(ids, bearer, deps, deadline);
    let gone = deleted;
    if (deleted.length < ids.length) {
      // 消せなかったものは、Webhook で絞らない一覧に記録した ID のどれかが見えるときだけ、見えないものを消えたとみなす。
      // どれも見えないときは、Bearer から見えないのか消えたのかが分からないので、記録に残す。
      const rows = await listSubscriptions(recipient, bearer, deps, { deadline });
      const visible = new Set((rows ?? []).map((row) => row.subscription_id));
      if (ids.some((id) => visible.has(id)))
        gone = ids.filter((id) => deleted.includes(id) || !visible.has(id));
    }
    await store.forgetSubscriptions(recipient, gone);
    failed = listFailed || gone.length < ids.length;
    // 締め切りで試せなかったものは、X に断られたのではないので、失敗と数えずに次の定期の処理でやり直す。
    if (failed && Date.now() >= deadline) {
      failed = false;
      retryAt = Math.min(retryAt ?? Number.POSITIVE_INFINITY, Date.now() + 5 * 60_000);
    }
  } finally {
    await store.endRelease(recipient, { failed, retryAt }).catch(() => undefined);
  }
}

/**
 * ルートのないまま残った購読 (コードが使われずに切れた、アプリが途中で落ちた) を、定期の処理で片付ける。
 * 1 回に扱うアカウントを絞り、始める位置を変える (外への要求の回数の上限の中で、どのアカウントも順に片付ける)。
 */
export async function cleanupWorkerSubscriptions(
  env: Env,
  store: Store,
  deps: RelayDeps,
  limit = 3,
): Promise<void> {
  // 手動の配送先のあるアカウントは消さないので、1 回の枠を使わないよう、先に除く。
  // 設定が壊れていて手動の配送先を読めなければ、どのアカウントを消してよいか分からないので、片付けない。
  let manual: Set<string>;
  try {
    manual = new Set(xRelayTargets(env, true).map((target) => target.recipient));
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    console.error(JSON.stringify({ event: "invalid_configuration", setting: error.setting }));
    return;
  }
  const recipients = (await store.cleanupCandidates()).filter(
    (recipient) => !manual.has(recipient),
  );
  const start = recipients.length === 0 ? 0 : Math.floor(Math.random() * recipients.length);
  // 1 回の定期の処理で、締め切りを分け合う (次の 5 分ごとの処理と重ねない)。
  const runDeadline = Date.now() + cleanupBudget;
  for (const recipient of [...recipients.slice(start), ...recipients.slice(0, start)].slice(
    0,
    limit,
  )) {
    // 残りが少なければ始めない (試せずに終わる)。次の定期の処理に回す。
    const left = runDeadline - Date.now();
    if (left < 30_000) break;
    await releaseWorkerSubscriptions(env, store, recipient, deps, left).catch(() => undefined);
  }
}
