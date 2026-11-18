// Inputs must come from the trusted workflow and GitHub API, not an artifact.
// This check alone does not authenticate producer outputs, report contents,
// or the orchestration SHA; that binding must be established separately.
// Keep the run head distinct from the workflow-code SHA, but require it to
// match the source until an independently authenticated event binding exists.
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

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

export function assertRouteEvidenceRunMetadata(expected, run, attempt, job, liveHead) {
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
    expected.runHeadSha !== expected.sourceSha
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
      !Array.isArray(run.pull_requests) ||
      run.pull_requests.length !== 1 ||
      run.pull_requests[0]?.number !== expected.pullNumber ||
      run.pull_requests[0]?.head?.sha !== expected.sourceSha ||
      liveHead !== expected.sourceSha
    )
      refuse();
  } else if (run.event === "push" || run.event === "workflow_dispatch") {
    if (expected.sourceSha !== expected.orchestrationSha) refuse();
  } else refuse();
}
