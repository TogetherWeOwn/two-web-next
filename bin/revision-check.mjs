#!/usr/bin/env node
// Live revision marker for a deployed Worker, read from `GET /up` (the
// `revision` object: Worker Version ID plus the commit the deploy tagged it
// with). Two uses in the staging deploy workflow:
//
//   node bin/revision-check.mjs <origin>             record what is live now
//   node bin/revision-check.mjs <origin> <sha>       prove <sha> is live now
//
// Record mode never fails: before the first deploy of a revision-aware build
// the live Worker reports no `revision`, and that is a fact to log, not an
// error. Verify mode fails closed. It retries because a new Version takes a
// moment to serve every request, and it reads the JSON body at any HTTP status
// (a 503 for a DB reason still carries the marker). The Version ID printed is
// the value `wrangler rollback` takes.

import { appendFileSync, realpathSync } from "node:fs";
import { isIP } from "node:net";
import { fileURLToPath } from "node:url";

const VERSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export async function readRevision(origin, { fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  // Manual redirects: never follow an unexpected host. The bounded signal also
  // covers the body read.
  const response = await fetchImpl(new URL("/up", origin), {
    redirect: "manual",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const data = await response.json();
  const revision = data?.revision;
  if (!revision || typeof revision !== "object") return null;
  return { version_id: revision.version_id ?? null, commit: revision.commit ?? null };
}

export async function verifyRevision(
  origin,
  expectedCommit,
  {
    attempts = 6,
    delayMs = 10_000,
    fetchImpl = fetch,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    log = console.log,
  } = {},
) {
  let last = "no attempt";
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const revision = await readRevision(origin, { fetchImpl });
      if (!revision) last = "/up reports no revision";
      else if (!VERSION_ID.test(revision.version_id ?? ""))
        last = "/up revision.version_id is not a Worker Version ID";
      else if (revision.commit !== expectedCommit)
        last = `/up revision.commit is ${revision.commit ?? "null"}, expected ${expectedCommit}`;
      else return revision;
    } catch (error) {
      last = `request failed (${error instanceof Error ? error.name : "error"})`;
    }
    log(`revision attempt ${attempt}/${attempts}: ${last}`);
    if (attempt < attempts) await sleep(delayMs);
  }
  throw new Error(last);
}

function summarize(line) {
  console.log(line);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
}

const STAGING_ORIGIN = "https://next.togetherweown.com";
const USAGE = "Usage: node bin/revision-check.mjs [--json] <origin> [<40-hex-commit>]";

const HELP = `Usage: node bin/revision-check.mjs [--json] <origin> [<40-hex-commit>]

Live revision marker for a deployed Worker, read from GET /up (the
revision object: Worker Version ID plus the deployed commit).

Arguments:
  <origin>             staging or loopback origin to read (required)
  [<40-hex-commit>]    verify mode: prove this commit is live now
  --json               print one JSON verdict on stdout instead of the summary

The origin must be the staging worker or a loopback fixture origin;
anything else refuses with static usage before any request. Output is a
human summary plus the step summary, or one JSON verdict with --json:
version, tool, mode, ok, code, next, checks and revision.

Exit codes:
  exit 0  marker recorded, commit verified, or --help printed
  exit 1  verification failed or the marker mismatches; claims nothing
  exit 2  wrong arguments or a refused origin; static usage on stderr

See docs/probe-cli-contract.md for the shared probe CLI contract.`;

// CLI-only allowlist: staging plus loopback fixture origins. Production,
// evil and malformed origins refuse with usage before any fetch. The
// library functions stay unguarded for unit fixtures.
function isAllowedOrigin(origin) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin === STAGING_ORIGIN) return true;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  const host = url.hostname;
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

function jsonVerdict({ ok, code, next, checks, revision }) {
  return { version: 1, tool: "revision-check", mode: "report", ok, code, next, checks, revision };
}

