// Staging observation chronology, adapted from the inactive incident reporter.
// Read-only: observers retain the original source run/attempt, never the
// observer's chronology, and nothing here writes to any sink.
const RED = new Set(["failure", "timed_out", "cancelled", "action_required"]);

async function jobsFor(api, runId, attempt) {
  const jobs = [];
  for (let page = 1; page <= 5; page++) {
    const result = await api(
      "GET",
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.jobs) || result.jobs.length > 100)
      throw new Error("Malformed release jobs");
    jobs.push(...result.jobs);
    if (result.jobs.length < 100) return jobs;
  }
  throw new Error("Release job history exceeded page cap");
}

const STAGING_GATES = ["staging-quality", "staging-journeys"];
const gateJobs = (jobs, gate) =>
  jobs.filter((job) => job.name === gate || job.name.startsWith(`${gate} / `));
const gateGreen = (selected) =>
  selected.length > 0 && selected.every((job) => job.conclusion === "success");

function stagingObservations(jobs) {
  const keys = new Set();
  for (const gate of STAGING_GATES) {
    const selected = gateJobs(jobs, gate);
    if (selected.some((job) => RED.has(job.conclusion)) || gateGreen(selected)) keys.add(gate);
  }
  if (
    jobs.some((job) => RED.has(job.conclusion)) ||
    STAGING_GATES.every((gate) => gateGreen(gateJobs(jobs, gate)))
  )
    keys.add("e2e-staging");
  return keys;
}

// Observer retries retain the ORIGINAL source run/attempt, not the observer's
// chronology. Read authoritative source history, including successful observations
// that never needed an issue, before any sink write. Skips/pending jobs are not
// observations and must not erase a useful failure from an earlier attempt.
async function staleStagingKeys(api, source, runId, attempt) {
  const positive = (value) => Number.isSafeInteger(value) && value > 0;
  const valid = (run) => positive(run?.id) && positive(run.run_number) && positive(run.run_attempt);
  const trusted = (run) =>
    run?.head_branch === "main" &&
    run.head_repository?.full_name === "TogetherWeOwn/two-web-next" &&
    run.path === ".github/workflows/e2e-staging.yml";
  if (
    !valid(source) ||
    source.id !== Number(runId) ||
    !positive(Number(attempt)) ||
    Number(attempt) > source.run_attempt
  )
    throw new Error("Invalid staging observation identity");
  const newer = new Map();
  let found = false;
  for (let page = 1; page <= 5; page++) {
    const result = await api(
      "GET",
      `/actions/workflows/e2e-staging.yml/runs?branch=main&exclude_pull_requests=true&per_page=100&page=${page}`,
    );
    if (!Array.isArray(result?.workflow_runs) || result.workflow_runs.length > 100)
      throw new Error("Malformed staging observation history");
    for (const run of result.workflow_runs) {
      if (!trusted(run)) continue;
      if (!valid(run)) throw new Error("Malformed staging observation identity");
      if (run.id === source.id) {
        if (run.run_number !== source.run_number || run.run_attempt < Number(attempt))
          throw new Error("Inconsistent staging observation identity");
        found = true;
      }
      if (run.run_number >= source.run_number) {
        if (run.run_number === source.run_number && run.id !== source.id)
          throw new Error("Inconsistent staging observation sequence");
        newer.set(run.id, run);
      }
    }
    if (found || result.workflow_runs.length < 100) break;
  }
  if (!found) throw new Error("Staging observation history missing source or exceeded page cap");
  const stale = new Set();
  let snapshots = 0;
  for (const run of newer.values()) {
    const oldest = run.id === source.id ? Number(attempt) + 1 : 1;
    for (let number = run.run_attempt; number >= oldest; number--) {
      if (number === run.run_attempt && run.status !== "completed") continue;
      if (++snapshots > 20) throw new Error("Staging observation history exceeded attempt cap");
      for (const key of stagingObservations(await jobsFor(api, run.id, number))) stale.add(key);
      if (stale.size === 3) return stale;
    }
  }
  return stale;
}

export { RED, STAGING_GATES, gateJobs, jobsFor, stagingObservations, staleStagingKeys };
