// Staging jobs Worker secrets preflight.
//
// Refuses the staging jobs deploy when a required two-web-jobs secret is
// absent, before the jobs Worker attaches to the staging queues. Runs:
//
//   wrangler secret list --config wrangler.jobs.jsonc --format json
//
// and compares the returned NAMES against the required set. Values are never
// requested, read or printed: success prints the required names, failure names
// only the missing ones. Wrangler's own stdout/stderr are never echoed, and a
// non-JSON, empty or otherwise unreadable listing fails closed. A jobs Worker
// that does not exist yet (never deployed) also fails closed here: the
// operator provisions the Worker and its secrets (docs/jobs-handoff.md)
// before the first jobs deploy.
//
// Required names mirror the bot transport fields the jobs consumer reads per
// call in src/jobs/worker.ts (botClientFor). Without them every bot job fails
// terminally and the consumer acks the message (src/jobs/consumer.ts), so
// live and backlogged deliveries leave the queue and need a manual replay.
// QA_AUTH_TOKEN is intentionally NOT required: a missing probe token only
// disables the staging alert-probe path through qaEnabled(), it never drops
// deliveries.

import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_JOBS_SECRETS = ["BOT_ENDPOINT_URL", "BOT_KEY_ID", "BOT_SHARED_SECRET"];

// Parse `wrangler secret list --format json` output into the set of secret
// names. The listing is a JSON array whose entries carry a string `name`
// (extra fields, if any, are ignored and never returned). Anything else
// fails closed.
export function parseSecretNames(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error("Could not verify jobs Worker secrets: wrangler did not return valid JSON");
  }
  if (!Array.isArray(parsed)) {
    throw new Error(
      "Could not verify jobs Worker secrets: expected a JSON array of secret entries",
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
        "Could not verify jobs Worker secrets: every entry must be an object with a string name",
      );
    }
    names.add(entry.name);
  }
  return names;
}

export function missingRequiredSecrets(names) {
  return REQUIRED_JOBS_SECRETS.filter((name) => !names.has(name));
}

export function checkJobsSecrets(stdout) {
  const missing = missingRequiredSecrets(parseSecretNames(stdout));
  if (missing.length > 0) {
    throw new Error(`Missing jobs Worker secret(s): ${missing.join(", ")}`);
  }
  return [...REQUIRED_JOBS_SECRETS];
}

function listJobsSecretJson() {
  // --format json prints names only; this command never reads values.
  // --config selects the jobs Worker; the top-level name is two-web-jobs.
  try {
    return execFileSync(
      "npx",
      ["wrangler", "secret", "list", "--config", "wrangler.jobs.jsonc", "--format", "json"],
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
    throw new Error(`Could not verify jobs Worker secrets: wrangler secret list failed${status}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const present = checkJobsSecrets(listJobsSecretJson());
    console.log(`Jobs Worker secrets present: ${present.join(", ")}`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
