import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkDeploymentGate,
  DeploymentFailure,
  deploymentRequest,
} from "../../scripts/deployment-gate.mjs";

const sha = "a".repeat(40);
function environment(extra = {}) {
  return {
    GITHUB_ACTIONS: "true",
    GITHUB_RUN_ATTEMPT: "1",
    GITHUB_RUN_ID: "123",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    SANDBOX_DEPLOY_ENABLED: "true",
    GITHUB_SHA: sha,
    DEPLOY_SHA: sha,
    GITHUB_REPOSITORY: "synthetic/repo",
    DEPLOY_REVIEWER: "owner",
    DEPLOY_OPERATION: "deploy",
    DEPLOY_CONFIRMATION: `deploy:${sha}`,
    MAINTENANCE_CONFIRMED: "true",
    SCHEMA_CONFIRMED: "true",
    GH_TOKEN: "synthetic-private",
    ...extra,
  };
}
function remote(change = () => {}) {
  const responses = [
    {
      name: "sandbox",
      protection_rules: [
        { type: "required_reviewers", reviewers: [{ type: "User", reviewer: { login: "owner" } }] },
      ],
      deployment_branch_policy: { custom_branch_policies: true, protected_branches: false },
    },
    { total_count: 1, branch_policies: [{ name: "main", type: "branch" }] },
    {
      workflow_runs: [
        {
          head_sha: sha,
          event: "push",
          head_branch: "main",
          status: "completed",
          conclusion: "success",
        },
      ],
    },
  ];
  change(responses);
  let calls = 0;
  return {
    count: () => calls,
    fetchImpl: async (url, init) => {
      assert.equal(new URL(url).origin, "https://api.github.com");
      assert.equal(init.redirect, "error");
      assert.equal(init.headers.Authorization, "Bearer synthetic-private");
      return Response.json(responses[calls++] ?? []);
    },
  };
}
test("mainの同じSHAのCI成功・本人reviewer・main限定Environmentを確認する", async () => {
  const r = remote();
  const result = await checkDeploymentGate(environment(), r);
  assert.equal(result.environment, "sandbox");
  assert.equal(r.count(), 3);
  assert.equal(JSON.stringify(result).includes("private"), false);
});
for (const [key, value] of Object.entries({
  GITHUB_ACTIONS: "false",
  GITHUB_EVENT_NAME: "push",
  GITHUB_REF: "refs/heads/feature",
  SANDBOX_DEPLOY_ENABLED: "false",
  DEPLOY_SHA: "b".repeat(40),
  GITHUB_REPOSITORY: "bad/../path",
  DEPLOY_REVIEWER: "owner?",
  DEPLOY_CONFIRMATION: "deploy:main",
  MAINTENANCE_CONFIRMED: "false",
  SCHEMA_CONFIRMED: "false",
  DEPLOY_OPERATION: "migrate",
}))
  test(`${key}の条件違いでは通信前に拒否する`, async () => {
    const r = remote();
    await assert.rejects(checkDeploymentGate(environment({ [key]: value }), r), DeploymentFailure);
    assert.equal(r.count(), 0);
  });
for (const [name, change] of [
  [
    "reviewerなし",
    (r) => {
      r[0].protection_rules = [];
    },
  ],
  [
    "別reviewer",
    (r) => {
      r[0].protection_rules[0].reviewers[0].reviewer.login = "other";
    },
  ],
  [
    "全branch許可",
    (r) => {
      r[0].deployment_branch_policy = null;
    },
  ],
  [
    "ワイルドカード",
    (r) => {
      r[1].branch_policies[0].name = "*";
    },
  ],
  [
    "追加branch",
    (r) => {
      r[1].total_count = 2;
    },
  ],
  [
    "mainと同名tag",
    (r) => {
      r[1].branch_policies[0].type = "tag";
    },
  ],
  [
    "別SHA",
    (r) => {
      r[2].workflow_runs[0].head_sha = "b".repeat(40);
    },
  ],
  [
    "CI失敗",
    (r) => {
      r[2].workflow_runs[0].conclusion = "failure";
    },
  ],
  [
    "PRのCI",
    (r) => {
      r[2].workflow_runs[0].event = "pull_request";
    },
  ],
])
  test(`${name}では配置を許可しない`, async () => {
    await assert.rejects(checkDeploymentGate(environment(), remote(change)), DeploymentFailure);
  });
test("GitHub API失敗で保護ありと扱わない", async () => {
  await assert.rejects(
    checkDeploymentGate(environment(), {
      fetchImpl: async () => new Response(null, { status: 403 }),
    }),
    DeploymentFailure,
  );
});
test("migrationは別Environmentとbackup確認を要求する", () => {
  const env = environment({ DEPLOY_OPERATION: "migrate", DEPLOY_CONFIRMATION: `migrate:${sha}` });
  assert.throws(() => deploymentRequest(env, true), DeploymentFailure);
  assert.equal(
    deploymentRequest({ ...env, BACKUP_CONFIRMED: "true" }, true).environment,
    "sandbox-migrations",
  );
});

for (const type of ["User", "Team"])
  test(`追加${type}の承認だけで通過できるEnvironmentを拒否する`, async () => {
    await assert.rejects(
      checkDeploymentGate(
        environment(),
        remote((values) => {
          values[0].protection_rules[0].reviewers.push({ type, reviewer: { login: "other" } });
        }),
      ),
      DeploymentFailure,
    );
  });

test("実操作では当該runの本人承認履歴も要求する", async () => {
  const r = remote();
  await assert.rejects(
    checkDeploymentGate(environment(), { ...r, requireApproval: true }),
    DeploymentFailure,
  );
});
test("承認履歴のないbypassや再runを許可しない", async () => {
  const env = environment({ GITHUB_RUN_ATTEMPT: "2" });
  await assert.rejects(checkDeploymentGate(env, remote()), DeploymentFailure);
});

test("本人が当該Environmentを承認した履歴を受ける", async () => {
  const r = remote((values) =>
    values.push([
      { state: "approved", user: { login: "owner" }, environments: [{ name: "sandbox" }] },
    ]),
  );
  await checkDeploymentGate(environment(), { ...r, requireApproval: true });
  assert.equal(r.count(), 4);
});
for (const entry of [
  { state: "approved", user: { login: "other" }, environments: [{ name: "sandbox" }] },
  { state: "approved", user: { login: "owner" }, environments: [{ name: "other" }] },
  { state: "rejected", user: { login: "owner" }, environments: [{ name: "sandbox" }] },
])
  test(`別本人・別Environment・拒否の承認履歴を使わない ${JSON.stringify(entry)}`, async () => {
    const r = remote((values) => values.push([entry]));
    await assert.rejects(
      checkDeploymentGate(environment(), { ...r, requireApproval: true }),
      DeploymentFailure,
    );
  });
