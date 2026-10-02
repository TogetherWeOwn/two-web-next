import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
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

export function assertProductionProtection(environment) {
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

export async function checkProductionGate(env, fetchEnvironment = fetch) {
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
  assertProductionProtection(await response.json());
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
      await checkProductionGate(process.env);
      assertProductionTarget(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
      console.log("Production dispatch, enable flag, review protection and target checks passed");
    }
  } catch (error) {
    // Do not print request/response bodies or credentials on a failed API call.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
