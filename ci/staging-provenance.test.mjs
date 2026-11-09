import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { observeStaging, resolveStagingCandidate } from "./staging-provenance.mjs";

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);
const repository = "example/site";
const deployedAt = "2026-11-01T10:00:00.000Z";
const now = Date.parse("2026-11-01T11:00:00.000Z");
const run = {
  conclusion: "success",
  head_branch: "main",
  head_repository: { full_name: repository },
  display_title: `deploy ${A}`,
  head_sha: B,
};
const candidate = (workflow_run = run) =>
  resolveStagingCandidate({ eventName: "workflow_run", event: { workflow_run }, sha: C, repository });
const identity = (body, status = 200) => async () => new Response(JSON.stringify(body), { status });
const observe = (body, options = {}) =>
  observeStaging({ expected: A, now, fetchImpl: identity(body), ...options });

test("candidate A survives deploy metadata B and workflow main tip C", () => {
  assert.equal(candidate(), A);
});

test("a deploy title is mandatory, exact, and lowercase", () => {
  for (const title of [undefined, `deploy ${A} extra`, A, `deploy ${"A".repeat(40)}`, "deploy main"]) {
    assert.throws(() => candidate({ ...run, display_title: title }));
  }
});

test("untrusted, failed, non-main and missing deploy events fail closed", () => {
  for (const change of [
    { conclusion: "failure" },
    { conclusion: undefined },
    { head_branch: "feature" },
    { head_repository: { full_name: "elsewhere/site" } },
    { head_repository: undefined },
  ]) {
    assert.throws(() => candidate({ ...run, ...change }));
  }
  assert.throws(() => candidate(null));
  assert.throws(() => resolveStagingCandidate({ eventName: "push", sha: A, repository }));
});

test("manual qualification uses the exact main dispatch revision, not a deploy title", () => {
  assert.equal(
    resolveStagingCandidate({
      eventName: "workflow_dispatch",
      event: { workflow_run: run },
      sha: C,
      ref: "refs/heads/main",
      repository,
    }),
    C,
  );
  for (const ref of [undefined, "main", "refs/heads/feature", "refs/tags/v1"]) {
    assert.throws(() => resolveStagingCandidate({ eventName: "workflow_dispatch", sha: A, ref }));
  }
  assert.throws(() =>
    resolveStagingCandidate({
      eventName: "workflow_dispatch",
      sha: "main",
      ref: "refs/heads/main",
    }),
  );
});

test("qualification observes the fixed staging endpoint once without redirects or caching", async () => {
  const calls = [];
  const result = await observeStaging({
    expected: A,
    now,
    fetchImpl: async (...args) => {
      calls.push(args);
      return new Response(JSON.stringify({ sha: A, deployedAt, extra: "not retained" }));
    },
  });
  assert.deepEqual(result, { sha: A, deployedAt });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://next.togetherweown.com/version");
  assert.equal(calls[0][1].redirect, "error");
  assert.equal(calls[0][1].headers["cache-control"], "no-cache");
  assert.ok(calls[0][1].signal instanceof AbortSignal);
});

test("missing, malformed, wrong and future identities never qualify", async () => {
  for (const body of [
    null,
    [],
    {},
    { sha: B, deployedAt },
    { sha: C, deployedAt },
    { sha: null, deployedAt },
    { sha: A, deployedAt: null },
    { sha: A, deployedAt: "soon" },
    { sha: A, deployedAt: "2027-01-01T00:00:00.000Z" },
  ]) {
    await assert.rejects(observe(body));
  }
});

test("a replacement during journeys refuses the after observation", async () => {
  const previous = await observe({ sha: A, deployedAt });
  await assert.rejects(observe({ sha: B, deployedAt }, { previous }));
  await assert.rejects(observe({ sha: A, deployedAt: "2026-11-01T10:30:00.000Z" }, { previous }));
  assert.deepEqual(await observe({ sha: A, deployedAt }, { previous }), previous);
});

test("an HTTP error or network failure is never retried into green", async () => {
  for (const status of [302, 404, 500]) {
    await assert.rejects(
      observe({ sha: A, deployedAt }, { fetchImpl: identity({ sha: A, deployedAt }, status) }),
    );
  }
  let calls = 0;
  await assert.rejects(
    observe({}, {
      fetchImpl: async () => {
        calls++;
        throw new Error("offline");
      },
    }),
  );
  assert.equal(calls, 1);
  await assert.rejects(observe({}, { fetchImpl: async () => new Response("not JSON") }));
  await assert.rejects(observe({}, { fetchImpl: async () => new Response("x".repeat(2049)) }));
});

test("the candidate cannot be inferred from a malformed expected SHA", async () => {
  await assert.rejects(observe({ sha: A, deployedAt }, { expected: "main" }));
});

test("qualification pins every checker, validates ancestry and shares the staging deploy mutex", () => {
  const workflow = readFileSync(new URL("../.github/workflows/e2e-staging.yml", import.meta.url), "utf8");
  assert.match(workflow, /run: node ci\/staging-provenance\.mjs candidate/);
  assert.match(workflow, /git merge-base --is-ancestor "\$CANDIDATE_SHA" origin\/main/);
  assert.match(workflow, /ref: \$\{\{ steps\.candidate\.outputs\.sha \}\}/);
  assert.equal((workflow.match(/ref: \$\{\{ needs\.scope\.outputs\.sha \}\}/g) ?? []).length, 2);
  assert.equal((workflow.match(/candidate_sha: \$\{\{ needs\.scope\.outputs\.sha \}\}/g) ?? []).length, 2);
  assert.doesNotMatch(workflow, /workflow_run\.head_sha/);
  assert.match(workflow, /&& 'deploy-staging'/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.doesNotMatch(workflow, /cache: npm|uses: actions\/cache@/);
  assert.equal((workflow.match(/package-manager-cache: false/g) ?? []).length, 2);
  assert.match(workflow, /after passive\/identity passive\/commit/);
  assert.doesNotMatch(workflow, /printf.*passive\/commit/);
  for (const name of ["web-quality-origin", "zap-staging"]) {
    const child = readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
    assert.match(child, /ref: \$\{\{ inputs\.candidate_sha \|\| github\.sha \}\}/);
    assert.match(child, /staging-provenance\.mjs observe.* before /);
    assert.match(child, /staging-provenance\.mjs observe.* after /);
    assert.doesNotMatch(child, /cache: npm|uses: actions\/cache@/);
    assert.match(child, /package-manager-cache: false/);
  }
});
