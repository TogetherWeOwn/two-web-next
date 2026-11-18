import { assertRouteEvidenceRunMetadata } from "./route-evidence-run-metadata.mjs";

// All arguments are trusted workflow outputs or GitHub API responses, never
// values taken from the artifact. This is not an artifact download or admission.
// Artifact metadata and timestamps alone do not authenticate its upload job or attempt.
export function selectRouteEvidenceArtifact(expected, run, attempt, job, liveHead, artifacts) {
  const refuse = () => {
    throw new Error("route evidence refused: inconsistent artifact metadata");
  };
  assertRouteEvidenceRunMetadata(expected, run, attempt, job, liveHead);
  if (
    !Number.isSafeInteger(expected.artifactId) ||
    expected.artifactId <= 0 ||
    typeof expected.artifactDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(expected.artifactDigest) ||
    !Array.isArray(artifacts) ||
    artifacts.length !== 1
  )
    refuse();
  const artifact = artifacts[0];
  const name = `route-evidence-${expected.runId}-${expected.runAttempt}`;
  const started = Date.parse(job.started_at);
  const completed = Date.parse(job.completed_at);
  const created = Date.parse(artifact?.created_at);
  if (
    !Number.isFinite(started) ||
    !Number.isFinite(completed) ||
    !Number.isFinite(created) ||
    started > created ||
    created > completed ||
    artifact.id !== expected.artifactId ||
    artifact.name !== name ||
    artifact.digest !== expected.artifactDigest ||
    artifact.expired !== false ||
    !Number.isSafeInteger(artifact.size_in_bytes) ||
    artifact.size_in_bytes <= 0 ||
    artifact.size_in_bytes > 10 * 1024 * 1024 ||
    artifact.workflow_run?.id !== expected.runId ||
    artifact.workflow_run?.head_sha !== run.head_sha
  )
    refuse();
  return artifact.id;
}
