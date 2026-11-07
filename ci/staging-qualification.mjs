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
        : qualificationTarget({
            eventName: process.env.GITHUB_EVENT_NAME,
            event: JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, "utf8")),
            repository: process.env.GITHUB_REPOSITORY,
            ref: process.env.GITHUB_REF,
            sha: process.env.GITHUB_SHA,
          });
    await requireQualificationRevision(sha);
    if (process.argv[2] !== "--verify") appendFileSync(process.env.GITHUB_OUTPUT, `sha=${sha}\n`);
    console.log(`Staging qualification revision verified: ${sha}`);
  } catch (error) {
    console.error(`Staging qualification refused: ${error.message}`);
    process.exitCode = 1;
  }
}
