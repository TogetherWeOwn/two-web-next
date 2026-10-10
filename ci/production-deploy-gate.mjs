import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { requireSuccessfulCi } from "./staging-deploy-gate.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

export function assertProductionRequest(env) {
  if (env.PRODUCTION_DEPLOY_ENABLED !== "true") {
    throw new Error(
      "Production deployment disabled: repo variable PRODUCTION_DEPLOY_ENABLED must be exactly true",
    );
  }
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" || env.GITHUB_REF !== "refs/heads/main") {
    throw new Error("Production deployment requires workflow_dispatch on main");
  }
}

export function assertProductionCredentials(env) {
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    throw new Error(
      "Production-only Cloudflare credentials must be configured in the production Environment",
    );
  }
}

// Repo variable PRODUCTION_AUTO_APPROVE=true replaces the human Environment
// reviewer with automated evidence: the same exact SHA must also be deployed to
// staging and pass e2e-staging. Any other value keeps the reviewer requirement.
export function autoApproveEnabled(env) {
  return env.PRODUCTION_AUTO_APPROVE === "true";
}

export function assertProductionProtection(environment, { autoApprove = false } = {}) {
  if (autoApprove) {
    const policy = environment.deployment_branch_policy;
    if (
      environment.name !== "production" ||
      policy?.custom_branch_policies !== true ||
      policy?.protected_branches !== false ||
      !environment.protection_rules?.some((rule) => rule.type === "branch_policy")
    ) {
      throw new Error("production Environment must keep its main-only deployment branch policy");
    }
    return;
  }
  // Owner exception: admin bypass remains enabled. Reviewer and self-review
  // checks still apply; this gate does not claim to prevent an admin bypass.
  const review = environment.protection_rules?.find((rule) => rule.type === "required_reviewers");
  if (
    environment.name !== "production" ||
    !review?.reviewers?.length ||
    review.prevent_self_review !== true
  ) {
    throw new Error("production Environment must have required reviewers and prevent self-review");
  }
}

export const stagingEvidenceWorkflows = ["deploy.yml", "e2e-staging.yml"];

// Per-workflow required trigger event for valid staging evidence.
// Manual workflow_dispatch of e2e-staging must not count as verification
// for a SHA that may not have been deployed to staging.
const stagingEvidenceEvent = {
  "deploy.yml": null, // push or workflow_dispatch both acceptable
  "e2e-staging.yml": "workflow_run",
};

