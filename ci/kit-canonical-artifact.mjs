// Authenticated same-source CI diagnostics, not accepted source-separated D,
// successful-main recovery attestation, custody or environment qualification.
import assert from "node:assert/strict";
import { readGitHubArtifactArchive } from "./github-artifact-archive.mjs";
import { verifyCanonicalExecutionArtifactBytes } from "./kit-canonical-execute.mjs";
import { canonicalCellIdentity } from "./kit-canonical-source.mjs";
import { verifyCanonicalArtifactBytes } from "./kit-upload-rehearsal.mjs";

function verifyCanonicalMetadata(expected, run, artifact) {
  const repository = "TogetherWeOwn/two-web-next";
  for (const value of [run?.id, run?.run_attempt, run?.repository?.id, artifact?.id])
    assert.ok(Number.isSafeInteger(value) && value > 0);
  assert.equal(String(run.id), expected.runId);
  assert.equal(String(run.run_attempt), expected.runAttempt);
  assert.equal(run.repository.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_repository?.id, run.repository.id);
  assert.equal(run.path, ".github/workflows/ci.yml");
  assert.equal(run.head_sha, expected.sourceSha);
  assert.equal(run.head_branch, expected.producerBranch);
  assert.equal(run.event, expected.producerEvent);
  assert.equal(run.status, "completed");
  assert.equal(run.conclusion, "success");
  assert.equal(run.html_url, `https://github.com/${repository}/actions/runs/${expected.runId}`);
  assert.equal(artifact.name, expected.artifactName);
  assert.equal(artifact.expired, false);
  assert.equal(artifact.size_in_bytes, expected.archiveBytes);
  assert.equal(artifact.digest, `sha256:${expected.archiveSha256}`);
  assert.deepEqual(artifact.workflow_run, {
    id: run.id,
    repository_id: run.repository.id,
    head_repository_id: run.repository.id,
    head_branch: expected.producerBranch,
    head_sha: expected.sourceSha,
  });
  return {
    repository,
    workflow: run.path,
    sourceSha: expected.sourceSha,
    runId: expected.runId,
    runAttempt: expected.runAttempt,
    artifactId: String(artifact.id),
    artifactName: artifact.name,
    producerBranch: expected.producerBranch,
    producerEvent: expected.producerEvent,
  };
}

// Authenticate the collector-run archive, never confuse its workflow head with
// the candidate whose bytes it describes. This does not verify either source
// tree, the installed toolchain or actual source separation/execution.
export async function readCanonicalExecutionArtifact(expected, authority, options) {
  try {
    expected = structuredClone(expected);
    authority = structuredClone(authority);
    const identity = canonicalCellIdentity(expected);
    assert.ok(
      typeof expected.producerBranch === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(expected.producerBranch),
    );
    assert.ok(
      expected.producerEvent === "workflow_dispatch" ||
        (expected.producerEvent === "push" && expected.producerBranch === "main"),
    );
    for (const key of [
      "bindingSha256",
      "executionSha256",
      "budgetSha256",
      "journalSha256",
      "receiptSha256",
      "archiveSha256",
    ]) {
      assert.match(expected[key], /^[0-9a-f]{64}$/);
    }
    assert.ok(Number.isSafeInteger(expected.archiveBytes) && expected.archiveBytes > 0);
    assert.equal(
      expected.artifactName,
      `kit-canonical-separated-${identity.candidateSha}-${identity.collectorSha}-${expected.runId}-${expected.runAttempt}`,
    );
    const { archive, provenance } = await readGitHubArtifactArchive(
      { ...expected, sourceSha: identity.collectorSha },
      {
        artifactId: options.artifactId,
        token: options.token,
        fetchImpl: options.fetchImpl,
        verifyMetadata: verifyCanonicalMetadata,
      },
    );
    const verified = verifyCanonicalExecutionArtifactBytes(archive, expected, authority);
    return {
      ...verified,
      evidence: "authenticated-separated-execution-diagnostic",
      provenance,
      authenticatedArchiveVerified: true,
      sourceSeparated: false,
      qualified: false,
    };
  } catch {
    throw new Error("canonical authenticated separated artifact verification failed");
  }
}

export async function readCanonicalArtifact(expected, authority, options) {
  try {
    expected = structuredClone(expected);
    authority = structuredClone(authority);
    assert.ok(
      typeof expected?.producerBranch === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(expected.producerBranch),
    );
    assert.ok(
      expected.producerEvent === "workflow_dispatch" ||
        (expected.producerEvent === "push" && expected.producerBranch === "main"),
    );
    assert.match(expected.sourceSha, /^[0-9a-f]{40}$/);
    assert.match(expected.receiptSha256, /^[0-9a-f]{64}$/);
    assert.match(expected.journalSha256, /^[0-9a-f]{64}$/);
    assert.match(expected.archiveSha256, /^[0-9a-f]{64}$/);
    assert.ok(Number.isSafeInteger(expected.archiveBytes) && expected.archiveBytes > 0);
    assert.equal(
      expected.artifactName,
      `kit-production-bundle-build-${expected.sourceSha}-${expected.runId}-${expected.runAttempt}`,
    );
    const { archive, provenance } = await readGitHubArtifactArchive(expected, {
      artifactId: options.artifactId,
      token: options.token,
      fetchImpl: options.fetchImpl,
      verifyMetadata: verifyCanonicalMetadata,
    });
    const verified = verifyCanonicalArtifactBytes(archive, expected, authority);
    return {
      ...verified,
      evidence: "authenticated-same-source-ci-diagnostic",
      provenance,
      authenticatedArchiveVerified: true,
      sourceSeparated: false,
      qualified: false,
    };
  } catch {
    throw new Error("canonical authenticated artifact verification failed");
  }
}
