import assert from "node:assert/strict";
import { test } from "node:test";
import { selectRouteEvidenceArtifact } from "./route-evidence-artifact-metadata.mjs";

function fixture() {
  const sourceSha = "a".repeat(40);
  const expected = {
    repository: "example/repo",
    workflowId: 12,
    runId: 34,
    runAttempt: 2,
    producerJobId: 56,
    producerJobName: "case-producer",
    sourceSha,
    orchestrationSha: "b".repeat(40),
    pullNumber: 7,
    artifactId: 78,
    artifactDigest: `sha256:${"c".repeat(64)}`,
  };
  const run = {
    id: 34,
    run_attempt: 2,
    workflow_id: 12,
    repository: { full_name: "example/repo" },
    head_sha: sourceSha,
    event: "pull_request",
    pull_requests: [{ number: 7, head: { sha: sourceSha } }],
  };
  return {
    expected,
    run,
    attempt: structuredClone(run),
    job: {
      id: 56,
      run_id: 34,
      run_attempt: 2,
      name: "case-producer",
      status: "completed",
      conclusion: "success",
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:05:00Z",
    },
    liveHead: sourceSha,
    artifacts: [{
      id: 78,
      name: "route-evidence-34-2",
      digest: expected.artifactDigest,
      expired: false,
      size_in_bytes: 100,
      created_at: "2026-01-01T00:03:00Z",
      workflow_run: { id: 34, head_sha: sourceSha },
    }],
  };
}

function check(f) {
  return selectRouteEvidenceArtifact(f.expected, f.run, f.attempt, f.job, f.liveHead, f.artifacts);
}

test("synthetic artifact metadata binds the producer run and attempt", () => {
  assert.equal(check(fixture()), 78);
});

test("synthetic artifact metadata refuses missing, stale and ambiguous evidence", () => {
  for (const change of [
    (f) => (f.artifacts = []),
    (f) => f.artifacts.push(structuredClone(f.artifacts[0])),
    (f) => (f.expected.artifactId = 0),
    (f) => (f.expected.artifactDigest = "bad"),
    (f) => (f.job.conclusion = "failure"),
    (f) => (f.job.run_attempt = 1),
    (f) => (f.liveHead = "d".repeat(40)),
    (f) => (f.artifacts[0].id = 79),
    (f) => (f.artifacts[0].name = "route-evidence-34-1"),
    (f) => (f.artifacts[0].digest = `sha256:${"d".repeat(64)}`),
    (f) => (f.artifacts[0].expired = true),
    (f) => (f.artifacts[0].size_in_bytes = 0),
    (f) => (f.artifacts[0].size_in_bytes = 10 * 1024 * 1024 + 1),
    (f) => (f.artifacts[0].created_at = "2025-12-31T23:59:59Z"),
    (f) => (f.artifacts[0].created_at = "2026-01-01T00:05:01Z"),
    (f) => (f.artifacts[0].created_at = "invalid"),
    (f) => (f.artifacts[0].workflow_run.id = 35),
    (f) => (f.artifacts[0].workflow_run.head_sha = "d".repeat(40)),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  }
});
