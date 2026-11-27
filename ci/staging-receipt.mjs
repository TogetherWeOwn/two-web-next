import {
  appendFileSync,
  copyFileSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readUpJson } from "../bin/revision-check.mjs";
import { PROMOTION_SOAK_MS } from "./resolve-promotion-sha.mjs";
import {
  isSha,
  readStagingIdentity,
  resolveStagingCandidate,
  STAGING_ORIGIN,
} from "./staging-provenance.mjs";

const workerId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const UP_READY = "ready (HTTP 200)";
const sha = (value) => (isSha(value) ? `\`${value}\`` : "unavailable");
const positiveId = (value) =>
  (typeof value === "number" || typeof value === "string") && /^[1-9][0-9]{0,15}$/.test(value);

function runLink(repository, id, attempt) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !positiveId(id) || !positiveId(attempt)) {
    return "unavailable";
  }
  return `[${id}, attempt ${attempt}](https://github.com/${repository}/actions/runs/${id}/attempts/${attempt})`;
}

function upReadiness(status, body) {
  const { db, pending_migrations: pending, config, status: health } = body ?? {};
  // /up allows queue-only degradation without failing database or config readiness.
  const ready = db === "ok" && pending === 0 && config === undefined;
  if (status === 200 && ready && (health === "healthy" || health === "degraded")) {
    return UP_READY;
  }

  const pendingCount = Number.isSafeInteger(pending) && pending >= 0;
  const validDatabase =
    db === "ok" ? pendingCount || pending === null : db === "error" && pending === null;
  const validConfig = config === undefined || config === "missing" || config === "weak";
  if (status === 503 && !ready && health === "degraded" && validDatabase && validConfig) {
    return pending > 0 ? "unready (HTTP 503, pending migrations)" : "unready (HTTP 503)";
  }

  return `unproven (inconsistent or invalid HTTP ${status} response)`;
}

async function readStagingUp(fetchImpl) {
  const response = await fetchImpl(new URL("/up", STAGING_ORIGIN), {
    redirect: "error",
    headers: { "cache-control": "no-cache" },
    signal: AbortSignal.timeout(10_000),
  });
  const { status } = response;
  if (status !== 200 && status !== 503) {
    // The revision reader never receives this body. Cancel it without delaying refusal.
    void response.body?.cancel().catch(() => undefined);
    throw new Error("Unexpected /up response status");
  }
  const body = await readUpJson(response);
  return { revision: body?.revision, readiness: upReadiness(status, body) };
}

