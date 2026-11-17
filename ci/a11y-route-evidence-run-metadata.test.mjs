import assert from "node:assert/strict";
import { test } from "node:test";
import { assertRouteEvidenceRunMetadata } from "./route-evidence-run-metadata.mjs";

function fixture() {
  const expected = {
    repository: "example/repo",
    workflowId: 12,
    runId: 34,
    runAttempt: 2,
    producerJobId: 56,
    producerJobName: "case-producer",
    sourceSha: "a".repeat(40),
    orchestrationSha: "b".repeat(40),
    pullNumber: 7,
  };
  const run = {
    id: 34,
    run_attempt: 2,
    workflow_id: 12,
    repository: { full_name: "example/repo" },
    head_sha: expected.orchestrationSha,
    event: "pull_request",
    pull_requests: [{ number: 7, head: { sha: expected.sourceSha } }],
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
    },
    liveHead: expected.sourceSha,
  };
}

function check({ expected, run, attempt, job, liveHead }) {
  assertRouteEvidenceRunMetadata(expected, run, attempt, job, liveHead);
}

test("synthetic PR metadata separates merge SHA and tested head", () => {
  assert.doesNotThrow(() => check(fixture()));
  const f = fixture();
  f.run.event = f.attempt.event = "push";
  f.expected.orchestrationSha = f.run.head_sha = f.attempt.head_sha = f.expected.sourceSha;
  assert.doesNotThrow(() => check(f));
});

test("synthetic metadata refuses stale, ambiguous and unsuccessful producers", () => {
  for (const change of [
    (f) => (f.expected.sourceSha = "invalid"),
    (f) => (f.run.head_sha = f.expected.sourceSha),
    (f) => (f.attempt.run_attempt = 1),
    (f) => (f.attempt.repository.full_name = "other/repo"),
    (f) => (f.run.workflow_id = 13),
    (f) => (f.run.pull_requests = []),
    (f) => f.run.pull_requests.push(f.run.pull_requests[0]),
    (f) => (f.run.pull_requests[0].head.sha = "c".repeat(40)),
    (f) => (f.liveHead = "c".repeat(40)),
    (f) => (f.job.run_attempt = 1),
    (f) => (f.job.id = 57),
    (f) => (f.job.name = "other"),
    (f) => (f.job.conclusion = "skipped"),
    (f) => (f.job.status = "in_progress"),
    (f) => (f.run.event = f.attempt.event = "pull_request_target"),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  }
});
