import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assertRouteEvidenceRunMetadata,
  selectRouteEvidenceProducer,
} from "./route-evidence-run-metadata.mjs";

function fixture() {
  const expected = {
    repository: "example/repo",
    workflowId: 12,
    runId: 34,
    runAttempt: 2,
    producerJobId: 56,
    producerJobName: "case-producer",
    requiredSteps: ["Run cases", "Upload report"],
    sourceSha: "a".repeat(40),
    orchestrationSha: "b".repeat(40),
    runHeadSha: "a".repeat(40),
    pullNumber: 7,
  };
  const run = {
    id: 34,
    run_attempt: 2,
    workflow_id: 12,
    repository: { full_name: "example/repo" },
    head_sha: expected.sourceSha,
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
      steps: [
        { name: "Run cases", status: "completed", conclusion: "success" },
        { name: "Upload report", status: "completed", conclusion: "success" },
      ],
    },
    liveHead: expected.sourceSha,
  };
}

function check({ expected, run, attempt, job, liveHead }) {
  assertRouteEvidenceRunMetadata(expected, run, attempt, job, liveHead);
}

test("selects one producer only from a complete attempt job list", () => {
  const { job } = fixture();
  const other = { id: 99, name: "consumer" };
  assert.equal(selectRouteEvidenceProducer([job, other], 2, job.name), job);
  for (const [jobs, count, name] of [
    [[job], 2, job.name],
    [[job, { ...job, id: 57 }], 2, job.name],
    [[job, { ...other, id: job.id }], 2, job.name],
    [[other], 1, job.name],
    [[{ ...job, id: 0 }], 1, job.name],
    [[job], 1001, job.name],
    [[job], 1, ""],
  ]) {
    assert.throws(
      () => selectRouteEvidenceProducer(jobs, count, name),
      /ambiguous producer metadata/,
    );
  }
});

test("synthetic PR metadata separates merge SHA and tested head", () => {
  assert.doesNotThrow(() => check(fixture()));
  const mergeRun = fixture();
  mergeRun.expected.runHeadSha = "c".repeat(40);
  mergeRun.run.head_sha = mergeRun.attempt.head_sha = mergeRun.expected.runHeadSha;
  assert.throws(() => check(mergeRun));
  for (const event of ["push", "workflow_dispatch"]) {
    const f = fixture();
    f.run.event = f.attempt.event = event;
    assert.throws(() => check(f));
    f.expected.orchestrationSha = f.expected.sourceSha;
    assert.doesNotThrow(() => check(f));
    f.expected.runHeadSha = f.run.head_sha = f.attempt.head_sha = "c".repeat(40);
    assert.throws(() => check(f));
  }
});

test("synthetic metadata refuses stale, ambiguous and unsuccessful producers", () => {
  for (const change of [
    (f) => (f.expected.sourceSha = "invalid"),
    (f) => (f.run.head_sha = f.expected.orchestrationSha),
    (f) => (f.run.id = 35),
    (f) => (f.run.run_attempt = 1),
    (f) => (f.run.repository.full_name = "other/repo"),
    (f) => (f.attempt.id = 35),
    (f) => (f.attempt.workflow_id = 13),
    (f) => (f.attempt.head_sha = "c".repeat(40)),
    (f) => (f.attempt.event = "push"),
    (f) => (f.attempt.run_attempt = 1),
    (f) => (f.attempt.repository.full_name = "other/repo"),
    (f) => (f.run.workflow_id = 13),
    (f) => (f.expected.pullNumber = 8),
    (f) => (f.run.pull_requests[0].number = 8),
    (f) => (f.run.pull_requests = []),
    (f) => f.run.pull_requests.push(f.run.pull_requests[0]),
    (f) => (f.run.pull_requests[0].head.sha = "c".repeat(40)),
    (f) => (f.liveHead = "c".repeat(40)),
    (f) => (f.job.run_id = 35),
    (f) => (f.job.run_attempt = 1),
    (f) => (f.job.id = 57),
    (f) => (f.job.name = "other"),
    (f) => (f.job.conclusion = "skipped"),
    (f) => (f.job.status = "in_progress"),
    (f) => (f.expected.requiredSteps = []),
    (f) => (f.expected.requiredSteps = ["Run cases", "Run cases"]),
    (f) => (f.job.steps = []),
    (f) => f.job.steps.push(structuredClone(f.job.steps[0])),
    (f) => (f.job.steps[0].conclusion = "skipped"),
    (f) => (f.job.steps[0].conclusion = "failure"),
    (f) => (f.job.steps[1].status = "in_progress"),
    (f) => (f.run.event = f.attempt.event = "pull_request_target"),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => check(f));
  }
});
