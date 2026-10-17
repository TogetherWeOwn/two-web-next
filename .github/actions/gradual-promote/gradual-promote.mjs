// Gradual production promotion helpers.
//
// Canonical home: this file ships inside the shared composite action, which
// resolves it from its own path (github.action_path), so every caller repo
// runs the same traffic math with no copy. Self-contained on purpose: it
// takes no dependency on the caller repo, so a caller needs only the action
// reference plus its own smoke checker.
//
// Wrangler's `versions deploy` refuses a lone `TAG@5%` spec: the named
// percentages must total exactly 100 (see validateTrafficSubtotal in the
// installed wrangler bundle). Every gradual step therefore names both
// versions: the new tag at N% and the pre-promote version at (100-N)%.
// The 100% step promotes the tag alone, which replaces the deployment.
//
// The action pipes `wrangler ... --json` output into this CLI:
//   wrangler deployments list --env production --name <worker> --json \
//     | node "$ACTION_PATH/gradual-promote.mjs" --capture-rollback-target
//   wrangler versions list --env production --name <worker> --json \
//     | node "$ACTION_PATH/gradual-promote.mjs" --resolve-tag <tag>
// Both commands fail closed on unparseable or ambiguous input and never
// echo the piped content (it may name infrastructure).
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// Worker Version IDs are lowercase UUIDs: the same shape the rollback
// command itself requires. Validated before an id reaches a shell command
// or the Cloudflare API, so untrusted `wrangler ... --json` output is never
// trusted as a rollback target or a deploy spec.
const ROLLBACK_VERSION_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function assertRollbackVersionId(versionId) {
  if (typeof versionId !== "string" || !ROLLBACK_VERSION_PATTERN.test(versionId)) {
    throw new Error(
      "Rollback version_id must be a Worker Version ID (lowercase UUID); list versions with `wrangler versions list`",
    );
  }
  return versionId;
}

// The card's rollout ladder: canary, half, full.
export const GRADUAL_STEPS = [5, 50, 100];

const TAG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertVersionTag(tag) {
  if (typeof tag !== "string" || !TAG_PATTERN.test(tag)) {
    throw new Error("version tag must be 1-128 chars of letters, digits, dot, underscore or dash");
  }
  return tag;
}

// Specs for one `wrangler versions deploy` invocation. The positional carries
// the pre-promote version so the two percentages sum to exactly 100.
export function splitDeploySpecs({ tag, percentage, previousVersionId }) {
  if (!GRADUAL_STEPS.includes(percentage)) {
    throw new Error("percentage must be one of 5, 50, 100");
  }
  assertVersionTag(tag);
  if (percentage < 100) {
    if (
      typeof previousVersionId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(previousVersionId)
    ) {
      throw new Error("previous version id must be a lowercase Worker Version UUID");
    }
    return {
      positional: [`${previousVersionId}@${100 - percentage}`],
      versionTag: `${tag}@${percentage}%`,
    };
  }
  return { positional: [], versionTag: `${tag}@100%` };
}

function assertDeployments(value) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error("expected a non-empty deployments list");
  }
  return value;
}

// `deployments list --json` prints oldest first; the live deployment is the
// newest by created_on, never by array position.
export function latestDeployment(deployments) {
  const list = assertDeployments(deployments);
  let newest = list[0];
  for (const entry of list.slice(1)) {
    if (String(entry?.created_on ?? "") > String(newest?.created_on ?? "")) newest = entry;
  }
  if (!newest || !Array.isArray(newest.versions)) {
    throw new Error("latest deployment has no versions array");
  }
  return newest;
}

// The auto-rollback target: the live version of a single-version 100%
// deployment. A split deployment refuses: rolling one side back over an
// active gradual rollout would silently discard the other side's traffic.
export function rollbackTarget(deployments) {
  const { versions } = latestDeployment(deployments);
  if (
    versions.length !== 1 ||
    versions[0]?.percentage !== 100 ||
    typeof versions[0]?.version_id !== "string"
  ) {
    throw new Error(
      "refusing: latest production deployment is not a single-version 100% deployment",
    );
  }
  assertRollbackVersionId(versions[0].version_id);
  return versions[0].version_id;
}

// `versions list --json` prints the version array; tags live under
// annotations["workers/tag"]. Exactly one match required, mirroring
// wrangler's own ambiguous-tag refusal.
export function versionIdForTag(versions, tag) {
  assertVersionTag(tag);
  if (!Array.isArray(versions)) throw new Error("expected a versions array");
  const matches = versions.filter((v) => v?.annotations?.["workers/tag"] === tag);
  if (matches.length === 0) {
    throw new Error(`No deployable version found with tag "${tag}"`);
  }
  if (matches.length > 1) {
    throw new Error(`Tag "${tag}" matches multiple versions`);
  }
  assertRollbackVersionId(matches[0].id);
  return matches[0].id;
}

// --- Live error-rate signal (Cloudflare GraphQL Analytics) ---
//
// `workersInvocationsAdaptive` aggregates invocation counts per
// scriptVersion: `sum.errors` counts invocations that ended in an
// unhandled exception, exceeded resources or an internal error (see
// "Invocation statuses" in the Workers metrics docs). Filtering by the
// promoted version id judges the NEW version's live traffic at a canary
// stage, not a script-wide average the old version would dilute. All
// identifiers travel as GraphQL variables; the query text is static, so
// nothing untrusted is interpolated. These helpers stay pure (no network,
// no credentials): error-rate-gate.mjs performs the fetch.

