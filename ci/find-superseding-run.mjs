import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MAX_PAGES = 10;
const PAGE_SIZE = 100;

export function isSupersededRun(currentRun, runs) {
  if (!currentRun.hasCancelledDependency) return false;

  return runs.some((run) => {
    const runId = Number(run.id);
    if (!Number.isSafeInteger(runId) || runId <= currentRun.runId || run.event !== "pull_request") {
      return false;
    }

    return (run.pull_requests ?? []).some(
      (pullRequest) =>
        Number(pullRequest.number) === currentRun.pullNumber &&
        pullRequest.head?.sha === currentRun.headSha,
    );
  });
}

export async function findSupersedingRun(context, fetchImpl = fetch) {
  if (!context.hasCancelledDependency) return false;

  if (
    !/^\d+$/.test(context.runId) ||
    !/^\d+$/.test(context.pullNumber) ||
    !/^[0-9a-f]{40}$/i.test(context.headSha) ||
    !/^[^/]+\/[^/]+$/.test(context.repository) ||
    !context.token
  ) {
    throw new Error("Missing or invalid workflow-run context.");
  }

  const runsUrl = new URL(
    `https://api.github.com/repos/${context.repository}/actions/workflows/ci.yml/runs`,
  );
  runsUrl.searchParams.set("event", "pull_request");
  runsUrl.searchParams.set("head_sha", context.headSha);
  runsUrl.searchParams.set("per_page", String(PAGE_SIZE));

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    runsUrl.searchParams.set("page", String(page));
    const response = await fetchImpl(runsUrl, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${context.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!response.ok) throw new Error(`Workflow runs API returned ${response.status}.`);

    const { workflow_runs: runs = [] } = await response.json();
    if (
      isSupersededRun(
        {
          hasCancelledDependency: true,
          runId: Number(context.runId),
          pullNumber: Number(context.pullNumber),
          headSha: context.headSha,
        },
        runs,
      )
    ) {
      return true;
    }
    if (runs.length < PAGE_SIZE) return false;
  }
  return false;
}

async function main() {
  const superseded = await findSupersedingRun({
    hasCancelledDependency: process.env.HAS_CANCELLED_DEPENDENCY === "true",
    runId: process.env.GITHUB_RUN_ID,
    pullNumber: process.env.PR_NUMBER,
    headSha: process.env.HEAD_SHA,
    repository: process.env.GITHUB_REPOSITORY,
    token: process.env.GITHUB_TOKEN,
  });
  process.stdout.write(`superseded=${superseded}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
