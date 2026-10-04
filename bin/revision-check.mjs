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

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [origin, expected, ...extra] = process.argv.slice(2);
  if (!origin || extra.length || (expected !== undefined && !COMMIT.test(expected))) {
    console.error("Usage: node bin/revision-check.mjs <origin> [<40-hex-commit>]");
    process.exitCode = 2;
  } else if (expected === undefined) {
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
  } else {
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
}
