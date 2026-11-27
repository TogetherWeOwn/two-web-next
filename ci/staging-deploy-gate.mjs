import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readGitHubMetadataJson } from "./github-metadata-json.mjs";

const ciPath = ".github/workflows/ci.yml";
const shaPattern = /^[a-f0-9]{40}$/;
const ciReadTimeoutMs = 10_000;

class CiReadTimeout extends Error {
  constructor(read) {
    super(`CI evidence ${read} read timed out after ${ciReadTimeoutMs} ms`);
  }
}

function requireEvidence(condition, message) {
  if (!condition) throw new Error(message);
}

// workflow_run's github.sha is the default-branch tip, NOT the CI revision.
// https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run
export function deploymentTarget({ eventName, event, repository, ref, sha, checkoutSha }) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""), "Invalid repository");
  requireEvidence(event.repository?.full_name === repository, "Foreign event repository");
  let target;
  if (eventName === "workflow_dispatch") {
    requireEvidence(ref === "refs/heads/main", "Manual staging deploy is main-only");
    target = sha;
  } else if (eventName === "workflow_run") {
    const run = event.workflow_run;
    requireEvidence(
      run?.event === "push" && run.head_branch === "main",
      "Automatic CI must be a main push",
    );
    requireEvidence(run.head_repository?.full_name === repository, "Foreign CI repository");
    requireEvidence(
      run.path === ciPath && run.status === "completed" && run.conclusion === "success",
      "Triggering full CI is not successful",
    );
    target = run.head_sha;
  } else {
    throw new Error("Unsupported staging trigger");
  }
  requireEvidence(shaPattern.test(target ?? ""), "Invalid deployment SHA");
  requireEvidence(checkoutSha === target, "Checkout does not match deployment SHA");
  return target;
}

// Read-only, bounded queries; no polling and no successful-only filter that
// could hide pending/failed runs. Incomplete or multiple evidence fails closed.
// https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
// https://docs.github.com/en/rest/actions/workflow-jobs#list-jobs-for-a-workflow-run
export async function requireSuccessfulCi(
  context,
  { token, fetchImpl = fetch, onTimeoutRetry } = {},
) {
  const target = deploymentTarget(context);
  const triggeringRun =
    context.eventName === "workflow_run" ? context.event.workflow_run : undefined;
  const verify = () =>
    requireSuccessfulMainPushCi(
      { repository: context.repository, sha: target, triggeringRun },
      { token, fetchImpl },
    );
  try {
    return await verify();
  } catch (error) {
    // Only the automatic trigger independently pins the original CI run and attempt.
    if (!triggeringRun || !onTimeoutRetry || !(error instanceof CiReadTimeout)) throw error;
    onTimeoutRetry(error.message);
    // Start at the run list again. No evidence from the timed-out pass can qualify this SHA.
    return verify();
  }
}

