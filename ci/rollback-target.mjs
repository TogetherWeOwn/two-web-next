// Rollback targets: one definition for the rollback workflow, the daily
// staging rollback drill and the production promotion preflight.
//
// rollback-production.yml rolls one environment's Worker back to a recorded
// Worker Version. The environment table below is the only place that maps an
// environment name to its Worker, origin and smoke flags, so the drill
// exercises the exact code path production uses.
//
// The promotion preflight refuses to promote when production has no valid
// rollback target: /up must name the live version and its commit (the deploy
// job then confirms that version is the single 100% deployment and still
// has its required secrets), and every migration the candidate
// adds since that commit must keep the live code working (no destructive
// statement unless the migration carries a reviewed `-- rollback-safe:`
// note). A red staging rollback drill also refuses promotion until the next
// drill is green.
//
// CLIs read `wrangler ... --json` from stdin and never echo it.
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { APEX_ORIGIN, STAGING_ORIGIN } from "./operator-constants.mjs";
import {
  assertRollbackVersionId,
  pendingMigrationTags,
  productionJournalEntries,
} from "./production-deploy-gate.mjs";

export const ROLLBACK_ENVIRONMENTS = {
  production: { worker: "two-web-next-production", origin: APEX_ORIGIN, indexable: true },
  staging: { worker: "two-web-next", origin: STAGING_ORIGIN, indexable: false },
};

export function rollbackEnvironment(name) {
  if (!Object.hasOwn(ROLLBACK_ENVIRONMENTS, name ?? "")) {
    throw new Error(
      `Rollback environment must be one of ${Object.keys(ROLLBACK_ENVIRONMENTS).join(", ")}`,
    );
  }
  return { name, ...ROLLBACK_ENVIRONMENTS[name] };
}

// `wrangler deployments list --json` prints oldest first; order by
// created_on, never by array position. Self-contained (no import from the
// gradual-promote action) so sparse /ci/ checkouts can run it.
function newestFirst(deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    throw new Error("expected a non-empty deployments list");
  }
  return [...deployments].sort((a, b) =>
    String(b?.created_on ?? "").localeCompare(String(a?.created_on ?? "")),
  );
}

function singleFullVersion(deployment) {
  const versions = Array.isArray(deployment?.versions) ? deployment.versions : [];
  if (versions.length !== 1 || versions[0]?.percentage !== 100) return null;
  const id = versions[0]?.version_id;
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)
    ? id
    : null;
}

// The live version: the single 100% version of the newest deployment. A
// split deployment refuses: an active gradual rollout has no single target.
export function liveVersion(deployments) {
  const id = singleFullVersion(newestFirst(deployments)[0]);
  if (!id) {
    throw new Error("refusing: latest deployment is not a single-version 100% deployment");
  }
  return id;
}

// The version that served 100% before the live one: the newest older
// single-version 100% deployment whose version differs from the live one.
// Split deployments (a past gradual rollout) are skipped, never chosen.
export function previousVersion(deployments) {
  const current = liveVersion(deployments);
  for (const entry of newestFirst(deployments).slice(1)) {
    const id = singleFullVersion(entry);
    if (id && id !== current) return id;
  }
  throw new Error("No earlier single-version 100% deployment to roll back to");
}

// Guard before a rollback mutates traffic. "rollback" when the live version
// is the expected one, "skip" when the target already serves (a rerun or a
// restore after a rollback that never moved traffic), and a refusal when
// anything else is live: someone deployed in between, and rolling back now
// would discard that deploy.
export function rollbackAction(deployments, { expected, target }) {
  assertRollbackVersionId(expected);
  assertRollbackVersionId(target);
  const current = liveVersion(deployments);
  if (current === target) return "skip";
  if (current === expected) return "rollback";
  throw new Error(
    `Refusing rollback: live version ${current} is neither the expected ${expected} nor the target ${target}`,
  );
}

// Statements that can break code already running against the schema. N-1
// code must keep working after a migration, so these refuse the rollback
// target unless the migration names why it is safe.
const DESTRUCTIVE_PATTERNS = [
  /\bDROP\s+(TABLE|COLUMN|VIEW|MATERIALIZED\s+VIEW|TYPE|SCHEMA|FUNCTION)\b/i,
  /\bRENAME\s+(TO|COLUMN)\b/i,
  /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+(SET\s+DATA\s+)?TYPE\b/i,
  /\bALTER\s+COLUMN\s+("[^"]+"|\w+)\s+SET\s+NOT\s+NULL\b/i,
  /^\s*TRUNCATE\b/i,
];

