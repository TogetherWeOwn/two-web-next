import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { APEX_ORIGIN } from "./operator-constants.mjs";
import { deployTitle, e2eTitle } from "./resolve-promotion-sha.mjs";
import { requireSuccessfulCi } from "./staging-deploy-gate.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

export const AUTOMATIC_PROMOTION_EVENTS = new Set([
  "workflow_dispatch",
  "workflow_run",
  "schedule",
]);

export function assertProductionRequest(env) {
  if (env.PRODUCTION_DEPLOY_ENABLED !== "true") {
    throw new Error(
      "Production deployment disabled: repo variable PRODUCTION_DEPLOY_ENABLED must be exactly true",
    );
  }
  if (
    !AUTOMATIC_PROMOTION_EVENTS.has(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error(
      "Production deployment requires workflow_dispatch on main (or workflow_run/schedule on main for automatic promotion)",
    );
  }
  // Automatic triggers have no human reviewer to approve the Environment:
  // they must run under automated staging evidence, never the reviewer path.
  if (env.GITHUB_EVENT_NAME !== "workflow_dispatch" && !autoApproveEnabled(env)) {
    throw new Error(
      "Automatic production promotion requires repo variable PRODUCTION_AUTO_APPROVE exactly true",
    );
  }
}

// Repo variable PRODUCTION_HOLD_UNTIL (ISO-8601 UTC) pauses automatic and
// manual promotion while now < value. Values more than 24h ahead are refused
// so a stale hold cannot park production indefinitely. Empty means no hold.
export const PRODUCTION_HOLD_MAX_MS = 24 * 60 * 60 * 1000;
const HOLD_ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/;

export function assertProductionHold(env, { nowMs = Date.now() } = {}) {
  const raw = (env.PRODUCTION_HOLD_UNTIL ?? "").trim();
  if (!raw) return;
  if (!HOLD_ISO_PATTERN.test(raw)) {
    throw new Error(
      "PRODUCTION_HOLD_UNTIL must be ISO-8601 UTC (e.g. 2026-10-20T14:00:00Z); clear it to resume promotion",
    );
  }
  const holdMs = Date.parse(raw);
  if (!Number.isFinite(holdMs)) {
    throw new Error(
      "PRODUCTION_HOLD_UNTIL is not a valid UTC timestamp; clear it to resume promotion",
    );
  }
  if (holdMs - nowMs > PRODUCTION_HOLD_MAX_MS) {
    throw new Error(
      "PRODUCTION_HOLD_UNTIL refuses values more than 24h ahead; shorten the hold or clear it",
    );
  }
  if (nowMs < holdMs) {
    throw new Error(
      `Production promotion held until ${raw}; clear PRODUCTION_HOLD_UNTIL to resume`,
    );
  }
}

// Live production identity: the Cloudflare active version's commit, read from
// the production apex /up revision marker (the same source the production
// promoter uses). Returns the 40-hex commit, or null when the marker is
// absent or unreadable (unknown, never equal).
export const PRODUCTION_ORIGIN = APEX_ORIGIN;

export async function readLiveProductionCommit({
  origin = PRODUCTION_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  try {
    const response = await fetchImpl(new URL("/up", origin), {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await response.json();
    const commit = data?.revision?.commit;
    return typeof commit === "string" && /^[0-9a-f]{40}$/.test(commit) ? commit : null;
  } catch {
    return null;
  }
}

export function isAlreadyLive(deploySha, liveSha) {
  return (
    typeof deploySha === "string" &&
    typeof liveSha === "string" &&
    deploySha.toLowerCase() === liveSha.toLowerCase() &&
    /^[0-9a-f]{40}$/i.test(deploySha)
  );
}

// Pending-production-migration comparison: tags in the target journal that
// the live production journal lacks. Pure, so the workflow and the tests
// share one definition without database access.
export function pendingMigrationTags(targetTags, liveTags) {
  const live = new Set(Array.isArray(liveTags) ? liveTags : []);
  return (Array.isArray(targetTags) ? targetTags : []).filter((tag) => !live.has(tag));
}

function decodeJournalEntries(content, encoding) {
  const text =
    encoding === "base64"
      ? Buffer.from(String(content ?? "").replace(/\s+/g, ""), "base64").toString("utf8")
      : String(content ?? "");
  const journal = JSON.parse(text);
  if (!Array.isArray(journal?.entries)) throw new Error("Invalid migration journal");
  return journal.entries.map((entry) => ({ tag: entry?.tag, when: entry?.when }));
}

async function journalEntriesAt({ repository, ref, token, fetchImpl }) {
  const response = await fetchImpl(
    `https://api.github.com/repos/${repository}/contents/drizzle/meta/_journal.json?ref=${ref}`,
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
  if (!response.ok) throw new Error(`Migration journal lookup failed (HTTP ${response.status})`);
  const body = await response.json();
  return decodeJournalEntries(body.content, body.encoding);
}

function assertJournalRefs(targetSha, liveSha) {
  if (!/^[0-9a-f]{40}$/.test(targetSha ?? "") || !/^[0-9a-f]{40}$/.test(liveSha ?? "")) {
    throw new Error("Migration comparison needs full 40-hex target and live commits");
  }
}

export async function productionJournalEntries({
  repository,
  targetSha,
  liveSha,
  token,
  fetchImpl = fetch,
}) {
  assertJournalRefs(targetSha, liveSha);
  const [target, live] = await Promise.all([
    journalEntriesAt({ repository, ref: targetSha, token, fetchImpl }),
    journalEntriesAt({ repository, ref: liveSha, token, fetchImpl }),
  ]);
  return { target, live };
}

export async function pendingProductionMigrations({
  repository,
  targetSha,
  liveSha,
  token,
  fetchImpl = fetch,
}) {
  if (!liveSha) return [];
  assertJournalRefs(targetSha, liveSha);
  async function journalAt(ref) {
    const entries = await journalEntriesAt({ repository, ref, token, fetchImpl });
    return entries.map((entry) => entry.tag);
  }
  const [target, live] = await Promise.all([journalAt(targetSha), journalAt(liveSha)]);
  return pendingMigrationTags(target, live);
}

// Web journal entries: the same 1000-series filter as WEB_MIGRATIONS in
// src/up-migrations.ts. Grandfathered 0000/0001 tags are outside the
// readiness gate there and outside the ledger proof here.
const WEB_MIGRATION_TAG_PATTERN = /^1\d{3}_/;

export function targetWebEntries(entries) {
  return (Array.isArray(entries) ? entries : []).filter((entry) =>
    WEB_MIGRATION_TAG_PATTERN.test(entry?.tag ?? ""),
  );
}

// True when any target web entry lacks a usable timestamp: the ledger cannot
// prove such an entry applied, so unknown fails closed, it never clears.
export function targetWebEndUnknown(entries) {
  return targetWebEntries(entries).some(
    (entry) => typeof entry?.when !== "number" || !Number.isSafeInteger(entry.when),
  );
}

// Target web entries the production ledger lacks: `when` not in the applied
// set. Set inclusion, never a high-water mark: a max would let a newer bot
// row (or any foreign row) mask a missing web migration, the exact
// comparison ci/db-migrate.mjs refuses. Pure, so the CLI and the tests share
// one definition.
export function pendingLedgerTags(targetEntries, applied) {
  if (!Array.isArray(applied) || !applied.every((when) => Number.isSafeInteger(when))) {
    throw new Error("Ledger comparison needs the applied migration_ledger set");
  }
  const have = new Set(applied);
  return targetWebEntries(targetEntries)
    .filter((entry) => !have.has(entry.when))
    .map((entry) => entry.tag);
}

// Live production ledger state from a /up body: db ok, zero pending, and the
// applied migration_ledger set. Anything else fails closed with a ledger
// reason — an unknown, unreadable or stale ledger never clears a promotion.
export function readLedgerState(body) {
  if (body?.db !== "ok" || body?.pending_migrations !== 0) {
    throw new Error(
      `production ledger is not provably current (db ${JSON.stringify(body?.db)}, pending_migrations ${JSON.stringify(body?.pending_migrations)})`,
    );
  }
  const ledger = body?.migration_ledger;
  if (!Array.isArray(ledger) || !ledger.every((when) => Number.isSafeInteger(when))) {
    throw new Error(
      `production ledger set is missing or invalid (migration_ledger ${JSON.stringify(ledger)}); the live Worker may predate the ledger signal`,
    );
  }
  return ledger;
}

export async function readLiveProductionLedger({
  origin = PRODUCTION_ORIGIN,
  fetchImpl = fetch,
} = {}) {
  let body;
  try {
    const response = await fetchImpl(new URL("/up", origin), {
      redirect: "manual",
      headers: { "cache-control": "no-cache" },
      signal: AbortSignal.timeout(10_000),
    });
    body = await response.json();
  } catch (error) {
    throw new Error(
      `production ledger read failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return readLedgerState(body);
}

export function assertProductionCredentials(env) {
  if (!env.CLOUDFLARE_API_TOKEN?.trim() || !env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    throw new Error(
      "Production-only Cloudflare credentials must be configured in the production Environment",
    );
  }
}

// Repo variable PRODUCTION_AUTO_APPROVE=true replaces the human Environment
// reviewer with automated evidence: the same exact SHA must also be deployed to
// staging and pass e2e-staging. Any other value keeps the reviewer requirement.
export function autoApproveEnabled(env) {
  return env.PRODUCTION_AUTO_APPROVE === "true";
}

export function assertProductionProtection(environment, { autoApprove = false } = {}) {
  if (autoApprove) {
    const policy = environment.deployment_branch_policy;
    if (
      environment.name !== "production" ||
      policy?.custom_branch_policies !== true ||
      policy?.protected_branches !== false ||
      !environment.protection_rules?.some((rule) => rule.type === "branch_policy")
    ) {
      throw new Error("production Environment must keep its main-only deployment branch policy");
    }
    return;
  }
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

export const stagingEvidenceWorkflows = ["deploy.yml", "e2e-staging.yml"];
// The web quality gate is a reusable-workflow call, so its job is "<caller> / <called job>".
export const stagingQualityJob = "staging-quality / quality";
export const stagingQualitySteps = [
  "Lighthouse performance budgets (mobile, ci/lighthouserc.cjs)",
  "Lighthouse quality scores (desktop, categories vs ci/quality-budget.json)",
];

// A green quality job with a skipped or failed Lighthouse step has not executed the gate.
function requireExecutedStagingQuality(jobs, runId) {
  const quality = jobs.filter((job) => job.name === stagingQualityJob);
  if (quality.length !== 1) {
    throw new Error(
      `e2e-staging.yml run ${runId} has missing or ambiguous staging-quality evidence`,
    );
  }
  const [job] = quality;
  const executed = stagingQualitySteps.every((name) =>
    (job.steps ?? []).some((step) => step.name === name && step.conclusion === "success"),
  );
  if (job.conclusion !== "success" || !executed) {
    throw new Error(
      `e2e-staging.yml run ${runId} did not execute and pass the staging quality gate`,
    );
  }
}

// Automated approval evidence: for each staging workflow, the most recent run on
// the deployment SHA must be a completed success. An older success does not
// count if a later run on the same SHA failed or is still running.
// deploy.yml and e2e-staging.yml run on workflow_run, so their API head_sha is
// main's tip when they triggered, not the deployed commit. Their run-names carry
// the deployed SHA (deploy <sha>, e2e-staging deploy <sha>); evidence joins on
// that. The newest run per title decides, and the e2e run must have actually
// passed staging-journeys (it concludes success with the job skipped).
export async function requireStagingEvidence(
  { repository, sha },
  { token, fetchImpl = fetch, workflows = stagingEvidenceWorkflows, pages = 3 } = {},
) {
  async function get(path) {
    const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      throw new Error(`Staging evidence request failed (HTTP ${response.status})`);
    }
    return response.json();
  }
  const titles = { "deploy.yml": deployTitle(sha), "e2e-staging.yml": e2eTitle(sha) };
  const evidence = [];
  for (const file of workflows) {
    const runs = [];
    for (let page = 1; page <= pages; page += 1) {
      const query = new URLSearchParams({ branch: "main", per_page: "100", page: String(page) });
      const batch = (await get(`/actions/workflows/${file}/runs?${query}`)).workflow_runs ?? [];
      runs.push(...batch.filter((run) => run.display_title === titles[file]));
      if (batch.length < 100) break;
    }
    if (!runs.length) {
      throw new Error(`Missing or incomplete exact-SHA ${file} evidence`);
    }
    if (
      !runs.every(
        (run) =>
          Number.isSafeInteger(run.id) &&
          run.head_branch === "main" &&
          run.path === `.github/workflows/${file}` &&
          run.head_repository?.full_name === repository,
      )
    ) {
      throw new Error(`${file} evidence revision/branch/workflow mismatch`);
    }
    const latest = runs.reduce((a, b) => (b.id > a.id ? b : a));
    if (latest.status !== "completed" || latest.conclusion !== "success") {
      throw new Error(`Latest ${file} run on the deployment SHA is not successful`);
    }
    if (file === "e2e-staging.yml") {
      const { jobs = [] } = await get(`/actions/runs/${latest.id}/jobs?per_page=100`);
      if (jobs.find((job) => job.name === "staging-journeys")?.conclusion !== "success") {
        throw new Error(`e2e-staging.yml run ${latest.id} did not pass staging-journeys`);
      }
      requireExecutedStagingQuality(jobs, latest.id);
    }
    evidence.push({ workflow: file, runId: latest.id });
  }
  return evidence;
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
  const botDatabase = Array.isArray(bindings)
    ? bindings.filter((entry) => entry?.binding === "BOT_DB")
    : [];
  if (
    botDatabase.length !== 1 ||
    typeof botDatabase[0].id !== "string" ||
    !/^[a-fA-F0-9]{32}$/.test(botDatabase[0].id)
  ) {
    throw new Error("Production Hyperdrive BOT_DB binding must have one valid id");
  }
  if (botDatabase[0].id === "00000000000000000000000000000000") {
    throw new Error(
      "Production Hyperdrive BOT_DB is still a placeholder; provision and review the cutover configuration first",
    );
  }
}

// The checkout must be the promoted SHA itself: deploy-production.yml resolves
// DEPLOY_SHA once (explicit input or latest staging-verified commit) and checks
// it out in both gate jobs, so a newer main head never deploys.
function currentCheckoutSha() {
  // The job container may not own the host checkout; trust only this path,
  // only for this command (https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory).
  return execFileSync("git", ["-c", `safe.directory=${resolve(".")}`, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();
}

export async function checkProductionGate(env, fetchEnvironment = fetch, options = {}) {
  // checkoutSha stays lazy so disabled/unprotected requests refuse before any
  // subprocess or CI lookup. Tests pass it explicitly; the CLI resolves it.
  let { checkoutSha, fetchCi = fetchEnvironment, rollback = false } = options;
  // Refuse before any API request, and before the protected deploy job can start.
  assertProductionRequest(env);
  // Hold applies to every promotion trigger (manual and automatic) and fails
  // before any API request, so a held production never starts a deploy. A
  // rollback is the way out of a bad release and never waits on a hold.
  if (!rollback) assertProductionHold(env);
  // The runner resets step-level GITHUB_* overrides to github.sha (the dispatch
  // tip), so the promoted commit arrives as DEPLOY_SHA.
  if (!/^[0-9a-f]{40}$/.test(env.DEPLOY_SHA ?? "")) {
    throw new Error("DEPLOY_SHA must be a full 40-hex commit (resolved by the preflight job)");
  }
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
  const autoApprove = autoApproveEnabled(env);
  assertProductionProtection(await response.json(), { autoApprove });
  // Exact-SHA green main CI, shared with the staging gate: a red or pending
  // ci.yml run on this SHA must never reach production.
  checkoutSha ??= currentCheckoutSha();
  // The CI evidence check always takes the explicit-SHA dispatch path: the
  // promotion trigger (dispatch, workflow_run or schedule) is already
  // validated by assertProductionRequest above, and DEPLOY_SHA is the exact
  // commit to verify, never the trigger's own SHA.
  const ci = await requireSuccessfulCi(
    {
      eventName: "workflow_dispatch",
      event: { repository: { full_name: env.GITHUB_REPOSITORY } },
      repository: env.GITHUB_REPOSITORY,
      ref: "refs/heads/main",
      sha: env.DEPLOY_SHA,
      checkoutSha,
    },
    { token: env.GITHUB_TOKEN, fetchImpl: fetchCi },
  );
  // A rollback serves a version production already served, never the
  // checked-out commit, so staging evidence for that commit proves nothing:
  // the checkout only supplies the rollback scripts, and green main CI
  // vouches for them.
  if (!autoApprove || rollback) return ci;
  const staging = await requireStagingEvidence(
    { repository: env.GITHUB_REPOSITORY, sha: ci.sha },
    { token: env.GITHUB_TOKEN, fetchImpl: fetchCi },
  );
  return { ...ci, autoApprove: true, staging };
}

// Rollback gate for rollback-production.yml, per environment. Production
// keeps the enable flag, main-only request, Environment protection and
// green exact-SHA CI of the checked-out scripts; staging keeps the main-only
// request and green CI. Neither checks a hold or staging evidence.
export async function checkRollbackGate(env, fetchImpl = fetch, options = {}) {
  const environment = env.ROLLBACK_ENVIRONMENT;
  if (environment === "production") {
    return checkProductionGate(env, fetchImpl, { ...options, rollback: true });
  }
  if (environment !== "staging") {
    throw new Error("ROLLBACK_ENVIRONMENT must be production or staging");
  }
  if (
    !AUTOMATIC_PROMOTION_EVENTS.has(env.GITHUB_EVENT_NAME) ||
    env.GITHUB_REF !== "refs/heads/main"
  ) {
    throw new Error(
      "Staging rollback requires workflow_dispatch, workflow_run or schedule on main",
    );
  }
  if (!/^[0-9a-f]{40}$/.test(env.DEPLOY_SHA ?? "")) {
    throw new Error("DEPLOY_SHA must be a full 40-hex commit (the checked-out rollback scripts)");
  }
  if (!env.GITHUB_TOKEN || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? "")) {
    throw new Error("Staging rollback CI evidence cannot be verified");
  }
  const checkoutSha = options.checkoutSha ?? currentCheckoutSha();
  return requireSuccessfulCi(
    {
      eventName: "workflow_dispatch",
      event: { repository: { full_name: env.GITHUB_REPOSITORY } },
      repository: env.GITHUB_REPOSITORY,
      ref: "refs/heads/main",
      sha: env.DEPLOY_SHA,
      checkoutSha,
    },
    { token: env.GITHUB_TOKEN, fetchImpl },
  );
}

// The single flag reference for this tool: --help prints it to stdout,
// unknown dash-flags print it to stderr with exit 2 instead of running the
// gate. A bare invocation (or a non-flag positional, as before) runs the
// full gate.
export const PRODUCTION_DEPLOY_GATE_USAGE =
  "Usage: node ci/production-deploy-gate.mjs [--credentials | --version-id | --rollback | --already-live | --check-migrations | --help]\nWith no flag, runs the full production gate.";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "--help") {
      // Safe discovery: usage to stdout, exit 0, zero side effects — no gate
      // run, no GITHUB_OUTPUT write.
      console.log(PRODUCTION_DEPLOY_GATE_USAGE);
    } else if (process.argv[2] === "--credentials") {
      assertProductionCredentials(process.env);
      console.log("Production-only Cloudflare credentials are present");
    } else if (process.argv[2] === "--version-id") {
      assertRollbackVersionId(process.env.ROLLBACK_VERSION_ID);
      console.log("Rollback version_id is a valid Worker Version ID");
    } else if (process.argv[2] === "--rollback") {
      const evidence = await checkRollbackGate(process.env);
      console.log(
        `${process.env.ROLLBACK_ENVIRONMENT} rollback request and exact-SHA CI checks passed: scripts ${evidence.sha}, full CI run ${evidence.runId}, attempt ${evidence.runAttempt}`,
      );
    } else if (process.argv[2] === "--already-live") {
      // Clean skip when production already serves the target: exits 0 in
      // both cases and reports via GITHUB_OUTPUT so the workflow can skip
      // the deploy without going red. An unreadable /up never counts as
      // live (fail open toward deploying, not toward skipping).
      const deploySha = (process.env.DEPLOY_SHA ?? "").replace(/\s+/g, "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(deploySha)) {
        throw new Error("DEPLOY_SHA must be a full 40-hex commit (resolved by the preflight job)");
      }
      const origin =
        (process.env.PRODUCTION_ORIGIN ?? PRODUCTION_ORIGIN).trim() || PRODUCTION_ORIGIN;
      const live = await readLiveProductionCommit({ origin });
      const already = isAlreadyLive(deploySha, live);
      console.log(
        already
          ? `Production already serves ${deploySha}; skipping deploy`
          : live
            ? `Production serves ${live}, promoting ${deploySha}`
            : "Production live commit unreadable; proceeding to promotion gates",
      );
      if (process.env.GITHUB_OUTPUT) {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `already_live=${already ? "true" : "false"}\nlive_sha=${live ?? ""}\n`,
        );
      }
    } else if (process.argv[2] === "--check-migrations") {
      // Pending-migration stop until the least-privilege migrator lands.
      // This step runs from the tip checkout (before the target re-checkout
      // in deploy-production.yml), so an older target can never shadow it
      // with a script that lacks this flag. When the target journal has
      // entries the live Worker's journal lacks, the live production ledger
      // (/up migration_ledger) decides by set inclusion: a ledger holding
      // every target web entry clears automatic promotion without any manual
      // dispatch, because db-migrate.yml (target production) applied the
      // entries out of band. Otherwise automatic promotion stops here, and
      // manual dispatch stops unless the operator confirms the migrations
      // were applied out of band with migrations_applied=true. The
      // confirmation travels in the workflow inputs and is repeated in the
      // log line below, so the continuation stays audited. A ledger that
      // cannot be read fails closed with a ledger reason. Unknown live
      // (unreadable /up) cannot prove pending: the read is retried, then
      // automatic runs halt for a later retry while manual dispatch requires
      // the same audited confirmation.
      const deploySha = (process.env.DEPLOY_SHA ?? "").replace(/\s+/g, "").toLowerCase();
      if (!/^[0-9a-f]{40}$/.test(deploySha)) {
        throw new Error("DEPLOY_SHA must be a full 40-hex commit (resolved by the preflight job)");
      }
      const eventName = process.env.GITHUB_EVENT_NAME ?? "";
      const automatic = eventName === "workflow_run" || eventName === "schedule";
      const origin =
        (process.env.PRODUCTION_ORIGIN ?? PRODUCTION_ORIGIN).trim() || PRODUCTION_ORIGIN;
      let liveSha = (process.env.LIVE_SHA ?? "").replace(/\s+/g, "").toLowerCase() || null;
      if (!liveSha) {
        for (let attempt = 0; attempt < 3 && !liveSha; attempt += 1) {
          if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 2000));
          liveSha = await readLiveProductionCommit({ origin });
        }
      }
      if (!liveSha) {
        if (automatic) {
          throw new Error(
            "Live production commit unknown after 3 /up reads; halting automatic promotion for a later retry",
          );
        }
        if (
          eventName !== "workflow_dispatch" ||
          (process.env.MIGRATIONS_APPLIED ?? "") !== "true"
        ) {
          throw new Error(
            `Live production commit unknown after 3 /up reads; restore the live commit read or confirm db-migrate.yml (target production) applied the target's migrations, then re-dispatch this workflow with sha ${deploySha} and migrations_applied=true`,
          );
        }
        console.log(
          `Manual continuation with live production commit unknown after 3 /up reads: db-migrate.yml (target production) must have applied the target's migrations already — proceeding on operator confirmation (migrations_applied=true) for ${deploySha} vs live unknown`,
        );
      } else {
        const { target, live } = await productionJournalEntries({
          repository: process.env.GITHUB_REPOSITORY,
          targetSha: deploySha,
          liveSha,
          token: process.env.GITHUB_TOKEN,
        });
        const pending = pendingMigrationTags(
          target.map((entry) => entry.tag),
          live.map((entry) => entry.tag),
        );
        if (pending.length) {
          if (!automatic && (process.env.MIGRATIONS_APPLIED ?? "") === "true") {
            console.log(
              `Manual continuation with ${pending.length} pending production migration(s) (${pending.join(", ")}): db-migrate.yml (target production) must have applied them already — proceeding on operator confirmation (migrations_applied=true) for ${deploySha} vs live ${liveSha}`,
            );
          } else {
            // The live Worker's journal lags the target: ask the live ledger
            // whether production was already migrated out of band. Equal
            // journals and manual confirmations never reach this read.
            let applied;
            try {
              applied = await readLiveProductionLedger({ origin });
            } catch (error) {
              if (automatic) {
                throw new Error(
                  `Target has ${pending.length} production migration(s) production lacks (${pending.join(", ")}); the production ledger read failed (${error.message}), so this promotion stops here — automatic production migration is blocked until the least-privilege migrator lands`,
                );
              }
              throw new Error(
                `Target has ${pending.length} production migration(s) production lacks (${pending.join(", ")}); the production ledger read failed (${error.message}) — run db-migrate.yml (target production) first, then re-dispatch this workflow with sha ${deploySha} and migrations_applied=true`,
              );
            }
            if (targetWebEndUnknown(target)) {
              if (automatic) {
                throw new Error(
                  `Target has ${pending.length} production migration(s) production lacks (${pending.join(", ")}); a target web entry lacks a usable timestamp, so the production ledger cannot prove it applied — automatic production migration is blocked until the least-privilege migrator lands`,
                );
              }
              throw new Error(
                `Target has ${pending.length} production migration(s) production lacks (${pending.join(", ")}); a target web entry lacks a usable timestamp, so the production ledger cannot prove it applied — run db-migrate.yml (target production) first, then re-dispatch this workflow with sha ${deploySha} and migrations_applied=true`,
              );
            }
            const ledgerPending = pendingLedgerTags(target, applied);
            if (ledgerPending.length) {
              if (automatic) {
                throw new Error(
                  `Target has ${ledgerPending.length} production migration(s) the production ledger lacks (${ledgerPending.join(", ")}); automatic production migration is blocked until the least-privilege migrator lands, so this promotion stops here`,
                );
              }
              throw new Error(
                `Target has ${ledgerPending.length} production migration(s) the production ledger lacks (${ledgerPending.join(", ")}); run db-migrate.yml (target production) first, then re-dispatch this workflow with sha ${deploySha} and migrations_applied=true — automatic production migration is blocked until the least-privilege migrator lands`,
              );
            }
            const proven = targetWebEntries(target).length;
            console.log(
              `Production ledger holds all ${proven} target web migration(s) (applied set of ${applied.length}); clearing ${automatic ? "automatic" : "manual"} promotion for ${deploySha} vs live ${liveSha}`,
            );
          }
        } else {
          console.log(`No pending production migrations (${deploySha} vs live ${liveSha})`);
        }
      }
    } else if (typeof process.argv[2] === "string" && process.argv[2].startsWith("-")) {
      // A mistyped flag must never run the full gate: refuse as a usage
      // error (exit 2) with the usage line, not a gate failure.
      console.error(PRODUCTION_DEPLOY_GATE_USAGE);
      process.exitCode = 2;
    } else {
      const evidence = await checkProductionGate(process.env);
      assertProductionTarget(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
      const approval = evidence.autoApprove
        ? `automated approval (staging ${evidence.staging.map((e) => `${e.workflow} run ${e.runId}`).join(", ")})`
        : "review protection";
      console.log(
        `Production dispatch, enable flag, ${approval}, target and exact-SHA CI checks passed: ${evidence.sha}, full CI run ${evidence.runId}, attempt ${evidence.runAttempt}`,
      );
    }
  } catch (error) {
    // Do not print request/response bodies or credentials on a failed API call.
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