// Entry guard compares canonical real paths so a symlinked invocation runs
// the CLI instead of exiting 0 silently (string comparison of argv[1] against
// import.meta.url misses symlinks because the module URL is already resolved).
// Library imports keep argv[1] pointed elsewhere, so the guard stays silent
// for them as before.
function isMainEntry() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMainEntry()) {
  const raw = process.argv.slice(2);
  if (raw.includes("--help")) {
    // Discovery only: usage to stdout, exit 0, zero side effects — no fetch,
    // no summary write. Checked before argv parsing so --help is never read
    // as an origin.
    console.log(HELP);
  } else {
    const jsonMode = raw.includes("--json");
    const [origin, expected, ...extra] = raw.filter((arg) => arg !== "--json");
    if (!origin || extra.length || (expected !== undefined && !COMMIT.test(expected))) {
      console.error(USAGE);
      process.exitCode = 2;
    } else if (!isAllowedOrigin(origin)) {
      // Static usage, no origin echo, no fetch: non-staging targets refuse
      // before any effect.
      console.error(USAGE);
      process.exitCode = 2;
    } else if (expected === undefined) {
      await recordMode(origin, jsonMode);
    } else {
      await verifyMode(origin, expected, jsonMode);
    }
  }
}

async function recordMode(origin, jsonMode) {
  if (jsonMode) {
    // Record never fails the exit code: an absent marker or an unreadable /up
    // is a fact to report, not a deploy error. An unreadable /up still reports
    // ok:false with a distinct code and a failing read check, so a JSON
    // consumer can tell a down Worker from an old Worker without a marker.
    // No human summary, no step-summary write.
    try {
      const revision = await readRevision(origin);
      console.log(
        JSON.stringify(
          jsonVerdict({
            ok: true,
            code: "REVISION_CHECK_OK",
            next: "No action: live revision recorded; rerun after the next staging deploy.",
            checks: [{ id: "up-revision-read", label: "live revision read from /up", ok: true }],
            revision,
          }),
          null,
          2,
        ),
      );
    } catch {
      console.log(
        JSON.stringify(
          jsonVerdict({
            ok: false,
            code: "REVISION_CHECK_UNREADABLE",
            next: "Check the staging deploy workflow: /up is unreadable; the live revision was not recorded.",
            checks: [{ id: "up-revision-read", label: "live revision read from /up", ok: false }],
            revision: null,
          }),
          null,
          2,
        ),
      );
    }
    return;
  }
  try {
    const revision = await readRevision(origin);
    summarize(
      revision
        ? `Live before deploy (rollback target): version \`${revision.version_id}\`, commit \`${revision.commit ?? "untagged"}\``
        : "Live before deploy: /up reports no revision marker",
    );
  } catch (error) {
    summarize(
      `Live before deploy: /up unreadable (${error instanceof Error ? error.name : "error"})`,
    );
  }
}

async function verifyMode(origin, expected, jsonMode) {
  if (jsonMode) {
    // Attempt logs stay silent: stdout carries exactly one JSON verdict,
    // stderr stays empty, and no step summary is written.
    try {
      const revision = await verifyRevision(origin, expected, { log: () => {} });
      console.log(
        JSON.stringify(
          jsonVerdict({
            ok: true,
            code: "REVISION_CHECK_OK",
            next: "No action: deployed revision verified live; rerun after the next staging deploy.",
            checks: [
              { id: "revision-commit-verified", label: "deployed commit verified live", ok: true },
            ],
            revision,
          }),
          null,
          2,
        ),
      );
    } catch {
      console.log(
        JSON.stringify(
          jsonVerdict({
            ok: false,
            code: "REVISION_CHECK_MISMATCH",
            next: "Check the staging deploy workflow: the expected commit is not live on this origin.",
            checks: [
              {
                id: "revision-commit-verified",
                label: "deployed commit verified live",
                ok: false,
              },
            ],
            revision: null,
          }),
          null,
          2,
        ),
      );
      process.exitCode = 1;
    }
    return;
  }
  try {
    const revision = await verifyRevision(origin, expected);
    summarize(
      `Deployed revision verified: version \`${revision.version_id}\`, commit \`${revision.commit}\``,
    );
  } catch (error) {
    console.error(`revision-check: ${error instanceof Error ? error.message : "failed"}`);
    process.exitCode = 1;
  }
}
