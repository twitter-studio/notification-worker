import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  ActivityFailure,
  Config,
  credential,
  directoryInfo,
  ID,
  Kinds,
  lock,
  privateJSON,
  Row,
  responseJSON,
  store,
  Token,
} from "./x-activity-session.mjs";

const journal = "activity-subscriptions.json";
const endpoint = "/2/activity/subscriptions";
const Expiration = z.iso.datetime().nullable();
const Command = z.enum(["status", "start", "renew", "stop"]);
const State = z.strictObject({
  config: Config,
  client_id: z.string().min(1).max(4096),
  app_proof: z.string().regex(/^[a-f0-9]{64}$/),
  pending: Kinds.nullable(),
  tag: z.string().regex(/^tweetbot-subscriptions-[a-f0-9-]{36}$/),
  phase: z.enum(["starting", "active", "renewing", "stopping", "stopped"]),
  expires_at: Expiration,
  ids: z.partialRecord(Kinds, ID.nullable()),
});

function expirationMatches(row, expiry) {
  return expiry === null
    ? row.expires_at === undefined
    : Date.parse(row.expires_at ?? "") === Date.parse(expiry);
}

function ownedRows(rows, state) {
  const owned = new Map();
  for (const row of rows) {
    const sameUser = row.filter.user_id === state.config.user_id;
    const kind = Kinds.safeParse(row.event_type);
    const tracked = Object.values(state.ids).includes(row.subscription_id);
    if (row.tag !== state.tag && !tracked) {
      if (sameUser && kind.success && ["starting", "active", "renewing"].includes(state.phase))
        throw new ActivityFailure();
      continue;
    }
    if (
      !sameUser ||
      !kind.success ||
      row.webhook_id !== state.config.webhook_id ||
      row.tag !== state.tag ||
      !Object.hasOwn(state.ids, kind.data) ||
      (state.ids[kind.data] !== null && state.ids[kind.data] !== row.subscription_id) ||
      owned.has(kind.data)
    )
      throw new ActivityFailure();
    owned.set(kind.data, row);
  }
  return owned;
}

class SubscriptionUnchanged extends ActivityFailure {}