// Cloudflare account ids are 32 lowercase hex chars.
const ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/;
// Worker script names: lowercase letters, digits and dashes.
const SCRIPT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Static gate identifiers, validated before any soak or fetch so a
// misconfiguration fails in seconds instead of after the retry delays.
export function assertErrorRateIdentifiers({ accountId, scriptName, versionId }) {
  if (typeof accountId !== "string" || !ACCOUNT_ID_PATTERN.test(accountId)) {
    throw new Error("account id must be a 32-character lowercase hex Cloudflare account id");
  }
  if (typeof scriptName !== "string" || !SCRIPT_NAME_PATTERN.test(scriptName)) {
    throw new Error("script name must be lowercase letters, digits or dashes");
  }
  assertRollbackVersionId(versionId);
}

export function buildErrorRateQuery({ accountId, scriptName, versionId, sinceIso, untilIso }) {
  assertErrorRateIdentifiers({ accountId, scriptName, versionId });
  const since = Date.parse(sinceIso ?? "");
  const until = Date.parse(untilIso ?? "");
  if (!Number.isFinite(since) || !Number.isFinite(until) || since >= until) {
    throw new Error("error-rate window must be ISO timestamps with since before until");
  }
  return {
    query: [
      "query ErrorRate($accountTag: String!, $scriptName: String!, $versionId: String!, $since: Time!, $until: Time!) {",
      "  viewer {",
      "    accounts(filter: { accountTag: $accountTag }) {",
      "      workersInvocationsAdaptive(",
      "        limit: 1",
      "        filter: { scriptName: $scriptName, scriptVersion: $versionId, datetime_geq: $since, datetime_leq: $until }",
      "      ) {",
      "        sum { requests errors }",
      "        dimensions { scriptVersion }",
      "      }",
      "    }",
      "  }",
      "}",
    ].join("\n"),
    variables: { accountTag: accountId, scriptName, versionId, since: sinceIso, until: untilIso },
  };
}

// Parses one GraphQL envelope into { requests, errors }. Fails closed on
// GraphQL errors, a malformed shape, or a row for a different version than
// the one being promoted. Error messages never echo the payload: a
// GraphQL error may carry request detail.
export function parseErrorRateResponse(payload, versionId) {
  assertRollbackVersionId(versionId);
  if (!payload || typeof payload !== "object") {
    throw new Error("error-rate response is not an object");
  }
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error("error-rate GraphQL query returned errors");
  }
  const accounts = payload.data?.viewer?.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1) {
    throw new Error("error-rate response does not contain exactly one account");
  }
  const rows = accounts[0]?.workersInvocationsAdaptive;
  if (!Array.isArray(rows) || rows.length > 1) {
    throw new Error("error-rate response rows are malformed");
  }
  if (rows.length === 0) return { requests: 0, errors: 0 };
  const row = rows[0];
  if (row?.dimensions?.scriptVersion !== versionId) {
    throw new Error("error-rate response is for a different Worker version");
  }
  const { requests, errors } = row?.sum ?? {};
  if (
    !Number.isSafeInteger(requests) ||
    !Number.isSafeInteger(errors) ||
    requests < 0 ||
    errors < 0 ||
    errors > requests
  ) {
    throw new Error("error-rate response sums are malformed");
  }
  return { requests, errors };
}

// A stage is judged only once the new version served `minRequests` live
// invocations in the window; below that the verdict is "insufficient"
// (the gate retries while analytics aggregates catch up). At or above the
// threshold boundary the version passes; strictly above it, it fails.
export function evaluateErrorRate({ requests, errors, threshold, minRequests }) {
  if (typeof threshold !== "number" || !(threshold >= 0 && threshold <= 1)) {
    throw new Error("threshold must be a number between 0 and 1");
  }
  if (!Number.isSafeInteger(minRequests) || minRequests < 1) {
    throw new Error("minRequests must be a positive integer");
  }
  if (
    !Number.isSafeInteger(requests) ||
    !Number.isSafeInteger(errors) ||
    requests < 0 ||
    errors < 0
  ) {
    throw new Error("requests and errors must be non-negative integers");
  }
  const rate = requests === 0 ? 0 : errors / requests;
  if (requests < minRequests) return { verdict: "insufficient", rate };
  return { verdict: rate > threshold ? "fail" : "pass", rate };
}

function readStdin() {
  return readFileSync(0, "utf8");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [flag, arg, extra, prev] = process.argv.slice(2);
  try {
    if (flag === "--capture-rollback-target" && arg === undefined) {
      process.stdout.write(`${rollbackTarget(JSON.parse(readStdin()))}\n`);
    } else if (flag === "--resolve-tag" && typeof arg === "string") {
      process.stdout.write(`${versionIdForTag(JSON.parse(readStdin()), arg)}\n`);
    } else if (flag === "--deploy-spec") {
      // Prints the positional spec line (empty at 100%) then the version-tag
      // spec line, so the workflow builds wrangler args without interpolation.
      const { positional, versionTag } = splitDeploySpecs({
        tag: arg,
        percentage: Number(extra),
        previousVersionId: prev,
      });
      process.stdout.write(`${positional[0] ?? ""}\n${versionTag}\n`);
    } else {
      throw new Error(
        "Usage: gradual-promote.mjs (--capture-rollback-target | --resolve-tag <tag> | --deploy-spec <tag> <5|50|100> <prev-version-id>)",
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
