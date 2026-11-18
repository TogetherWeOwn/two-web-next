import { selectRouteEvidenceArtifact } from "./route-evidence-artifact-metadata.mjs";
import { bindRouteEvidencePullRequest } from "./route-evidence-event-binding.mjs";
import { fetchRouteEvidenceProducer } from "./route-evidence-jobs.mjs";
import { validateSyntheticRouteReport } from "./route-evidence-synthetic-report.mjs";

// `expected` and the upload outputs must come directly from the immutable
// workflow, not from the report or a candidate-controlled producer. `download`
// must fetch only the authenticated ID, validate its digest and archive, and
// enforce a deadline covering body reads.
export async function admitSyntheticRouteEvidence({
  root,
  context,
  event,
  expected,
  request,
  download,
}) {
  if (
    !expected ||
    !context ||
    expected.repository !== context.repository ||
    expected.producerResult !== "success" ||
    !Number.isSafeInteger(expected.artifactId) ||
    expected.artifactId < 1 ||
    typeof expected.artifactDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.artifactDigest) ||
    typeof request !== "function" ||
    typeof download !== "function"
  )
    throw new Error("route evidence refused: invalid admission configuration");

  const number = event?.number;
  if (!Number.isSafeInteger(number) || number < 1)
    throw new Error("route evidence refused: invalid pull request");

  // Resolve the allowlisted workflow independently; a run's self-reported
  // workflow ID alone does not establish which workflow was invoked.
  const workflow = await request("/actions/workflows/ci.yml");
  if (
    workflow?.path !== ".github/workflows/ci.yml" ||
    !Number.isSafeInteger(workflow.id) ||
    workflow.id < 1
  )
    throw new Error("route evidence refused: inconsistent workflow metadata");
  const run = await request(`/actions/runs/${expected.runId}`);
  const attempt = await request(`/actions/runs/${expected.runId}/attempts/${expected.runAttempt}`);
  const livePull = await request(`/pulls/${number}`);
  const binding = bindRouteEvidencePullRequest(context, event, run, livePull);
  const job = await fetchRouteEvidenceProducer(
    request,
    expected.runId,
    expected.runAttempt,
    expected.producerJobName,
  );
  const artifact = await request(`/actions/artifacts/${expected.artifactId}`);
  const bound = { ...expected, ...binding, workflowId: workflow.id, producerJobId: job.id };
  const artifactId = selectRouteEvidenceArtifact(
    bound,
    run,
    attempt,
    job,
    livePull.head.sha,
    [artifact],
    { context, event, livePull },
  );
  const entries = await download(artifactId, expected.artifactDigest);
  const identities = validateSyntheticRouteReport(root, entries);

  // A head change during download must not admit a now-stale result.
  const currentPull = await request(`/pulls/${number}`);
  bindRouteEvidencePullRequest(context, event, run, currentPull);
  return { kind: "synthetic", sourceSha: binding.sourceSha, identities };
}
