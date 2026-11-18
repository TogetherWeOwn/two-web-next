import { bindRouteEvidencePullRequest } from "./route-evidence-event-binding.mjs";

// Inputs must come from the trusted workflow and GitHub API, not an artifact.
// This check alone does not authenticate producer outputs, report contents,
// or the orchestration SHA; that binding must be established separately.
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function matchesPullRequest(record, expected) {
  const pulls = record.pull_requests;
  return (
    Array.isArray(pulls) &&
    pulls.length === 1 &&
    pulls[0]?.number === expected.pullNumber &&
    pulls[0]?.head?.sha === expected.sourceSha
  );
}

// The caller must collect every page of the attempt-specific jobs API. A single
// matching page cannot establish uniqueness when another page is missing.
export function selectRouteEvidenceProducer(jobs, totalCount, name) {
  const refuse = () => {
    throw new Error("route evidence refused: ambiguous producer metadata");
  };
  if (
    !Array.isArray(jobs) ||
    !Number.isSafeInteger(totalCount) ||
    totalCount < 1 ||
    totalCount > 1000 ||
    jobs.length !== totalCount ||
    typeof name !== "string" ||
    !name ||
    jobs.some((job) => !positive(job?.id)) ||
    new Set(jobs.map((job) => job.id)).size !== jobs.length
  )
    refuse();
  const matches = jobs.filter((job) => job.name === name);
  if (matches.length !== 1) refuse();
  return matches[0];
}

// Optional pullRequest inputs are the trusted runner context and event file,
// plus the independently fetched live PR. Rebind against this exact run.
export function assertRouteEvidenceRunMetadata(expected, run, attempt, job, liveHead, pullRequest) {
  const refuse = () => {
    throw new Error("route evidence refused: inconsistent run metadata");
  };
  if (
    !expected ||
    !run ||
    !attempt ||
    !job ||
    typeof expected.repository !== "string" ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expected.repository) ||
    !positive(expected.workflowId) ||
    !positive(expected.runId) ||
    !positive(expected.runAttempt) ||
    !positive(expected.producerJobId) ||
    typeof expected.producerJobName !== "string" ||
    !expected.producerJobName ||
    !Array.isArray(expected.requiredSteps) ||
    expected.requiredSteps.length === 0 ||
    expected.requiredSteps.some((name) => typeof name !== "string" || !name) ||
    new Set(expected.requiredSteps).size !== expected.requiredSteps.length ||
    !sha(expected.sourceSha) ||
    !sha(expected.orchestrationSha) ||
    !sha(expected.runHeadSha) ||
    (pullRequest === undefined && expected.runHeadSha !== expected.sourceSha)
  )
    refuse();
  if (
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.workflow_id !== expected.workflowId ||
    run.repository?.full_name !== expected.repository ||
    run.head_sha !== expected.runHeadSha ||
    attempt.id !== expected.runId ||
    attempt.run_attempt !== expected.runAttempt ||
    attempt.workflow_id !== expected.workflowId ||
    attempt.repository?.full_name !== expected.repository ||
    attempt.head_sha !== run.head_sha ||
    attempt.event !== run.event ||
    job.id !== expected.producerJobId ||
    job.run_id !== expected.runId ||
    job.run_attempt !== expected.runAttempt ||
    job.name !== expected.producerJobName ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  )
    refuse();
  if (!Array.isArray(job.steps)) refuse();
  for (const name of expected.requiredSteps) {
    const matches = job.steps.filter((step) => step?.name === name);
    if (
      matches.length !== 1 ||
      matches[0].status !== "completed" ||
      matches[0].conclusion !== "success"
    )
      refuse();
  }
  if (run.event === "pull_request") {
    if (
      !positive(expected.pullNumber) ||
      !matchesPullRequest(run, expected) ||
      liveHead !== expected.sourceSha
    )
      refuse();
    if (pullRequest !== undefined) {
      const bound = bindRouteEvidencePullRequest(
        pullRequest?.context,
        pullRequest?.event,
        run,
        pullRequest?.livePull,
      );
      if (
        bound.pullNumber !== expected.pullNumber ||
        bound.sourceSha !== expected.sourceSha ||
        !matchesPullRequest(attempt, expected)
      )
        refuse();
    }
  } else if (run.event === "push" || run.event === "workflow_dispatch") {
    if (pullRequest !== undefined || expected.sourceSha !== expected.orchestrationSha) refuse();
  } else refuse();
}
