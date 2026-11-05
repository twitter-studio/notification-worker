import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { experimental_readRawConfig } from "wrangler";
import { z } from "zod";
import { checkDeploymentGate, DeploymentFailure } from "./deployment-gate.mjs";

const KIND = "worker";
const directory = resolve(import.meta.dirname, "..");
const name = z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/);
const Inputs = z.object({
  CLOUDFLARE_ACCOUNT_ID: z.string().regex(/^[a-f0-9]{32}$/),
  CF_WORKER_SUBDOMAIN: name,
  CF_QUEUE_ID: z.string().regex(/^[a-f0-9]{32}$/),
  WORKER_NAME: name,
  ...(KIND === "service"
    ? { D1_DATABASE_ID: z.uuid() }
    : {
        X_USER_ID: z.string().regex(/^[1-9][0-9]{0,18}$/),
        RELAY_URL: z.url().refine((value) => {
          const u = new URL(value);
          return (
            u.protocol === "https:" &&
            !u.username &&
            !u.password &&
            !u.port &&
            !u.search &&
            !u.hash &&
            u.pathname === "/"
          );
        }),
      }),
});
export function deploymentConfig(env) {
  const input = Inputs.parse(env);
  const configPath = resolve(
    directory,
    KIND === "service" ? "wrangler.jsonc" : "wrangler.example.jsonc",
  );
  const parsed = experimental_readRawConfig({ config: configPath });
  if (parsed.configPath !== configPath || parsed.redirected) throw new DeploymentFailure();
  const config = parsed.rawConfig;
  if (KIND === "service" && input.WORKER_NAME !== "notification-service")
    throw new DeploymentFailure();
  config.name = input.WORKER_NAME;
  config.account_id = input.CLOUDFLARE_ACCOUNT_ID;
  config.main = resolve(directory, "src/index.ts");
  config.send_metrics = false;
  config.preview_urls = false;
  config.workers_dev = true;
  if (KIND === "worker") {
    config.vars = {
      ...config.vars,
      ENABLE_X_ACTIVITY: "false",
      ENABLE_MOCK_EVENTS: "false",
      X_USER_ID: input.X_USER_ID,
      RELAY_URL: input.RELAY_URL,
    };
  } else {
    config.d1_databases[0].database_id = input.D1_DATABASE_ID;
    config.d1_databases[0].migrations_dir = resolve(directory, "../../packages/db/migrations");
    const policy = JSON.parse(config.vars.APP_ATTEST_POLICY);
    if (policy.mode !== "invite_only" || policy.environment !== "development")
      throw new DeploymentFailure();
  }
  return {
    config,
    input,
    origin: `https://${input.WORKER_NAME}.${input.CF_WORKER_SUBDOMAIN}.workers.dev`,
  };
}
const ExpectedSecrets =
  KIND === "worker"
    ? ["RELAY_TOKEN", "X_EVENT_ID_SECRET", "X_OAUTH2_CLIENT_SECRET"]
    : [
        "APNS_PROVIDER_KEYS",
        "CHALLENGE_SIGNING_KEY",
        "DEVICE_TOKEN_FINGERPRINT_KEY",
        "DEVICE_TOKEN_KEYS",
        "ENROLLMENT_INVITE_CODE",
      ];
