import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

const MINUTE = 60_000;
const ID = z.string().regex(/^[1-9][0-9]{0,18}$/);
const Kinds = z.enum(["post.mention.create", "post.reply.create"]);
const webhookURL = z.url().refine((value) => {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === "/webhooks/x" &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.workers\.dev$/.test(
      url.hostname,
    )
  );
});
const Config = z.strictObject({
  user_id: ID,
  username: z.string().regex(/^[A-Za-z0-9_]{1,15}$/),
  webhook_id: ID,
  webhook_url: webhookURL,
});
const Approval = z.strictObject({
  live_x_api: z.literal(true),
  dedicated_app: z.literal(true),
  expires_at: z.iso.datetime(),
  billing_checked_at: z.iso.datetime(),
  cycle_cap_usd: z.number().positive().max(1),
  auto_recharge: z.literal(false),
});
const Token = z.object({
  access_token: z
    .string()
    .min(1)
    .max(8192)
    .regex(/^[A-Za-z0-9._~+/-]+=*$/),
  token_type: z.literal("bearer"),
  scope: z.string(),
  expires_at: z.number().finite(),
  client_id: z.string().min(1).max(4096),
});
const State = z.strictObject({
  phase: z.enum(["preparing", "running", "cleaning", "finished"]),
  config: Config,
  started_at: z.number().finite().positive(),
  expires_at: z.iso.datetime().nullable(),
  tag: z.string().regex(/^tweetbot-setup-[a-f0-9-]{36}$/),
  requests: z.number().int().min(0).max(20),
  creation_attempted: z.boolean(),
  cleaned: z.boolean(),
  subscriptions: z.array(z.strictObject({ id: ID, type: Kinds, deleted: z.boolean() })).max(2),
});
const Row = z.object({
  subscription_id: ID,
  event_type: z.string(),
  filter: z.object({ user_id: ID.optional() }),
  webhook_id: ID.optional(),
  tag: z.string().optional(),
  expires_at: z.iso.datetime().optional(),
  created_at: z.iso.datetime().optional(),
});
export class ActivityFailure extends Error {
  constructor() {
    super("activity_session_failed");
  }
}
function directoryInfo(directory) {
  const stat = lstatSync(directory);
  if (
    !isAbsolute(directory) ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid() ||
    stat.mode & 0o077
  )
    throw new ActivityFailure();
}
function privateText(directory, name, limit = 65536) {
  const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > limit)
      throw new ActivityFailure();
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}
function privateJSON(directory, name) {
  return JSON.parse(privateText(directory, name));
}
function credential(directory, name) {
  const value = privateText(directory, name, 8192).trim();
  if (!/^[\x21-\x7e]{1,8192}$/.test(value)) throw new ActivityFailure();
  return value;
}
function store(directory, state) {
  const path = join(directory, "activity-session.json");
  const temporary = join(directory, `.activity-${randomUUID()}.tmp`);
  let fd;
  try {
    fd = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) closeSync(fd);
    if (existsSync(temporary)) unlinkSync(temporary);
  }
}
function lock(directory) {
  const path = join(directory, "activity-session.lock");
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  const identity = fstatSync(fd);
  try {
    writeFileSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(path);
    throw error;
  }
  return () => {
    closeSync(fd);
    if (existsSync(path)) {
      const current = lstatSync(path);
      if (current.ino === identity.ino && current.dev === identity.dev) unlinkSync(path);
    }
  };
}
function owns(state, row) {
  return (
    row.tag === state.tag &&
    row.filter.user_id === state.config.user_id &&
    row.webhook_id === state.config.webhook_id &&
    Kinds.safeParse(row.event_type).success
  );
}
function remember(state, row) {
  if (!owns(state, row)) throw new ActivityFailure();
  const existing = state.subscriptions.find((value) => value.id === row.subscription_id);
  if (existing && existing.type !== row.event_type) throw new ActivityFailure();
  if (!existing) {
    if (state.subscriptions.length >= 2) throw new ActivityFailure();
    state.subscriptions.push({
      id: row.subscription_id,
      type: Kinds.parse(row.event_type),
      deleted: false,
    });
  }
}
async function responseJSON(response) {
  if (!response.body) throw new ActivityFailure();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 65536) throw new ActivityFailure();
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
  const root = z
    .object({
      data: z.unknown().optional(),
      errors: z.array(z.unknown()).optional(),
      meta: z
        .object({ next_token: z.string().optional(), result_count: z.number().optional() })
        .optional(),
    })
    .parse(data);
  if (root.errors?.length) throw new ActivityFailure();
  return root;
}
function client({ directory, state, app, user, fetchImpl, now, signal, operationDeadline }) {
  return async (method, path, body, cleanup = false) => {
    const listPath = `/2/activity/subscriptions?max_results=100&user_id=${state.config.user_id}`;
    const deletion =
      /^\/2\/activity\/subscriptions\/[1-9][0-9]{0,18}$/.test(path) && method === "DELETE";
    const userContext = method === "POST" || path === "/2/users/me";
    const allowed =
      (method === "GET" &&
        [
          "/2/usage/credits",
          "/2/users/me",
          listPath,
          "/2/webhooks?webhook_config.fields=id,url,valid",
        ].includes(path)) ||
      (method === "PUT" && path === `/2/webhooks/${state.config.webhook_id}`) ||
      (method === "POST" && path === "/2/activity/subscriptions") ||
      deletion;
    if (
      !allowed ||
      (cleanup && !(deletion || (method === "GET" && path === listPath))) ||
      state.requests >= (cleanup ? 20 : 12) ||
      (method === "POST" &&
        (Date.parse(state.expires_at ?? "") > operationDeadline ||
          now() >= Date.parse(state.expires_at ?? ""))) ||
      (!cleanup &&
        (signal?.aborted ||
          now() >= operationDeadline ||
          now() - state.started_at > 2 * 60 * MINUTE))
    )
      throw new ActivityFailure();
    state.requests++;
    store(directory, state);
    const timeout = AbortSignal.timeout(
      cleanup ? 15000 : Math.max(1, Math.min(15000, operationDeadline - now())),
    );
    const response = await fetchImpl(`https://api.x.com${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${userContext ? user : app}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: !cleanup && signal ? AbortSignal.any([timeout, signal]) : timeout,
    });
    if (cleanup && deletion && response.status === 404) {
      await response.body?.cancel();
      return {};
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new ActivityFailure();
    }
    return responseJSON(response);
  };
}
async function rows(request, state, cleanup = false) {
  const root = await request(
    "GET",
    `/2/activity/subscriptions?max_results=100&user_id=${state.config.user_id}`,
    undefined,
    cleanup,
  );
  const values =
    root.data === undefined && root.meta?.result_count === 0
      ? []
      : z.array(Row).max(100).parse(root.data);
  return { values, complete: !root.meta?.next_token };
}
async function cleanupSession(directory, state, request) {
  if (!state.creation_attempted) {
    state.cleaned = true;
    store(directory, state);
    return;
  }
  state.phase = "cleaning";
  for (let pass = 0; pass < 2; pass++) {
    try {
      const current = await rows(request, state, true);
      for (const row of current.values.filter((value) => owns(state, value))) remember(state, row);
      store(directory, state);
    } catch {}
    for (const record of state.subscriptions.filter((value) => !value.deleted)) {
      try {
        await request("DELETE", `/2/activity/subscriptions/${record.id}`, undefined, true);
        record.deleted = true;
        store(directory, state);
      } catch {}
    }
  }
  const remaining = await rows(request, state, true);
  state.cleaned = remaining.complete && !remaining.values.some((row) => owns(state, row));
  store(directory, state);
  if (!state.cleaned) throw new ActivityFailure();
}
function waitForStop(milliseconds, signal) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    signal?.addEventListener("abort", finish, { once: true });
  });
}
export function planSession(directory) {
  try {
    directoryInfo(directory);
    Config.parse(privateJSON(directory, "activity-setup.json"));
    return {
      status: "plan",
      network_requests: 0,
      maximum_requests: 20,
      subscription_minutes: 30,
      owner_approval_required: true,
      cloudflare_managed: false,
    };
  } catch {
    throw new ActivityFailure();
  }
}
export async function runSession({
  directory,
  fetchImpl = fetch,
  now = Date.now,
  signal,
  onReady = () => {},
  wait = waitForStop,
  recover = false,
}) {
  let release;
  let state;
  let request;
  let failed = false;
  try {
    directoryInfo(directory);
    release = lock(directory);
    const config = Config.parse(privateJSON(directory, "activity-setup.json"));
    const app = credential(directory, "app-bearer-token.txt");
    if (recover) {
      state = State.parse(privateJSON(directory, "activity-session.json"));
      if (JSON.stringify(state.config) !== JSON.stringify(config) || state.started_at > now())
        throw new ActivityFailure();
      request = client({ directory, state, app, fetchImpl, now });
    } else {
      if (existsSync(join(directory, "activity-session.json"))) throw new ActivityFailure();
      const approval = Approval.parse(privateJSON(directory, "activity-approval.json"));
      const expiry = Date.parse(approval.expires_at),
        checked = Date.parse(approval.billing_checked_at);
      if (
        expiry < now() + 45 * MINUTE ||
        expiry > now() + 2 * 60 * MINUTE ||
        checked > now() ||
        now() - checked > 15 * MINUTE
      )
        throw new ActivityFailure();
      const token = Token.parse(privateJSON(directory, "user-token.json"));
      const clientID = credential(directory, "client-id.txt");
      if (
        token.client_id !== clientID ||
        token.expires_at < now() + 45 * MINUTE ||
        token.scope.split(" ").sort().join(" ") !== "tweet.read users.read"
      )
        throw new ActivityFailure();
      state = {
        phase: "preparing",
        config,
        started_at: now(),
        expires_at: null,
        tag: `tweetbot-setup-${randomUUID()}`,
        requests: 0,
        creation_attempted: false,
        cleaned: false,
        subscriptions: [],
      };
      store(directory, state);
      request = client({
        directory,
        state,
        app,
        user: token.access_token,
        fetchImpl,
        now,
        signal,
        operationDeadline: Math.min(expiry, token.expires_at),
      });
      const credits = await request("GET", "/2/usage/credits");
      if (
        z.object({ total_balance: z.number().finite().min(1) }).parse(credits.data).total_balance <
        1
      )
        throw new ActivityFailure();
      const me = z
        .object({ id: ID, username: z.string() })
        .parse((await request("GET", "/2/users/me")).data);
      if (me.id !== config.user_id || me.username.toLowerCase() !== config.username.toLowerCase())
        throw new ActivityFailure();
      const hooks = z
        .array(z.object({ id: ID, url: z.string(), valid: z.boolean() }))
        .max(100)
        .parse((await request("GET", "/2/webhooks?webhook_config.fields=id,url,valid")).data);
      const hook = hooks.find((value) => value.id === config.webhook_id);
      if (!hook) throw new ActivityFailure();
      if (hook.id !== config.webhook_id || hook.url !== config.webhook_url)
        throw new ActivityFailure();
      if (
        !hook.valid &&
        z
          .object({ valid: z.literal(true) })
          .parse((await request("PUT", `/2/webhooks/${config.webhook_id}`)).data).valid !== true
      )
        throw new ActivityFailure();
      const before = await rows(request, state);
      if (!before.complete || before.values.length) throw new ActivityFailure();
      state.expires_at = new Date(now() + 30 * MINUTE).toISOString();
      if (Date.parse(state.expires_at) > Math.min(expiry, token.expires_at))
        throw new ActivityFailure();
      store(directory, state);
      for (const type of Kinds.options) {
        state.creation_attempted = true;
        store(directory, state);
        const result = await request("POST", "/2/activity/subscriptions", {
          event_type: type,
          filter: { user_id: config.user_id },
          webhook_id: config.webhook_id,
          tag: state.tag,
          expires_at: state.expires_at,
        });
        const row = Row.parse(
          z.object({ subscription: z.unknown() }).parse(result.data).subscription,
        );
        if (
          !owns(state, row) ||
          row.event_type !== type ||
          Date.parse(row.expires_at ?? "") !== Date.parse(state.expires_at) ||
          (row.created_at && Date.parse(row.created_at) < state.started_at - MINUTE)
        )
          throw new ActivityFailure();
        remember(state, row);
        store(directory, state);
      }
      const confirmed = await rows(request, state);
      if (
        !confirmed.complete ||
        confirmed.values.length !== 2 ||
        !Kinds.options.every(
          (type) =>
            confirmed.values.filter(
              (row) =>
                owns(state, row) &&
                row.event_type === type &&
                Date.parse(row.expires_at ?? "") === Date.parse(state.expires_at),
            ).length === 1,
        )
      )
        throw new ActivityFailure();
      state.phase = "running";
      store(directory, state);
      await onReady({
        status: "ready",
        subscriptions: 2,
        expires_at: state.expires_at,
        requests: state.requests,
      });
      await wait(Math.max(0, Date.parse(state.expires_at) - now()), signal);
    }
  } catch {
    failed = true;
  } finally {
    if (state && request) {
      try {
        await cleanupSession(directory, state, request);
      } catch {
        failed = true;
      }
      state.phase = "finished";
      try {
        store(directory, state);
      } catch {
        failed = true;
      }
    }
    if (release) {
      try {
        release();
      } catch {
        failed = true;
      }
    }
  }
  if (failed || !state?.cleaned) throw new ActivityFailure();
  return {
    status: "cleaned",
    subscriptions_removed: state.subscriptions.length,
    requests: state.requests,
    worker_action: "disable_x_and_verify",
  };
}
if (import.meta.main) {
  const [command, directory, ...extra] = process.argv.slice(2);
  const interrupted = new AbortController();
  const stop = () => interrupted.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    if (!directory || extra.length || !["plan", "run", "recover"].includes(command))
      throw new ActivityFailure();
    const result =
      command === "plan"
        ? planSession(directory)
        : await runSession({
            directory,
            recover: command === "recover",
            signal: interrupted.signal,
            onReady: (value) => {
              console.log(JSON.stringify(value));
            },
          });
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      JSON.stringify({ status: "failed", action: "inspect_private_state_and_disable_worker" }),
    );
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
