// Choose the commit deploy-production promotes when no sha input is given:
// the newest commit whose post-deploy staging journeys passed.
//
// deploy.yml and e2e-staging.yml run on workflow_run, so the API head_sha of
// either run is main's tip when it was triggered, not the deployed commit.
// Their run-names carry the deployed SHA instead:
//   deploy.yml      run-name: deploy <ci head_sha>
//   e2e-staging.yml run-name: e2e-staging <deploy run-name>
// so an e2e-staging display_title ends in the commit its journeys exercised.
// The newest post-deploy run for a commit decides it: a later failed or
// skipped run is not outvoted by an older pass of the same commit.
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const shaPattern = /^[0-9a-f]{40}$/;
const titleSha = /\b([0-9a-f]{40})$/;

export async function resolvePromotionSha({ repository, token, fetchImpl = fetch, pages = 5 }) {
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
      const sha = titleSha.exec(run.display_title ?? "")?.[1];
      if (!sha || decided.has(sha)) continue;
      if (run.status !== "completed") continue; // still verifying; an older verdict may decide
      decided.add(sha);
      if (run.conclusion !== "success") continue;
      const { jobs = [] } = await get(`/actions/runs/${run.id}/jobs?per_page=100`);
      if (jobs.find((job) => job.name === "staging-journeys")?.conclusion === "success") return sha;
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
      throw new Error(
        "No commit to promote: set the sha input, or wait for a deploy whose staging-journeys pass",
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
