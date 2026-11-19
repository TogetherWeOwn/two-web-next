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
    requiredSteps: ["Run cases", "Upload report"],
    sourceSha,
    orchestrationSha: "b".repeat(40),
    runHeadSha: sourceSha,
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
      steps: [
        { name: "Run cases", status: "completed", conclusion: "success" },
        { name: "Upload report", status: "completed", conclusion: "success" },
      ],
      started_at: "2026-01-01T00:00:00Z",
      completed_at: "2026-01-01T00:05:00Z",
    },
    liveHead: sourceSha,
    artifacts: [
      {
        id: 78,
        name: "route-evidence-34-2",
        digest: expected.artifactDigest,
        expired: false,
        size_in_bytes: 100,
        created_at: "2026-01-01T00:03:00Z",
        workflow_run: { id: 34, head_sha: sourceSha },
      },
    ],
  };
}

const mergeSha = "d".repeat(40);

function boundFixture(runHeadSha = mergeSha) {
  const f = fixture();
  const { repository, pullNumber, sourceSha } = f.expected;
  const repo = { full_name: repository };
  const pull = { number: pullNumber, head: { sha: sourceSha }, base: { repo, ref: "main" } };
  f.pullRequest = {
    context: {
      eventName: "pull_request",
      repository,
      ref: `refs/pull/${pullNumber}/merge`,
      sha: mergeSha,
    },
    event: { number: pullNumber, repository: repo, pull_request: structuredClone(pull) },
    livePull: { ...pull, state: "open" },
  };
  f.expected.runHeadSha = runHeadSha;
  f.run.head_sha = f.attempt.head_sha = f.artifacts[0].workflow_run.head_sha = runHeadSha;
  return f;
}

function check(f) {
  return selectRouteEvidenceArtifact(
    f.expected,
    f.run,
    f.attempt,
    f.job,
    f.liveHead,
    f.artifacts,
    f.pullRequest,
  );
}

test("synthetic artifact metadata binds the producer run and attempt", () => {
  assert.equal(check(fixture()), 78);
});

test("synthetic bound PR artifacts accept either provider head without changing the tested source", () => {
  assert.equal(check(boundFixture()), 78);
  assert.equal(check(boundFixture(fixture().expected.sourceSha)), 78);
});

test("synthetic bound PR metadata refuses a provider head unrelated to the event", () => {
  assert.throws(() => check(boundFixture("e".repeat(40))), /inconsistent pull request binding/);
});

test("synthetic bound PR metadata refuses another PR even at the same source", () => {
  const f = boundFixture();
  const { context, event, livePull } = f.pullRequest;
  context.ref = "refs/pull/8/merge";
  event.number = event.pull_request.number = livePull.number = 8;
  assert.throws(() => check(f), /inconsistent run metadata/);
});

test("synthetic bound PR metadata refuses missing or conflicting provenance", () => {
  for (const [change, error] of [
    [(f) => delete f.pullRequest, /inconsistent run metadata/],
    [(f) => delete f.pullRequest.livePull, /inconsistent pull request binding/],
    [(f) => (f.pullRequest.livePull.head.sha = mergeSha), /inconsistent pull request binding/],
    [
      (f) => (f.pullRequest.context.sha = f.expected.orchestrationSha),
      /inconsistent pull request binding/,
    ],
    [(f) => (f.run.pull_requests = []), /inconsistent run metadata/],
    [(f) => (f.liveHead = mergeSha), /inconsistent run metadata/],
    [(f) => (f.attempt.head_sha = f.expected.sourceSha), /inconsistent run metadata/],
    [(f) => (f.attempt.pull_requests[0].number += 1), /inconsistent run metadata/],
    [(f) => delete f.attempt.pull_requests, /inconsistent run metadata/],
    [
      (f) => (f.artifacts[0].workflow_run.head_sha = f.expected.sourceSha),
      /inconsistent artifact metadata/,
    ],
  ]) {
    const f = boundFixture();
    change(f);
    assert.throws(() => check(f), error);
  }
});

test("synthetic metadata does not fall back when a PR binding is supplied but invalid", () => {
  const f = boundFixture(fixture().expected.sourceSha);
  f.pullRequest = null;
  assert.throws(() => check(f), /inconsistent pull request binding/);
});

test("synthetic push and dispatch metadata do not accept PR binding inputs", () => {
  for (const event of ["push", "workflow_dispatch"]) {
    const f = boundFixture(fixture().expected.sourceSha);
    f.run.event = f.attempt.event = event;
    f.expected.orchestrationSha = f.expected.sourceSha;
    assert.throws(() => check(f), /inconsistent run metadata/);
  }
});

test("synthetic artifact metadata refuses a merge run without independent binding", () => {
  const f = fixture();
  const mergeSha = "d".repeat(40);
  f.expected.runHeadSha = mergeSha;
  f.run.head_sha = f.attempt.head_sha = f.artifacts[0].workflow_run.head_sha = mergeSha;
  assert.throws(() => check(f));
  f.liveHead = mergeSha;
  assert.throws(() => check(f));
});

test("synthetic artifact metadata accepts the maximum artifact size", () => {
  const f = fixture();
  f.artifacts[0].size_in_bytes = 10 * 1024 * 1024;
  assert.equal(check(f), 78);
});

test("synthetic artifact metadata accepts creation at producer start", () => {
  const f = fixture();
  f.artifacts[0].created_at = f.job.started_at;
  assert.equal(check(f), 78);
});

test("synthetic artifact metadata accepts creation at producer completion", () => {
  const f = fixture();
  f.artifacts[0].created_at = f.job.completed_at;
  assert.equal(check(f), 78);
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