// Automated approval evidence: for each staging workflow, the most recent run on
// the deployment SHA must be a completed success. An older success does not
// count if a later run on the same SHA failed or is still running.
export async function requireStagingEvidence(
  { repository, sha },
  { token, fetchImpl = fetch, workflows = stagingEvidenceWorkflows } = {},
) {
  const evidence = [];
  for (const file of workflows) {
    const params = { branch: "main", head_sha: sha, per_page: "100" };
    const requiredEvent = stagingEvidenceEvent[file];
    if (requiredEvent) {
      params.event = requiredEvent;
    }
    const query = new URLSearchParams(params);
    const response = await fetchImpl(
      `https://api.github.com/repos/${repository}/actions/workflows/${file}/runs?${query}`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Staging evidence request failed (HTTP ${response.status})`);
    }
    const result = await response.json();
    const runs = result.workflow_runs ?? [];
    if (!runs.length || result.total_count !== runs.length) {
      throw new Error(`Missing or incomplete exact-SHA ${file} evidence`);
    }
    if (
      !runs.every(
        (run) =>
          Number.isSafeInteger(run.id) &&
          run.head_sha === sha &&
          run.head_branch === "main" &&
          run.path === `.github/workflows/${file}` &&
          run.head_repository?.full_name === repository,
      )
    ) {
      throw new Error(`${file} evidence revision/branch/workflow mismatch`);
    }
    const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(`Latest ${file} run on the deployment SHA is not successful`);
    }
    evidence.push({ workflow: file, runId: latest.id });
  }
  return evidence;
}

export function assertRollbackVersionId(versionId) {
  // Worker Version IDs are lowercase UUIDs: the same format wrangler rollback
  // itself requires. Reject empty values, wrong shapes and shell metacharacters
  // before the id ever reaches a shell command or the Cloudflare API.
  if (
    typeof versionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(versionId)
  ) {
    throw new Error(
      "Rollback version_id must be a Worker Version ID (lowercase UUID); list versions with `wrangler versions list`",
    );
  }
}

export function assertProductionTarget(configText) {
  const bindings = readWranglerConfig(configText).env?.production?.hyperdrive;
  const database = Array.isArray(bindings)
    ? bindings.filter((entry) => entry?.binding === "DB")
    : [];
  if (
    database.length !== 1 ||
    typeof database[0].id !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(database[0].id)
  ) {
    throw new Error("Production Hyperdrive DB binding must have one valid id");
  }
  if (database[0].id === "00000000000000000000000000000000") {
    throw new Error(
      "Production Hyperdrive is still a placeholder; provision and review the cutover configuration first",
    );
  }
}

// The checkout must be the dispatch SHA itself: deploy-production.yml checks
// out `github.sha` (via DEPLOY_SHA) in both gate jobs, so a newer main head never deploys.
function currentCheckoutSha() {
  // The job container may not own the host checkout; trust only this path,
  // only for this command (https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory).
  return execFileSync("git", ["-c", `safe.directory=${resolve(".")}`, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

export async function checkProductionGate(env, fetchEnvironment = fetch, options = {}) {
  // checkoutSha stays lazy so disabled/unprotected requests refuse before any
  // subprocess or CI lookup. Tests pass it explicitly; the CLI resolves it.
  let { checkoutSha, fetchCi = fetchEnvironment } = options;
  // Refuse before any API request, and before the protected deploy job can start.
  assertProductionRequest(env);
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("GitHub Environment protection cannot be verified");
  }
  const response = await fetchEnvironment(
    `https://api.github.com/repos/${env.GITHUB_REPOSITORY}/environments/production`,
    {
      headers: {
        Authorization: `Bearer ${env.GITHUB_TOKEN}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!response.ok) {
    throw new Error(`Cannot verify production Environment protection (HTTP ${response.status})`);
  }
  const autoApprove = autoApproveEnabled(env);
  assertProductionProtection(await response.json(), { autoApprove });
  // Exact-SHA green main CI, shared with the staging gate: a red or pending
  // ci.yml run on this SHA must never reach production.
  checkoutSha ??= currentCheckoutSha();
  // Use DEPLOY_SHA (non-reserved name) so the runner does not discard it.
  // Falls back to GITHUB_SHA only for legacy callers; new callers must pass DEPLOY_SHA.
  const deploySha = env.DEPLOY_SHA || env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(deploySha ?? "")) {
    throw new Error("DEPLOY_SHA must be a 40-hex commit SHA");
  }
  const ci = await requireSuccessfulCi(
    {
      eventName: env.GITHUB_EVENT_NAME,
      event: { repository: { full_name: env.GITHUB_REPOSITORY } },
      repository: env.GITHUB_REPOSITORY,
      ref: env.GITHUB_REF,
      sha: deploySha,
      checkoutSha,
    },
    { token: env.GITHUB_TOKEN, fetchImpl: fetchCi },
  );
  if (!autoApprove) return ci;
  const staging = await requireStagingEvidence(
    { repository: env.GITHUB_REPOSITORY, sha: ci.sha },
    { token: env.GITHUB_TOKEN, fetchImpl: fetchCi },
  );
  return { ...ci, autoApprove: true, staging };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--credentials") {
      assertProductionCredentials(process.env);
      console.log("Production-only Cloudflare credentials are present");
    } else if (process.argv[2] === "--version-id") {
      assertRollbackVersionId(process.env.ROLLBACK_VERSION_ID);
      console.log("Rollback version_id is a valid Worker Version ID");
    } else {
      const evidence = await checkProductionGate(process.env);
      assertProductionTarget(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
      const approval = evidence.autoApprove
        ? `automated approval (staging ${evidence.staging.map((e) => `${e.workflow} run ${e.runId}`).join(", ")})`
        : "review protection";
      console.log(
        `Production dispatch, enable flag, ${approval}, target and exact-SHA CI checks passed: ${evidence.sha}, full CI run ${evidence.runId}, attempt ${evidence.runAttempt}`,
      );
    }
  } catch (error) {
    // Do not print request/response bodies or credentials on a failed API call.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
