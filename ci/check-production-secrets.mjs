// Production Worker secrets preflight.
//
// Refuses `deploy-production` when a required production Worker secret is
// absent, before any deploy mutation. Runs:
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
// Required names mirror the required secret fields of `Env` in src/env.ts.
// BOT_ENDPOINT_URL, BOT_SHARED_SECRET and BOT_KEY_ID are intentionally NOT
// required: the deployed jobs path receives an injected BotClient
// (src/jobs/worker.ts) and nothing in the deployed Worker reads those names.
// They live only in operator/probe tooling (bin/, src/probes/) via
// process.env. If the Worker ever reads them from Env, add them here in the
// same change.

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const present = checkProductionSecrets(listProductionSecretJson());
    console.log(`Production Worker secrets present: ${present.join(", ")}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