export async function stagingReceipt(
  mode,
  env,
  event,
  { fetchImpl = fetch, now = Date.now() } = {},
) {
  const e2e = mode === "e2e";
  const repo = env.GITHUB_REPOSITORY;
  const trigger = event?.workflow_run;
  const currentRun = runLink(repo, env.GITHUB_RUN_ID, env.GITHUB_RUN_ATTEMPT);
  let candidate = env.STAGING_CANDIDATE;
  if (e2e) {
    try {
      if (
        candidate !==
        resolveStagingCandidate({
          eventName: env.GITHUB_EVENT_NAME,
          event,
          sha: env.GITHUB_SHA,
          ref: env.GITHUB_REF,
          repository: repo,
        })
      ) {
        candidate = undefined;
      }
    } catch {
      candidate = undefined;
    }
  }

  const shouldObserve =
    isSha(candidate) &&
    (e2e ? env.STAGING_JOB_STATUS : env.STAGING_WEB_DEPLOY_OUTCOME) === "success";
  let up;
  let version;
  if (shouldObserve) {
    [up, version] = await Promise.all([
      readStagingUp(fetchImpl).catch(() => null),
      readStagingIdentity({ fetchImpl, now }).catch(() => null),
    ]);
  }
  const revision = up?.revision;
  const readiness =
    up?.readiness ??
    (shouldObserve ? "unproven (missing or unreadable response)" : "unproven (no observation)");
  const versionId =
    typeof revision?.version_id === "string" &&
    revision.version_id.length === 36 &&
    workerId.test(revision.version_id)
      ? revision.version_id
      : null;
  const matched = versionId && version?.sha === candidate && revision.commit === candidate;
  const identityVerdict = matched
    ? "matched at observation"
    : shouldObserve
      ? "refused (disagreement or missing proof)"
      : "refused (no observation)";
  let soak;
  if (e2e && env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    soak = "This manual E2E run is ineligible for automatic promotion";
  } else if (e2e && env.GITHUB_RUN_ATTEMPT !== "1") {
    soak = "This E2E rerun disqualifies the commit and blocks candidates with older runs";
  } else if (e2e && env.STAGING_SKIP_E2E === "true") {
    soak = "This E2E run is ineligible (journeys scope-skipped)";
  } else if (!e2e && env.STAGING_JOB_STATUS !== "success") {
    soak =
      env.STAGING_JOB_STATUS === "failure"
        ? "This deploy run is ineligible (deploy job failed)"
        : "This deploy run is ineligible (deploy job did not succeed)";
  } else if (!matched) {
    soak = "Unproven (identity receipt refused)";
  } else if (readiness !== UP_READY) {
    soak = "Unproven (/up readiness not established)";
  } else if (e2e) {
    soak = `Pending successful qualification and ${PROMOTION_SOAK_MS / 60_000}-minute soak. Production checks run history separately.`;
  } else {
    soak = "Pending a qualifying staging E2E run";
  }

  const deployRun = runLink(repo, trigger?.id, trigger?.run_attempt);
  const ciRun = runLink(repo, env.STAGING_CI_RUN_ID, env.STAGING_CI_RUN_ATTEMPT);
  const provenance = e2e
    ? env.GITHUB_EVENT_NAME === "workflow_dispatch"
      ? "Manual dispatch has no triggering deploy or verified CI attempt in this run"
      : `Triggering deploy run ${deployRun}, workflow head ${sha(trigger?.head_sha)}. The linked deploy summary records the verified CI attempt when available.`
    : `Verified full CI run ${ciRun}, source ${sha(candidate)}`;
  return [
    "## Staging evidence",
    "",
    `- ${e2e ? "Staging E2E" : "Staging deploy"} run ${currentRun}`,
    `- Workflow trigger SHA (run head) ${sha(env.GITHUB_SHA)}`,
    `- ${provenance}`,
    `- Candidate source ${sha(candidate)}`,
    `- Live /up source ${sha(revision?.commit)}, Worker version ${versionId ? `\`${versionId}\`` : "unavailable"}`,
    `- Live /up readiness ${readiness}`,
    `- Live /version source ${sha(version?.sha)}${version ? `, deployed at \`${version.deployedAt}\`` : ""}`,
    `- Identity receipt ${identityVerdict}`,
    `- **Soak eligibility** ${soak}`,
    "",
  ].join("\n");
}

function appendStepSummary(path, receipt) {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  const target = entry?.isSymbolicLink() ? realpathSync(path) : path;
  if (entry && !statSync(target).isFile()) throw new Error("Invalid staging summary file");

  // GitHub gives each step its own summary file. Publish the append only after
  // the complete receipt is on disk, even if the write fails partway through.
  const directory = mkdtempSync(join(dirname(target), ".staging-receipt-"));
  try {
    const pending = join(directory, "summary.md");
    if (entry) copyFileSync(target, pending);
    appendFileSync(pending, receipt);
    renameSync(pending, target);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const mode = process.argv[2];
    if (mode !== "deploy" && mode !== "e2e") throw new Error("Invalid staging receipt mode");
    const env = process.env;
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    appendStepSummary(env.GITHUB_STEP_SUMMARY, await stagingReceipt(mode, env, event));
  } catch {
    console.warn("::warning::Staging evidence summary unavailable");
    process.exitCode = 1;
  }
}