function client(fetchImpl, app, token, now) {
  return async (method, path, body, signal) => {
    const userContext = method === "POST" || path === "/2/users/me";
    if (signal?.aborted || (userContext && (!token || token.expires_at <= now()))) {
      if (method === "POST") throw new SubscriptionUnchanged();
      throw new ActivityFailure();
    }
    const timeout = AbortSignal.timeout(15000);
    const response = await fetchImpl(`https://api.x.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${userContext ? token.access_token : app}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      if (method === "POST" && [400, 401, 403, 404, 422, 429].includes(response.status))
        throw new SubscriptionUnchanged();
      throw new ActivityFailure();
    }
    const data = await responseJSON(response);
    if (method === "DELETE") z.object({ deleted: z.literal(true) }).parse(data.data);
    return data;
  };
}

async function list(request, userID, signal) {
  const rows = [];
  const pages = new Set();
  const ids = new Set();
  const query = new URLSearchParams({ max_results: "100", user_id: userID });
  for (;;) {
    const root = await request("GET", `${endpoint}?${query}`, undefined, signal);
    const page =
      root.data === undefined && root.meta?.result_count === 0
        ? []
        : z.array(Row).max(100).parse(root.data);
    for (const row of page) {
      if (ids.has(row.subscription_id)) throw new ActivityFailure();
      ids.add(row.subscription_id);
      rows.push(row);
    }
    const next = root.meta?.next_token;
    if (next === undefined) return rows;
    if (!next || next.length > 256 || pages.has(next) || pages.size >= 100)
      throw new ActivityFailure();
    pages.add(next);
    query.set("pagination_token", next);
  }
}

async function verifyWebhook(request, config, writing, signal) {
  const root = await request(
    "GET",
    "/2/webhooks?webhook_config.fields=id,url,valid",
    undefined,
    signal,
  );
  const hooks = z.array(z.object({ id: ID, url: z.string(), valid: z.boolean() })).parse(root.data);
  const matches = hooks.filter(({ id }) => id === config.webhook_id);
  if (
    matches.length !== 1 ||
    matches[0].url !== config.webhook_url ||
    (writing && !matches[0].valid)
  )
    throw new ActivityFailure();
}

export async function manageSubscriptions({
  command,
  directory,
  expiresAt,
  confirmed = false,
  fetchImpl = fetch,
  now = Date.now,
  signal,
}) {
  let release;
  try {
    Command.parse(command);
    const writing = command === "start" || command === "renew";
    if (command !== "status" && !confirmed) throw new ActivityFailure();
    if (writing) {
      Expiration.parse(expiresAt);
      if (
        (expiresAt !== null && Date.parse(expiresAt) <= now()) ||
        (command === "renew" && expiresAt === null)
      )
        throw new ActivityFailure();
    } else if (expiresAt !== undefined) {
      throw new ActivityFailure();
    }
    directoryInfo(directory);
    release = lock(directory);
    const config = Config.parse(privateJSON(directory, "activity-setup.json"));
    const clientID = credential(directory, "client-id.txt");
    const app = credential(directory, "app-bearer-token.txt");
    const appProof = createHash("sha256").update(app).digest("hex");
    let state = existsSync(join(directory, journal))
      ? State.parse(privateJSON(directory, journal))
      : undefined;
    if (
      state &&
      (JSON.stringify(state.config) !== JSON.stringify(config) || state.client_id !== clientID)
    )
      throw new ActivityFailure();
    if (!state && command !== "start") throw new ActivityFailure();

    const token = writing ? Token.parse(privateJSON(directory, "user-token.json")) : undefined;
    if (
      token &&
      (token.client_id !== clientID ||
        token.expires_at <= now() ||
        token.scope.split(" ").sort().join(" ") !== "tweet.read users.read")
    )
      throw new ActivityFailure();
    const request = client(fetchImpl, app, token, now);
    if (writing) {
      const me = z
        .object({ id: ID, username: z.string() })
        .parse((await request("GET", "/2/users/me", undefined, signal)).data);
      if (me.id !== config.user_id || me.username.toLowerCase() !== config.username.toLowerCase())
        throw new ActivityFailure();
    }
    if (writing || state?.app_proof !== appProof)
      await verifyWebhook(request, config, writing, signal);
    const before = await list(request, config.user_id, signal);
    const save = () => store(directory, state, journal);
    if (command === "start" && (!state || state.phase === "stopped")) {
      state = {
        config,
        client_id: clientID,
        app_proof: appProof,
        pending: null,
        tag: `tweetbot-subscriptions-${randomUUID()}`,
        phase: "starting",
        expires_at: expiresAt,
        ids: {},
      };
    }
    if (command === "stop") state.phase = "stopping";
    const owned = ownedRows(before, state);
    if (state.pending !== null && command !== "status") {
      const row = owned.get(state.pending);
      if (row && expirationMatches(row, state.expires_at)) {
        state.ids[state.pending] = row.subscription_id;
        state.pending = null;
      } else if (state.expires_at !== null && Date.parse(state.expires_at) <= now()) {
        state.pending = null;
      } else if (command !== "stop") {
        throw new ActivityFailure();
      }
      save();
    }
    if (command === "stop") {
      save();
      for (const [kind, row] of owned) {
        if (kind !== state.pending)
          await request("DELETE", `${endpoint}/${row.subscription_id}`, undefined, signal);
      }
      const remaining = ownedRows(await list(request, config.user_id, signal), state);
      if (state.pending !== null || remaining.size) throw new ActivityFailure();
      state.phase = "stopped";
      save();
      return { status: "stopped", subscriptions: 0 };
    }
    if (command === "status") {
      return {
        status: state.phase,
        subscriptions: owned.size,
        expires_at: state.expires_at,
        matches_record:
          ((state.phase === "active" && owned.size === Kinds.options.length) ||
            (state.phase === "stopped" && owned.size === 0)) &&
          [...owned.values()].every((row) => expirationMatches(row, state.expires_at)),
      };
    }

    if (command === "renew" && state.phase === "active") {
      if (
        owned.size !== Kinds.options.length ||
        state.expires_at === null ||
        Date.parse(expiresAt) <= Date.parse(state.expires_at) ||
        [...owned.values()].some((row) => !expirationMatches(row, state.expires_at))
      )
        throw new ActivityFailure();
      state.phase = "renewing";
      state.expires_at = expiresAt;
    }
    const expectedPhase = command === "start" ? "starting" : "renewing";
    if (
      state.phase !== expectedPhase ||
      state.expires_at !== expiresAt ||
      (command === "renew" && owned.size !== Kinds.options.length)
    )
      throw new ActivityFailure();
    save();
    for (const kind of Kinds.options) {
      const row = owned.get(kind);
      if (row && expirationMatches(row, expiresAt)) {
        state.ids[kind] = row.subscription_id;
        save();
        continue;
      }
      if (
        (!row && state.ids[kind]) ||
        (command === "renew" && (!row?.expires_at || Date.parse(row.expires_at) <= now())) ||
        (expiresAt !== null && Date.parse(expiresAt) <= now())
      )
        throw new ActivityFailure();
      state.ids[kind] = row?.subscription_id ?? null;
      state.pending = kind;
      save();
      let reply;
      try {
        reply = await request(
          "POST",
          endpoint,
          {
            event_type: kind,
            filter: { user_id: config.user_id },
            webhook_id: config.webhook_id,
            tag: state.tag,
            ...(expiresAt === null ? {} : { expires_at: expiresAt }),
          },
          signal,
        );
      } catch (error) {
        if (error instanceof SubscriptionUnchanged) {
          if (state.ids[kind] === null) delete state.ids[kind];
          state.pending = null;
          save();
        }
        throw error;
      }
      const created = Row.parse(
        z.object({ subscription: z.unknown() }).parse(reply.data).subscription,
      );
      const createdRows = ownedRows([created], state);
      if (!createdRows.has(kind) || !expirationMatches(created, expiresAt))
        throw new ActivityFailure();
      state.ids[kind] = created.subscription_id;
      state.pending = null;
      save();
    }
    const after = ownedRows(await list(request, config.user_id, signal), state);
    if (
      after.size !== Kinds.options.length ||
      [...after.values()].some((row) => !expirationMatches(row, expiresAt))
    )
      throw new ActivityFailure();
    state.phase = "active";
    save();
    return { status: "active", subscriptions: after.size, expires_at: expiresAt };
  } catch {
    throw new ActivityFailure();
  } finally {
    release?.();
  }
}

if (import.meta.main) {
  const [command, directory, confirmation, expiration, ...extra] = process.argv.slice(2);
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!directory || extra.length || (confirmation !== undefined && confirmation !== "--confirm"))
      throw new ActivityFailure();
    const result = await manageSubscriptions({
      command,
      directory,
      confirmed: confirmation === "--confirm",
      expiresAt: expiration === "--no-expiry" ? null : expiration,
      signal: interrupted.signal,
    });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      JSON.stringify({ status: "failed", action: "check_private_subscription_record" }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
