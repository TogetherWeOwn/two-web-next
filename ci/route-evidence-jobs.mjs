import { selectRouteEvidenceProducer } from "./route-evidence-run-metadata.mjs";

// The caller supplies the authenticated GitHub API request function. Never use
// an artifact-provided URL or a PR-controlled API endpoint for these requests.
export async function fetchRouteEvidenceProducer(request, runId, attempt, producerName) {
  const refuse = () => {
    throw new Error("route evidence refused: incomplete attempt jobs");
  };
  if (
    typeof request !== "function" ||
    !Number.isSafeInteger(runId) ||
    runId < 1 ||
    !Number.isSafeInteger(attempt) ||
    attempt < 1
  )
    refuse();

  const jobs = [];
  let total;
  for (let page = 1; page <= 10; page++) {
    const result = await request(
      `/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100&page=${page}`,
    );
    if (
      !result ||
      !Number.isSafeInteger(result.total_count) ||
      result.total_count < 1 ||
      result.total_count > 1000 ||
      !Array.isArray(result.jobs) ||
      result.jobs.length > 100 ||
      (total !== undefined && result.total_count !== total)
    )
      refuse();
    total = result.total_count;
    const remaining = total - jobs.length;
    if (result.jobs.length !== Math.min(100, remaining)) refuse();
    jobs.push(...result.jobs);
    if (jobs.length === total) return selectRouteEvidenceProducer(jobs, total, producerName);
  }
  return refuse();
}
