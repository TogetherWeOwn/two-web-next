import { appendFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRevision } from "../bin/revision-check.mjs";

const shaPattern = /^[a-f0-9]{40}$/;

// A deploy workflow_run's API head is main at workflow creation, not the CI
// commit it deployed. deploy.yml publishes that identity as `deploy <sha>`.
export function qualificationTarget({ eventName, event, repository, ref, sha }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || event.repository?.full_name !== repository) {
    throw new Error("Invalid staging qualification repository");
  }
  let target;
  if (eventName === "workflow_dispatch") {
    if (ref !== "refs/heads/main") throw new Error("Manual qualification is main-only");
    target = sha;
  } else if (eventName === "workflow_run") {
    const run = event.workflow_run;
    if (
      !["workflow_run", "workflow_dispatch"].includes(run?.event) ||
      run.head_branch !== "main" ||
      run.head_repository?.full_name !== repository ||
      run.path !== ".github/workflows/deploy.yml" ||
      run.status !== "completed" ||
      run.conclusion !== "success"
    ) {
      throw new Error("Staging qualification requires a successful main deploy");
    }
    target = /^deploy ([a-f0-9]{40})$/.exec(run.display_title ?? "")?.[1];
  } else {
    throw new Error("Unsupported staging qualification trigger");
  }
  if (!shaPattern.test(target ?? "")) throw new Error("Invalid deployed qualification SHA");
  return target;
}

// A successful outer deploy workflow can contain only a skipped deploy job
// (scheduled/manual CI is not an automatic deploy). Ignore that nondeployment
// before checking the live revision, so it cannot poison candidate red history.
export async function qualificationDeployment(context, { token, fetchImpl = fetch } = {}) {
  const sha = qualificationTarget(context);
  if (context.eventName === "workflow_dispatch") return sha;
  const run = context.event.workflow_run;
  if (
    !Number.isSafeInteger(run.id) ||
    run.id <= 0 ||
    !Number.isSafeInteger(run.run_attempt) ||
    run.run_attempt <= 0
  ) {
    throw new Error("Invalid staging deploy run identity");
  }
  const response = await fetchImpl(
    `https://api.github.com/repos/${context.repository}/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
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
  if (!response.ok) throw new Error(`Staging deploy evidence failed (HTTP ${response.status})`);
  const { jobs, total_count: total } = await response.json();
  if (!Array.isArray(jobs) || total !== jobs.length || jobs.length > 100) {
    throw new Error("Incomplete staging deploy job evidence");
  }
  const deployments = jobs.filter((job) => job.name === "deploy-staging");
  if (deployments.length !== 1) throw new Error("Missing or ambiguous staging deploy job evidence");
  const [deployment] = deployments;
  if (deployment.status === "completed" && deployment.conclusion === "skipped") return null;
  const executed = ["Deploy to Cloudflare Workers", "Verify deployed revision"].every((name) => {
    const steps = (deployment.steps ?? []).filter((step) => step.name === name);
    return steps.length === 1 && steps[0].conclusion === "success";
  });
  if (deployment.status !== "completed" || deployment.conclusion !== "success" || !executed) {
    throw new Error("Staging deployment did not execute and pass revision verification");
  }
  return sha;
}

// Both promotion consumers require the final under-lock check. Historical
// greens cannot acquire candidate binding retroactively from the new workflow.
export function hasBoundQualification(jobs) {
  const matches = jobs.filter((job) => job.name === "qualification-revision");
  if (matches.length !== 1 || matches[0].conclusion !== "success") return false;
  const checks = (matches[0].steps ?? []).filter(
    (step) => step.name === "Verify qualification revision",
  );
  return checks.length === 1 && checks[0].conclusion === "success";
}

// The caller holds deploy-staging's concurrency lock throughout every job.
// A replacement that won the lock first must not lend its measurements to A.
export async function requireQualificationRevision(sha, options = {}) {
  if (!shaPattern.test(sha ?? "")) throw new Error("Invalid deployed qualification SHA");
  return verifyRevision("https://next.togetherweown.com", sha, {
    attempts: 1,
    ...options,
  });
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const sha =
      process.argv[2] === "--verify"
        ? process.env.DEPLOYED_SHA
        : await qualificationDeployment(
            {
              eventName: process.env.GITHUB_EVENT_NAME,
              event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
              repository: process.env.GITHUB_REPOSITORY,
              ref: process.env.GITHUB_REF,
              sha: process.env.GITHUB_SHA,
            },
            { token: process.env.GITHUB_TOKEN },
          );
    if (sha === null) {
      appendFileSync(process.env.GITHUB_OUTPUT, "sha=\n");
      console.log("No executed staging deployment; qualification not scheduled");
    } else {
      await requireQualificationRevision(sha);
      if (process.argv[2] !== "--verify") appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
      console.log(`Staging qualification revision verified: ${sha}`);
    }
  } catch (error) {
    console.error(`Staging qualification refused: ${error.message}`);
    process.exitCode = 1;
  }
}
