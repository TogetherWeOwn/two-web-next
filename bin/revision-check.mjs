#!/usr/bin/env node
// Live revision marker for a deployed Worker, read from `GET /up` (the
// `revision` object: Worker Version ID plus the commit the deploy tagged it
// with). Two uses in the staging deploy workflow:
//
//   node bin/revision-check.mjs <origin> [--json]            record what is live now
//   node bin/revision-check.mjs <origin> <sha> [--json]      prove <sha> is live now
//   node bin/revision-check.mjs --help                       print usage, no probe
//
// Record mode never fails: before the first deploy of a revision-aware build
// the live Worker reports no `revision`, and that is a fact to log, not an
// error. Verify mode fails closed. It retries because a new Version takes a
// moment to serve every request, and it reads the JSON body at any HTTP status
// (a 503 for a DB reason still carries the marker). The Version ID printed is
// the value `wrangler rollback` takes.

import { appendFileSync, realpathSync } from "node:fs";
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

const USAGE = `Usage: node bin/revision-check.mjs <origin> [<40-hex-commit>] [--json] [--help]

Record what is live now, or prove <sha> is live now. Record mode never fails;
verify mode fails closed after retries. --json emits a versioned verdict to
stdout (no attempt chatter, no step summary). --help prints this usage to
stdout and probes nothing. Flags may appear in any position and are never
parsed as the origin or commit value.`;

export function parseRevisionArgs(args) {
  if (args.includes("--help")) return { help: true };
  let json = false;
  const positionals = [];
  for (const arg of args) {
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg.startsWith("--")) throw new Error(USAGE);
    positionals.push(arg);
  }
  const [origin, expected, ...extra] = positionals;
  if (!origin || extra.length || (expected !== undefined && !COMMIT.test(expected))) {
    throw new Error(USAGE);
  }
  return { help: false, json, origin, expected };
}

function verifyCode(message) {
  if (message.includes("/up reports no revision")) return "verify.no_marker";
  if (message.includes("not a Worker Version ID")) return "verify.malformed";
  if (message.includes("revision.commit is")) return "verify.mismatch";
  return "verify.unreadable";
}

function verifyNextAction(code) {
  if (code === "verify.no_marker") return "live worker reports no revision; check deploy completed";
  if (code === "verify.malformed") return "live revision marker is malformed; inspect /up";
  if (code === "verify.mismatch")
    return "deployed commit does not match; wait for rollout or check deploy";
  return "live /up is unreadable; check origin reachability";
}

// Test hook for CLI tests: REVISION_CHECK_ATTEMPTS (1-6) and
// REVISION_CHECK_DELAY_MS (0-10000) override verify retries. Unset or invalid
// values fall back to production defaults (6 attempts, 10s delay). Human and
// JSON verify arms share this so offline fixtures stay fast without changing
// deploy behavior.
export function revisionRetryConfig(env = process.env) {
  const attempts = Number.parseInt(env.REVISION_CHECK_ATTEMPTS ?? "", 10);
  const delayMs = Number.parseInt(env.REVISION_CHECK_DELAY_MS ?? "", 10);
  return {
    attempts: Number.isInteger(attempts) && attempts >= 1 && attempts <= 6 ? attempts : 6,
    delayMs: Number.isInteger(delayMs) && delayMs >= 0 && delayMs <= 10_000 ? delayMs : 10_000,
  };
}

if (isMainEntry()) {
  let parsed;
  try {
    parsed = parseRevisionArgs(process.argv.slice(2));
  } catch {
    console.error(USAGE);
    process.exitCode = 2;
  }
  if (parsed && parsed.help) {
    console.log(USAGE);
  } else if (parsed && parsed.json && parsed.expected === undefined) {
    try {
      const revision = await readRevision(parsed.origin);
      if (!revision) {
        console.log(
          JSON.stringify({
            version: 1,
            mode: "record",
            commit: null,
            verified: false,
            code: "record.no_marker",
            next_action:
              "no live revision marker; proceed with first deploy of a revision-aware build",
          }),
        );
      } else if (
        !VERSION_ID.test(revision.version_id ?? "") ||
        !COMMIT.test(revision.commit ?? "")
      ) {
        console.log(
          JSON.stringify({
            version: 1,
            mode: "record",
            commit: COMMIT.test(revision.commit ?? "") ? revision.commit : null,
            verified: false,
            code: "record.malformed",
            next_action: "live revision marker is malformed; inspect /up before deploying",
          }),
        );
      } else {
        console.log(
          JSON.stringify({
            version: 1,
            mode: "record",
            commit: revision.commit,
            verified: true,
            code: "record.verified",
            next_action: "live revision recorded; proceed with deploy",
          }),
        );
      }
    } catch {
      console.log(
        JSON.stringify({
          version: 1,
          mode: "record",
          commit: null,
          verified: false,
          code: "record.unreadable",
          next_action: "live /up is unreadable; check origin reachability before deploying",
        }),
      );
    }
  } else if (parsed && parsed.json) {
    try {
      const retry = revisionRetryConfig();
      const revision = await verifyRevision(parsed.origin, parsed.expected, {
        ...retry,
        log: () => {},
      });
      console.log(
        JSON.stringify({
          version: 1,
          mode: "verify",
          commit: revision.commit,
          expected_commit: parsed.expected,
          verified: true,
          code: "verify.verified",
          next_action: "deployed revision verified; no further action",
        }),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "failed";
      const code = verifyCode(message);
      console.log(
        JSON.stringify({
          version: 1,
          mode: "verify",
          commit: null,
          expected_commit: parsed.expected,
          verified: false,
          code,
          next_action: verifyNextAction(code),
        }),
      );
      process.exitCode = 1;
    }
  } else if (parsed && parsed.expected === undefined) {
    try {
      const revision = await readRevision(parsed.origin);
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
  } else if (parsed) {
    try {
      const revision = await verifyRevision(parsed.origin, parsed.expected, revisionRetryConfig());
      summarize(
        `Deployed revision verified: version \`${revision.version_id}\`, commit \`${revision.commit}\``,
      );
    } catch (error) {
      console.error(`revision-check: ${error instanceof Error ? error.message : "failed"}`);
      process.exitCode = 1;
    }
  }
}
