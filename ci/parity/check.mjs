#!/usr/bin/env node
// `npm run check:route-parity`: record pure Hono twice and require zero
// differences, then hold the committed goldens to the same bar while the
// runtime inputs they were recorded from are unchanged.
//
//   PARITY_DATABASE_URL=postgres://...@127.0.0.1/... npm run check:route-parity
//
// PARITY_ARTIFACT_DIR (optional) receives the first run, for upload.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { cp, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EXCEPTIONS_DOC,
  compareRecordings,
  loadRecording,
  parseExceptions,
  report,
} from "./compare.mjs";
import { record, repo } from "./record.mjs";
import { signedCookieVectorsCurrent, VECTORS_PATH } from "./signed-cookies.mjs";

const GOLDENS = "test/fixtures/parity";
let failed = false;
const fail = (message) => {
  console.error(`::error::${message}`);
  failed = true;
};

// Exceptions must parse even when none apply: a malformed table is a failure.
parseExceptions(readFileSync(join(repo, EXCEPTIONS_DOC), "utf8"));

if (!(await signedCookieVectorsCurrent())) {
  fail(`${VECTORS_PATH} is stale: run node ci/parity/signed-cookies.mjs --write`);
}

const out = await mkdtemp(join(process.env.RUNNER_TEMP ?? tmpdir(), "route-parity-check-"));
const { dirs, meta } = await record({ out, runs: 2, databaseUrl: process.env.PARITY_DATABASE_URL });
const [first, second] = dirs.map(loadRecording);

// Hono vs Hono: no exceptions apply to a determinism check.
const determinism = compareRecordings(first, second);
console.log(report(determinism, "run 1 vs run 2"));
if (determinism.failures.length) fail("Two recordings of the same Hono build differ");

for (const row of meta.coverage ?? []) {
  if (!first.get(row.file)?.[row.vector])
    fail(`No golden for ${row.entry} (${row.file}#${row.vector})`);
}

// A fixture session that silently reads as guest would turn every identity
// vector into a guest golden: the signed-in pages must answer differently
// from a forged cookie.
for (const [file, identity] of [
  ["routes/profile", "member"],
  ["routes/admin", "moderator"],
]) {
  const vectors = first.get(file) ?? {};
  const signedIn = vectors[`GET identity:${identity}`]?.response;
  const forged = vectors["GET identity:forged"]?.response;
  if (
    !signedIn ||
    !forged ||
    (signedIn.status === forged.status && signedIn.headers.location === forged.headers.location)
  )
    fail(`${file} answers the ${identity} fixture session like a forged cookie`);
}

const golden = join(repo, GOLDENS, `hono-${meta.pinnedSha}`);
if (existsSync(golden)) {
  const index = JSON.parse(readFileSync(join(golden, "index.json"), "utf8"));
  if (JSON.stringify(index.inputs) === JSON.stringify(meta.inputs)) {
    const drift = compareRecordings(loadRecording(golden), first);
    console.log(report(drift, `committed hono-${meta.pinnedSha} vs run 1`));
    if (drift.failures.length)
      fail(`Committed goldens hono-${meta.pinnedSha} no longer match a fresh recording`);
  } else {
    fail(`hono-${meta.pinnedSha} was recorded from different inputs; re-record it`);
  }
} else {
  const recorded = readdirSync(join(repo, GOLDENS)).filter((name) => name.startsWith("hono-"));
  console.log(
    `::notice::Runtime inputs changed since the committed goldens (${recorded.join(", ") || "none"}); ` +
      `this run is pinned at ${meta.pinnedSha}. Re-record before a parity cutover compares against them.`,
  );
}

if (process.env.PARITY_ARTIFACT_DIR)
  await cp(dirs[0], process.env.PARITY_ARTIFACT_DIR, { recursive: true });
process.exitCode = failed ? 1 : 0;