const ROLLBACK_SAFE_NOTE = /^--\s*rollback-safe:\s*\S.{9,}$/m;

function stripSqlComments(sql) {
  return String(sql)
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ");
}

// Destructive statements in one migration, or none when it carries a
// `-- rollback-safe: <reason>` note (reason of at least 10 characters).
export function destructiveStatements(sql) {
  if (ROLLBACK_SAFE_NOTE.test(String(sql))) return [];
  return stripSqlComments(sql)
    .split(/;|-->\s*statement-breakpoint/)
    .map((statement) => statement.replace(/\s+/g, " ").trim())
    .filter((statement) => DESTRUCTIVE_PATTERNS.some((pattern) => pattern.test(statement)));
}

async function migrationSqlAt({ repository, ref, tag, token, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/contents/drizzle/${encodeURIComponent(tag)}.sql?ref=${ref}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github.raw+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (!response.ok) throw new Error(`Migration ${tag} lookup failed (HTTP ${response.status})`);
  return response.text();
}

// Migrations the target adds since the rollback target's commit, and the
// ones among them that would break the rollback target.
export async function rollbackCompatibility({
  repository,
  targetSha,
  previousSha,
  token,
  fetchImpl = fetch,
}) {
  const { target, live } = await productionJournalEntries({
    repository,
    targetSha,
    liveSha: previousSha,
    token,
    fetchImpl,
  });
  const added = pendingMigrationTags(
    target.map((entry) => entry.tag),
    live.map((entry) => entry.tag),
  );
  const unsafe = [];
  for (const tag of added) {
    if (typeof tag !== "string" || !/^[\w.-]+$/.test(tag)) {
      throw new Error("Migration journal has an invalid tag");
    }
    const sql = await migrationSqlAt({ repository, ref: targetSha, tag, token, fetchImpl });
    if (destructiveStatements(sql).length) unsafe.push(tag);
  }
  return { added, unsafe };
}

// /up names the serving version and its commit. The preflight trusts the
// commit only when /up reports the same version the deployments list does.
export async function readLiveRevision({ origin, fetchImpl = fetch }) {
  const response = await fetchImpl(new URL("/up", origin), {
    redirect: "manual",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  const versionId = body?.revision?.version_id;
  const commit = body?.revision?.commit;
  return {
    versionId: typeof versionId === "string" ? versionId : null,
    commit: typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null,
  };
}

export async function checkRollbackTarget({
  origin,
  repository,
  targetSha,
  token,
  fetchImpl = fetch,
  readRevision = readLiveRevision,
  attempts = 3,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  if (!/^[0-9a-f]{40}$/.test(targetSha ?? "")) {
    throw new Error("DEPLOY_SHA must be a full 40-hex commit");
  }
  const valid = (revision) =>
    typeof revision?.versionId === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(revision.versionId) &&
    Boolean(revision.commit);
  let revision = { versionId: null, commit: null };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      revision = await readRevision({ origin, fetchImpl });
      if (valid(revision)) break;
    } catch {
      revision = { versionId: null, commit: null };
    }
    if (attempt < attempts) await sleep(2000);
  }
  if (!valid(revision)) {
    throw new Error(
      `No valid rollback target: /up did not report the live version ID and commit after ${attempts} reads`,
    );
  }
  const { versionId } = revision;
  const { added, unsafe } = await rollbackCompatibility({
    repository,
    targetSha,
    previousSha: revision.commit,
    token,
    fetchImpl,
  });
  if (unsafe.length) {
    throw new Error(
      `No valid rollback target: ${unsafe.join(", ")} would break ${versionId} (${revision.commit}); make the migration expand-only, or add a reviewed "-- rollback-safe: <reason>" note`,
    );
  }
  return { versionId, commit: revision.commit, added };
}

// A red staging rollback drill holds promotion until a drill is green again.
// No completed drill yet passes, so the first promotion after the drill
// lands is not blocked by its absence.
export async function assertRollbackDrillGreen({ repository, token, fetchImpl = fetch }) {
  const query = new URLSearchParams({ branch: "main", status: "completed", per_page: "20" });
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/actions/workflows/staging-rollback-drill.yml/runs?${query}`,
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
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Rollback drill lookup failed (HTTP ${response.status})`);
  const runs = ((await response.json()).workflow_runs ?? []).filter(
    (run) => run.conclusion !== "cancelled" && run.conclusion !== "skipped",
  );
  if (!runs.length) return null;
  const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
  if (latest.conclusion !== "success") {
    throw new Error(
      `Promotion held: the latest staging rollback drill (run ${latest.id}) concluded ${latest.conclusion}; fix it and rerun staging-rollback-drill`,
    );
  }
  return latest.id;
}

// Workflows that deploy to staging or test it: the drill waits until none of
// them is queued or running, so it never moves staging under a journey run.
export const STAGING_LANE_WORKFLOWS = ["deploy.yml", "e2e-staging.yml"];

export async function stagingBusyRuns({ repository, token, fetchImpl = fetch }) {
  const busy = [];
  for (const file of STAGING_LANE_WORKFLOWS) {
    for (const status of ["in_progress", "queued", "waiting"]) {
      const query = new URLSearchParams({ status, per_page: "20" });
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
      if (!response.ok) throw new Error(`Staging lane lookup failed (HTTP ${response.status})`);
      for (const run of (await response.json()).workflow_runs ?? []) {
        if (Number.isSafeInteger(run?.id)) busy.push(`${file} run ${run.id}`);
      }
    }
  }
  return busy;
}

function readStdin() {
  return readFileSync(0, "utf8");
}

function output(lines) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}