export function checkSnapshot(snapshot, config) {
  const bindings = z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        text: z.string().optional(),
        id: z.string().optional(),
        queue_name: z.string().optional(),
      }),
    )
    .parse(snapshot.bindings);
  for (const [key, value] of Object.entries(config.vars))
    if (
      !bindings.some(
        (binding) =>
          binding.name === key && binding.type === "plain_text" && binding.text === value,
      )
    )
      throw new DeploymentFailure();
  if (
    !bindings.some(
      (binding) =>
        binding.type === "queue" &&
        binding.name === config.queues.producers[0].binding &&
        binding.queue_name === config.queues.producers[0].queue,
    )
  )
    throw new DeploymentFailure();
  if (
    ExpectedSecrets.some(
      (name) =>
        !bindings.some((binding) => binding.name === name && binding.type === "secret_text"),
    )
  )
    throw new DeploymentFailure();
  if (
    KIND === "service" &&
    !bindings.some(
      (binding) =>
        binding.type === "d1" &&
        binding.name === "DB" &&
        binding.id === config.d1_databases[0].database_id,
    )
  )
    throw new DeploymentFailure();
}
export async function executeDeployment(
  env,
  {
    fetchImpl = fetch,
    runCommand = (command, args, options) => spawnSync(command, args, options),
  } = {},
) {
  const request = await checkDeploymentGate(env, {
    fetchImpl,
    allowMigration: KIND === "service",
    requireApproval: true,
  });
  const { config, input, origin } = deploymentConfig(env);
  if (!env.CLOUDFLARE_API_TOKEN || /[\r\n]/.test(env.CLOUDFLARE_API_TOKEN))
    throw new DeploymentFailure();
  const source = runCommand("git", ["rev-parse", "HEAD"], { cwd: directory, encoding: "utf8" });
  const dirty = runCommand("git", ["status", "--porcelain"], { cwd: directory, encoding: "utf8" });
  if (
    source.status !== 0 ||
    source.stdout.trim() !== request.sha ||
    dirty.status !== 0 ||
    dirty.stdout.trim()
  )
    throw new DeploymentFailure();
  let calls = 0;
  async function response(url, options = {}) {
    if (++calls > 16) throw new DeploymentFailure();
    const result = await fetchImpl(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    return result;
  }
  async function api(path) {
    const result = await response(
      `https://api.cloudflare.com/client/v4/accounts/${input.CLOUDFLARE_ACCOUNT_ID}/${path}`,
      { headers: { Authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` } },
    );
    if (result.status !== 200) {
      await result.body?.cancel();
      throw new DeploymentFailure();
    }
    const raw = await result.text();
    if (raw.length > 262144) throw new DeploymentFailure();
    const root = JSON.parse(raw);
    if (root.success !== true) throw new DeploymentFailure();
    return root.result;
  }
  const worker = `workers/scripts/${config.name}`;
  const queue = `queues/${input.CF_QUEUE_ID}`;
  if (request.operation === "deploy") {
    checkSnapshot(await api(`${worker}/settings`), config);
    const details = await api(queue);
    const metrics = await api(`${queue}/metrics`);
    if (
      details.queue_name !== config.queues.producers[0].queue ||
      metrics.backlog_count !== 0 ||
      metrics.backlog_bytes !== 0
    )
      throw new DeploymentFailure();
  } else {
    const db = await api(`d1/database/${input.D1_DATABASE_ID}`);
    if (db.uuid !== input.D1_DATABASE_ID || db.name !== config.d1_databases[0].database_name)
      throw new DeploymentFailure();
  }
  const path = resolve(directory, `.sandbox-deploy-${randomUUID()}.jsonc`);
  try {
    writeFileSync(path, JSON.stringify(config), { mode: 0o600, flag: "wx" });
    const args =
      request.operation === "migrate"
        ? [
            "exec",
            "wrangler",
            "d1",
            "migrations",
            "apply",
            config.d1_databases[0].database_name,
            "--remote",
            "--config",
            path,
          ]
        : ["exec", "wrangler", "deploy", "--config", path];
    // WranglerはvarsやAPIエラー本文を表示するため、ログへそのまま転送しない。
    const runtimeEnv = { ...env, CI: "true", NO_COLOR: "1", WRANGLER_SEND_METRICS: "false" };
    for (const key of ["GH_TOKEN", "GITHUB_TOKEN", "CLOUDFLARE_API_KEY", "CLOUDFLARE_EMAIL"])
      delete runtimeEnv[key];
    const result = runCommand("pnpm", args, {
      cwd: directory,
      encoding: "utf8",
      timeout: 180000,
      maxBuffer: 1024 * 1024,
      env: runtimeEnv,
    });
    if (result.status !== 0) throw new DeploymentFailure();
    if (request.operation === "migrate") return { status: "migration_applied", sha: request.sha };
    const version = result.stdout.match(
      /Current Version ID:\s*([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})/i,
    )?.[1];
    if (!version) throw new DeploymentFailure();
    checkSnapshot(await api(`${worker}/settings`), config);
    const deployments = await api(`${worker}/deployments`);
    const active = deployments.deployments?.[0]?.versions;
    if (active?.length !== 1 || active[0].version_id !== version || active[0].percentage !== 100)
      throw new DeploymentFailure();
    const metrics = await api(`${queue}/metrics`);
    if (metrics.backlog_count !== 0 || metrics.backlog_bytes !== 0) throw new DeploymentFailure();
    const schedules = await api(`${worker}/schedules`);
    if (
      !config.triggers.crons.every((cron) =>
        schedules.schedules?.some((value) => value.cron === cron),
      )
    )
      throw new DeploymentFailure();
    const checks =
      KIND === "worker"
        ? [
            ["/health", "GET", 200],
            ["/webhooks/x", "GET", 404],
            ["/webhooks/x", "POST", 404],
            ["/webhooks/mock", "POST", 404],
          ]
        : [["/health", "GET", 200]];
    for (const [path, method, status] of checks) {
      const result = await response(origin + path, { method });
      await result.body?.cancel();
      if (result.status !== status) throw new DeploymentFailure();
    }
    return { status: "sandbox_deployed", sha: request.sha, version };
  } finally {
    unlinkSync(path);
  }
}
if (import.meta.main) {
  try {
    console.log(JSON.stringify(await executeDeployment(process.env)));
  } catch {
    console.error("sandbox_operation_failed_manual_verification_required");
    process.exitCode = 1;
  }
}
