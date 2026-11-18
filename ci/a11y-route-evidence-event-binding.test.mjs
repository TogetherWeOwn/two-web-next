import assert from "node:assert/strict";
import { test } from "node:test";
import { bindRouteEvidencePullRequest } from "./route-evidence-event-binding.mjs";

function fixture() {
  const sourceSha = "a".repeat(40);
  const mergeSha = "b".repeat(40);
  const repository = "example/repo";
  const pull = {
    number: 7,
    state: "open",
    base: { ref: "main", repo: { full_name: repository } },
    head: { sha: sourceSha },
  };
  return {
    context: { repository, eventName: "pull_request", ref: "refs/pull/7/merge", sha: mergeSha },
    event: {
      number: 7,
      repository: { full_name: repository },
      pull_request: structuredClone(pull),
    },
    run: { event: "pull_request", repository: { full_name: repository }, head_sha: sourceSha },
    livePull: structuredClone(pull),
  };
}

function check(f) {
  return bindRouteEvidencePullRequest(f.context, f.event, f.run, f.livePull);
}

test("synthetic PR binding separates source and merge heads", () => {
  const f = fixture();
  assert.deepEqual(check(f), {
    pullNumber: 7,
    sourceSha: "a".repeat(40),
    runHeadSha: "a".repeat(40),
  });
  f.run.head_sha = f.context.sha;
  assert.equal(check(f).runHeadSha, "b".repeat(40));
});

test("synthetic PR binding refuses stale or mismatched provider metadata", () => {
  for (const change of [
    (f) => (f.context.eventName = "push"),
    (f) => (f.context.ref = "refs/pull/8/merge"),
    (f) => (f.context.sha = "bad"),
    (f) => (f.event.number = 8),
    (f) => (f.event.pull_request.number = 8),
    (f) => (f.event.repository.full_name = "other/repo"),
    (f) => (f.event.pull_request.base.repo.full_name = "other/repo"),
    (f) => (f.event.pull_request.base.ref = "other"),
    (f) => (f.event.pull_request.head.sha = "bad"),
    (f) => (f.run.event = "workflow_dispatch"),
    (f) => (f.run.repository.full_name = "other/repo"),
    (f) => (f.run.head_sha = "c".repeat(40)),
    (f) => (f.livePull.number = 8),
    (f) => (f.livePull.state = "closed"),
    (f) => (f.livePull.base.repo.full_name = "other/repo"),
    (f) => (f.livePull.base.ref = "other"),
    (f) => (f.livePull.head.sha = "c".repeat(40)),
  ]) {
    const f = fixture();
    change(f);
    assert.throws(() => check(f), /inconsistent pull request binding/);
  }
});
