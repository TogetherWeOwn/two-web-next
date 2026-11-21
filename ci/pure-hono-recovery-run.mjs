import { createRouteEvidenceRequest } from "./route-evidence-github.mjs";

const REPOSITORY = "TogetherWeOwn/two-web-next";
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const canonicalId = (value) =>
  typeof value === "string" &&
  value.length <= 16 &&
  positiveId(Number(value)) &&
  String(Number(value)) === value;
const ownRepository = (repo) =>
  repo?.full_name === REPOSITORY && repo.fork === false && positiveId(repo.id);

// The caller pins these expectations independently of the archive and attestation.
// sourceSha is the archive writer's GitHub head_sha, not the promotion candidate.
export async function fetchPureHonoRecoveryRun(expected, token, fetchImpl) {
  const { runId, runAttempt, sourceSha, workflow, event } = expected ?? {};
  if (
    !canonicalId(runId) ||
    !canonicalId(runAttempt) ||
    typeof sourceSha !== "string" ||
    !/^[a-f0-9]{40}$/.test(sourceSha) ||
    typeof workflow !== "string" ||
    !/^\.github\/workflows\/[a-z0-9_-]+\.ya?ml$/.test(workflow) ||
    (event !== "push" && event !== "workflow_dispatch")
  )
    throw new Error("pure Hono recovery run refused: invalid expected producer");

  let run;
  try {
    const request = createRouteEvidenceRequest(REPOSITORY, token, fetchImpl);
    run = await request(`/actions/runs/${runId}/attempts/${runAttempt}`);
  } catch {
    throw new Error("pure Hono recovery run refused: GitHub metadata unavailable");
  }
  // The exact-attempt REST example returns numeric IDs and a path qualified with @main.
  if (
    run?.id !== Number(runId) ||
    run.run_attempt !== Number(runAttempt) ||
    !ownRepository(run.repository) ||
    !ownRepository(run.head_repository) ||
    run.repository.id !== run.head_repository.id ||
    run.head_sha !== sourceSha ||
    run.path !== `${workflow}@main` ||
    run.head_branch !== "main" ||
    run.event !== event ||
    run.status !== "completed" ||
    run.conclusion !== "success"
  )
    throw new Error("pure Hono recovery run refused: inconsistent GitHub attempt metadata");

  return {
    repository: REPOSITORY,
    ref: "refs/heads/main",
    workflow,
    runId,
    runAttempt,
    sourceSha,
    status: run.status,
    conclusion: run.conclusion,
  };
}
