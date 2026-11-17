// Inputs must come from the trusted workflow and GitHub API, not an artifact.
// This check alone does not authenticate producer outputs or report contents.
const sha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

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
    !sha(expected.sourceSha) ||
    !sha(expected.orchestrationSha)
  )
    refuse();
  if (
    run.id !== expected.runId ||
    run.run_attempt !== expected.runAttempt ||
    run.workflow_id !== expected.workflowId ||
    run.repository?.full_name !== expected.repository ||
    run.head_sha !== expected.orchestrationSha ||
    attempt.id !== expected.runId ||
    attempt.run_attempt !== expected.runAttempt ||
    attempt.workflow_id !== expected.workflowId ||
    attempt.repository?.full_name !== expected.repository ||
    attempt.head_sha !== expected.orchestrationSha ||
    attempt.event !== run.event ||
    job.id !== expected.producerJobId ||
    job.run_id !== expected.runId ||
    job.run_attempt !== expected.runAttempt ||
    job.name !== expected.producerJobName ||
    job.status !== "completed" ||
    job.conclusion !== "success"
  )
    refuse();
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
