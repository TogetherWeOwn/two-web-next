// Choose the commit deploy-production promotes when no sha input is given:
// the newest commit whose post-deploy staging journeys passed.
//
// deploy.yml and e2e-staging.yml run on workflow_run, so the API head_sha of
// either run is main's tip when it was triggered, not the deployed commit.
// Their run-names carry the deployed SHA instead:
//   deploy.yml      run-name: deploy <ci head_sha>
//   e2e-staging.yml run-name: e2e-staging <deploy run-name>
// so an e2e-staging display_title ends in the commit its journeys exercised.
// The newest post-deploy run for a commit decides it: a later unfinished, failed
// or skipped run is not outvoted by an older pass of the same commit.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { stagingQualityJob, stagingQualitySteps } from "./production-deploy-gate.mjs";

const shaPattern = /^[0-9a-f]{40}$/;
const titleSha = /^e2e-staging deploy ([0-9a-f]{40})$/;

// Automatic promotion safety: a staging green must soak before it can ride
// to production, and a newer red staging run blocks every older candidate.
// Soak window and red conclusions are pinned here so the workflow, the gate
// and the tests share one definition.
export const PROMOTION_SOAK_MS = 30 * 60 * 1000;
const RED_CONCLUSIONS = new Set(["failure", "timed_out"]);

function runCompletedAtMs(run) {
  const stamp = run?.updated_at ?? run?.created_at;
  if (typeof stamp !== "string") return NaN;
  return Date.parse(stamp);
}

function isRedStagingRun(run) {
  return run?.status === "completed" && RED_CONCLUSIONS.has(run?.conclusion);
}

// Run-names (see the workflow headers): the deployed commit is the title's SHA.
export const deployTitle = (sha) => `deploy ${sha}`;
export const e2eTitle = (sha) => `e2e-staging deploy ${sha}`;

export async function resolvePromotionSha({
  repository,
  token,
  fetchImpl = fetch,
  pages = 5,
  nowMs = Date.now(),
}) {
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
    if (!response.ok) throw new Error(`Promotion lookup failed (HTTP ${response.status})`);
    return response.json();
  }
  const decided = new Set();
  // Newest-first: any red run blocks every older candidate, so automatic
  // promotion never rides an older green while staging is currently red.
  let seenNewerRed = false;
  for (let page = 1; page <= pages; page += 1) {
    const query = new URLSearchParams({
      branch: "main",
      event: "workflow_run",
      per_page: "20",
      page: String(page),
    });
    const { workflow_runs: runs = [] } = await get(
      `/actions/workflows/e2e-staging.yml/runs?${query}`,
    );
    if (!runs.length) break;
    for (const run of runs) {
      if (isRedStagingRun(run)) seenNewerRed = true;
      const sha = titleSha.exec(run.display_title ?? "")?.[1];
      if (!sha || decided.has(sha)) continue;
      decided.add(sha);
      if (run.status !== "completed" || run.conclusion !== "success") continue;
      // A newer red staging run blocks this older green: staging is not
      // currently healthy, so there is nothing safe to promote automatically.
      if (seenNewerRed) continue;
      // Soak: the green must be at least 30 minutes old, so a just-passed
      // staging has time to reveal a flake before it rides to production.
      // A missing or unparsable timestamp fails closed (not promotable).
      const completedAt = runCompletedAtMs(run);
      if (!Number.isFinite(completedAt) || nowMs - completedAt < PROMOTION_SOAK_MS) continue;
      const { jobs = [] } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
      // Both gates must have passed on this deploy: journeys and the web quality gate.
      // The quality evidence must match the production gate exactly: one
      // stagingQualityJob whose stagingQualitySteps both executed successfully.
      // A green job with skipped/failed/missing Lighthouse steps is ineligible
      // evidence, like any other valid ineligibility, and falls through to an
      // older eligible SHA (or null) instead of refusing the whole selection.
      const journeysOk = jobs.some(
        (job) =>
          (job.name === "staging-journeys" || job.name.startsWith("staging-journeys / ")) &&
          job.conclusion === "success",
      );
      if (!journeysOk) continue;
      const qualityJobs = jobs.filter((job) => job.name === stagingQualityJob);
      if (qualityJobs.length !== 1) continue;
      const [quality] = qualityJobs;
      if (quality.conclusion !== "success") continue;
      const executed = stagingQualitySteps.every((name) =>
        (quality.steps ?? []).some((step) => step.name === name && step.conclusion === "success"),
      );
      if (!executed) continue;
      return sha;
    }
  }
  return null;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const input = (process.env.INPUT_SHA ?? "").replace(/\s+/g, "").toLowerCase();
    const sha =
      input ||
      (await resolvePromotionSha({
        repository: process.env.GITHUB_REPOSITORY,
        token: process.env.GITHUB_TOKEN,
      }));
    if (!shaPattern.test(sha ?? "")) {
      // Automatic triggers (workflow_run, schedule) run daily even when
      // there is nothing soaked and green to promote: exit cleanly with an
      // empty sha so the workflow skips the deploy instead of going red.
      // A manual dispatch with no candidate is still an error.
      if (!input && process.env.GITHUB_EVENT_NAME !== "workflow_dispatch") {
        console.log(
          "No soaked green staging commit to promote (need a 30-minute-old success with no newer red run); skipping",
        );
        appendFileSync(process.env.GITHUB_OUTPUT, "sha=\n");
        process.exit(0);
      }
      throw new Error(
        "No commit to promote: set the sha input, or wait for a deploy whose staging-journeys and staging-quality pass",
      );
    }
    console.log(
      input
        ? `Deploying the requested commit ${sha}`
        : `Promoting ${sha}: its staging journeys passed`,
    );
    appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
