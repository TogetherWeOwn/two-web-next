// Production Worker secrets preflight.
//
// Default mode refuses `deploy-production` when a required production Worker
// secret is absent, before any deploy mutation. Runs:
//
//   wrangler secret list --env production --format json
//
// and compares the returned NAMES against the required set. Values are never
// requested, read or printed: success prints the required names, failure names
// only the missing ones. Wrangler's own stdout/stderr are never echoed, and a
// non-JSON, empty or otherwise unreadable listing fails closed. A Worker that
// does not exist yet (never deployed) also fails closed here: the operator
// provisions the Worker and its secrets (TOG-11957) before the first deploy.
//
// Rollback mode (`--rollback-version`, with ROLLBACK_VERSION_ID in the env)
// refuses `rollback-production` when the recorded target Worker Version lacks
// a required secret, before `wrangler rollback` moves traffic. Runs:
//
//   wrangler versions view "$ROLLBACK_VERSION_ID" --name two-web-next-production --json
//
// ROLLBACK_WORKER_NAME selects the Worker for the staging rollback drill
// (two-web-next); empty means production, and any other name refuses.
//
// and compares the target version's `resources.bindings` entries with
// `type === "secret_text"` against the same required set. The rollback
// deploys the target version's own code and bindings, never the checked-out
// commit: `wrangler secret delete` creates and deploys a new version at once,
// so reading the latest listing here would refuse the rollback that restores
// the deleted secret (CI auto-confirms wrangler error 10220 and the target's
// secrets come back). Extra binding fields, if any, are ignored and never
// returned; unreadable output fails closed.
//
// Required names mirror the required secret fields of `Env` in src/env.ts.
// BOT_ENDPOINT_URL, BOT_SHARED_SECRET and BOT_KEY_ID are intentionally NOT
// required: they are optional in Env and every deployed reader fails closed
// when they are missing (src/agent-events/route.ts, src/jobs/worker.ts).
// If any of them is ever made required, add it here in the same change.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_PRODUCTION_SECRETS = [
  "SESSION_SECRET",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
];

// Parse `wrangler secret list --format json` output into the set of secret
// names. The listing is a JSON array whose entries carry a string `name`
// (extra fields, if any, are ignored and never returned). Anything else
// fails closed.
export function parseSecretNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Could not verify production Worker secrets: wrangler did not return valid JSON",
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "Could not verify production Worker secrets: expected a JSON array of secret entries",
    );
  }
  const names = new Set();
  for (const entry of parsed) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      entry.name.length === 0
    ) {
      throw new Error(
        "Could not verify production Worker secrets: every entry must be an object with a string name",
      );
    }
    names.add(entry.name);
  }
  return names;
}

export function missingRequiredSecrets(names) {
  return REQUIRED_PRODUCTION_SECRETS.filter((name) => !names.has(name));
}

export function checkProductionSecrets(stdout) {
  const missing = missingRequiredSecrets(parseSecretNames(stdout));
  if (missing.length > 0) {
    throw new Error(`Missing production Worker secret(s): ${missing.join(", ")}`);
  }
  return [...REQUIRED_PRODUCTION_SECRETS];
}

// Parse `wrangler versions view <id> --name two-web-next-production --json`
// output into the set of secret names bound to that Worker Version. The
// output is a version object whose `resources.bindings` array carries one
// entry per binding; only entries with `type === "secret_text"` contribute
// their string `name` (extra fields, if any, are ignored and never
// returned). Anything else fails closed, without echoing the output.
export function parseVersionSecretNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(
      "Could not verify rollback target version secrets: wrangler did not return valid JSON",
    );
  }
  const bindings = parsed?.resources?.bindings;
  if (!parsed || typeof parsed !== "object" || !Array.isArray(bindings)) {
    throw new Error(
      "Could not verify rollback target version secrets: expected a version object with resources.bindings",
    );
  }
  const names = new Set();
  for (const entry of bindings) {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof entry.name !== "string" ||
      entry.name.length === 0 ||
      typeof entry.type !== "string" ||
      entry.type.length === 0
    ) {
      throw new Error(
        "Could not verify rollback target version secrets: every binding must be an object with a string name and type",
      );
    }
    if (entry.type !== "secret_text") continue;
    names.add(entry.name);
  }
  return names;
}

export function checkRollbackVersionSecrets(stdout) {
  const missing = missingRequiredSecrets(parseVersionSecretNames(stdout));
  if (missing.length > 0) {
    throw new Error(`Rollback target version is missing required secret(s): ${missing.join(", ")}`);
  }
  return [...REQUIRED_PRODUCTION_SECRETS];
}

function assertRollbackVersionIdFormat(versionId) {
  // Same lowercase-UUID shape the deploy gate enforces
  // (ci/production-deploy-gate.mjs assertRollbackVersionId): reject empty
  // values and shell metacharacters before the id reaches wrangler.
  if (
    typeof versionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(versionId)
  ) {
    throw new Error(
      "Could not verify rollback target version secrets: ROLLBACK_VERSION_ID must be a Worker Version ID (lowercase UUID)",
    );
  }
}

function listProductionSecretJson() {
  // --format json prints names only; this command never reads values.
  try {
    return execFileSync(
      "npx",
      ["wrangler", "secret", "list", "--env", "production", "--format", "json"],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        // Capture the child's stdout/stderr instead of inheriting them: the
        // child's streams are untrusted input and must never reach our own
        // stdout/stderr. Only the returned stdout is parsed; anything the
        // child writes to stderr is discarded here.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    // Report only our own message and the exit status. Wrangler's streams are
    // never echoed: we do not control their contents.
    const status = Number.isSafeInteger(error.status) ? ` (exit ${error.status})` : "";
    throw new Error(
      `Could not verify production Worker secrets: wrangler secret list failed${status}`,
    );
  }
}

export const ROLLBACK_WORKERS = ["two-web-next-production", "two-web-next"];

export function rollbackWorkerName(value) {
  const name = (value ?? "").trim() || "two-web-next-production";
  if (!ROLLBACK_WORKERS.includes(name)) {
    throw new Error(
      `Could not verify rollback target version secrets: ROLLBACK_WORKER_NAME must be one of ${ROLLBACK_WORKERS.join(", ")}`,
    );
  }
  return name;
}

function listRollbackVersionJson() {
  // Reads the recorded target version's bindings, never the latest version's
  // listing. The id is gate-validated upstream and re-validated here; it
  // travels as a single exec argument, never through a shell.
  assertRollbackVersionIdFormat(process.env.ROLLBACK_VERSION_ID);
  const worker = rollbackWorkerName(process.env.ROLLBACK_WORKER_NAME);
  try {
    return execFileSync(
      "npx",
      ["wrangler", "versions", "view", process.env.ROLLBACK_VERSION_ID, "--name", worker, "--json"],
      {
        encoding: "utf8",
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
        // Capture the child's stdout/stderr instead of inheriting them: the
        // child's streams are untrusted input and must never reach our own
        // stdout/stderr. Only the returned stdout is parsed; anything the
        // child writes to stderr is discarded here.
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch (error) {
    const status = Number.isSafeInteger(error.status) ? ` (exit ${error.status})` : "";
    throw new Error(
      `Could not verify rollback target version secrets: wrangler versions view failed${status}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--rollback-version") {
      const present = checkRollbackVersionSecrets(listRollbackVersionJson());
      console.log(`Rollback target version secrets present: ${present.join(", ")}`);
    } else {
      const present = checkProductionSecrets(listProductionSecretJson());
      console.log(`Production Worker secrets present: ${present.join(", ")}`);
    }
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