// Also used by the trusted manual rollback dispatcher before checking out the
// requested scripts. That caller proves main ancestry separately.
export async function requireSuccessfulMainPushCi(
  { repository, sha: target, triggeringRun },
  { token, fetchImpl = fetch } = {},
) {
  requireEvidence(/^[\w.-]+\/[\w.-]+$/.test(repository ?? ""), "Invalid repository");
  requireEvidence(shaPattern.test(target ?? ""), "Invalid deployment SHA");
  requireEvidence(Boolean(token), "Missing read-only Actions token");
  const base = `https://api.github.com/repos/${repository}/actions`;
  async function get(read, path) {
    const signal = AbortSignal.timeout(ciReadTimeoutMs);
    try {
      const response = await fetchImpl(`${base}${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
        },
        redirect: "error",
        signal,
      });
      requireEvidence(response.ok, `CI evidence request failed (HTTP ${response.status})`);
      return await readGitHubMetadataJson(response.body);
    } catch (error) {
      if (signal.aborted && error === signal.reason) throw new CiReadTimeout(read);
      throw error;
    }
  }
  const query = new URLSearchParams({
    branch: "main",
    event: "push",
    head_sha: target,
    per_page: "100",
  });
  const result = await get("workflow runs", `/workflows/ci.yml/runs?${query}`);
  requireEvidence(
    result.total_count === 1 && result.workflow_runs?.length === 1,
    "Missing or ambiguous exact-SHA CI evidence",
  );
  const run = result.workflow_runs[0];
  function validateRun(candidate) {
    requireEvidence(Number.isSafeInteger(candidate?.id) && candidate.id > 0, "Invalid CI run ID");
    requireEvidence(
      Number.isSafeInteger(candidate.run_attempt) && candidate.run_attempt > 0,
      "Invalid CI attempt",
    );
    requireEvidence(
      candidate.head_sha === target &&
        candidate.head_branch === "main" &&
        candidate.event === "push",
      "CI revision/branch/event mismatch",
    );
    requireEvidence(
      candidate.path === ciPath && candidate.head_repository?.full_name === repository,
      "CI workflow/repository mismatch",
    );
    requireEvidence(
      candidate.status === "completed" && candidate.conclusion === "success",
      "Full CI has not completed successfully",
    );
  }
  validateRun(run);
  if (triggeringRun) {
    requireEvidence(
      run.id === triggeringRun.id && run.run_attempt === triggeringRun.run_attempt,
      "Stale or mismatched CI trigger",
    );
  }
  const evidence = await get("run jobs", `/runs/${run.id}/jobs?filter=latest&per_page=100`);
  requireEvidence(
    Array.isArray(evidence.jobs) && evidence.total_count === evidence.jobs.length,
    "Incomplete CI job evidence",
  );
  for (const name of ["a11y", "check"]) {
    requireEvidence(
      evidence.jobs.filter((job) => job.name === name).length === 1,
      `Missing or ambiguous ${name} job`,
    );
  }
  requireEvidence(
    evidence.jobs.every(
      (job) =>
        job.head_sha === target && job.status === "completed" && job.conclusion === "success",
    ),
    "Full CI jobs are not successful on the deployment SHA",
  );
  // The latest job list can contain a successful job from an earlier attempt.
  // Only attempt 1 can prove its identity without the optional job attempt field.
  requireEvidence(
    evidence.jobs.every(
      (job) =>
        job.run_id === run.id &&
        (job.run_attempt === run.run_attempt ||
          (job.run_attempt === undefined && run.run_attempt === 1)),
    ),
    "CI job run or attempt mismatch",
  );
  // A rerun starting during the query must not reuse a prior attempt's success.
  const current = await get("final run", `/runs/${run.id}`);
  validateRun(current);
  requireEvidence(
    current.id === run.id && current.run_attempt === run.run_attempt,
    "CI changed while checking evidence",
  );
  return { sha: target, runId: run.id, runAttempt: run.run_attempt };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const evidence = await requireSuccessfulCi(
      {
        eventName: process.env.GITHUB_EVENT_NAME,
        event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
        repository: process.env.GITHUB_REPOSITORY,
        ref: process.env.GITHUB_REF,
        sha: process.env.GITHUB_SHA,
        // The job container may not own the host checkout; trust only this path,
        // only for this command (https://git-scm.com/docs/git-config#Documentation/git-config.txt-safedirectory).
        checkoutSha: execFileSync(
          "git",
          ["-c", `safe.directory=${resolve(".")}`, "rev-parse", "HEAD"],
          { encoding: "utf8" },
        ).trim(),
      },
      {
        token: process.env.GITHUB_TOKEN,
        onTimeoutRetry:
          process.argv[2] === "--retry-ci-timeout"
            ? (message) => console.warn(`::warning::${message}. Rechecking exact CI evidence once.`)
            : undefined,
      },
    );
    console.log(
      `Staging gate passed: ${evidence.sha}, full CI run ${evidence.runId}, attempt ${evidence.runAttempt}`,
    );
    if (process.env.GITHUB_OUTPUT) {
      try {
        appendFileSync(
          process.env.GITHUB_OUTPUT,
          `sha=${evidence.sha}\nrun_id=${evidence.runId}\nrun_attempt=${evidence.runAttempt}\n`,
        );
      } catch {
        console.warn("::warning::Could not record verified staging CI provenance");
      }
    }
  } catch (error) {
    console.error(`Staging gate refused: ${error.message}`);
    process.exitCode = 1;
  }
}