export const ROLLBACK_TARGET_USAGE =
  "Usage: node ci/rollback-target.mjs (--environment | --live-version | --previous-version | --action | --check-target | --check-drill | --staging-busy)";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const flag = process.argv[2];
    if (flag === "--environment") {
      const config = rollbackEnvironment(process.env.ROLLBACK_ENVIRONMENT);
      output([
        `worker=${config.worker}`,
        `origin=${config.origin}`,
        `indexable=${config.indexable}`,
      ]);
      console.log(
        `Rollback environment ${config.name}: Worker ${config.worker} at ${config.origin}`,
      );
    } else if (flag === "--live-version") {
      process.stdout.write(`${liveVersion(JSON.parse(readStdin()))}\n`);
    } else if (flag === "--previous-version") {
      process.stdout.write(`${previousVersion(JSON.parse(readStdin()))}\n`);
    } else if (flag === "--action") {
      const action = rollbackAction(JSON.parse(readStdin()), {
        expected: process.env.EXPECTED_CURRENT_VERSION_ID,
        target: process.env.ROLLBACK_VERSION_ID,
      });
      output([`action=${action}`]);
      console.log(
        action === "skip"
          ? `Target ${process.env.ROLLBACK_VERSION_ID} already serves; nothing to roll back`
          : `Live version is the expected ${process.env.EXPECTED_CURRENT_VERSION_ID}; rolling back`,
      );
    } else if (flag === "--check-target") {
      const result = await checkRollbackTarget({
        origin: rollbackEnvironment(process.env.ROLLBACK_ENVIRONMENT ?? "production").origin,
        repository: process.env.GITHUB_REPOSITORY,
        targetSha: process.env.DEPLOY_SHA,
        token: process.env.GITHUB_TOKEN,
      });
      output([`version_id=${result.versionId}`, `commit=${result.commit}`]);
      console.log(
        `Rollback target ${result.versionId} (${result.commit}) is valid; the candidate adds ${result.added.length} migration(s), none destructive`,
      );
    } else if (flag === "--check-drill") {
      const runId = await assertRollbackDrillGreen({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GITHUB_TOKEN,
      });
      console.log(
        runId
          ? `Latest staging rollback drill (run ${runId}) is green`
          : "No completed staging rollback drill yet; not holding promotion",
      );
    } else if (flag === "--staging-busy") {
      const busy = await stagingBusyRuns({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GITHUB_TOKEN,
      });
      output([`busy=${busy.length > 0}`]);
      console.log(busy.length ? `Staging lane busy: ${busy.join(", ")}` : "Staging lane idle");
    } else {
      console.error(ROLLBACK_TARGET_USAGE);
      process.exitCode = 2;
    }
  } catch (error) {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
