import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { verifyAllocationSoak } from "../ci/production-deploy-gate.mjs";
import {
  failedManual,
  first,
  fresh,
  preRollback,
  restored,
  rollback,
  soakEnv,
  trustedReads,
} from "./fixtures/staging-soak-http.mjs";
import {
  captureStagingSoakReceipt,
  validateStagingSoakReceipt,
} from "../ci/staging-soak-receipt.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { evidence, receipt: expected } = fixture;
const { sha, workerVersion, e2eCompletedAt: completedAt, floorAt } = expected;
const identity = evidence.e2e.before;
const otherSha = "b".repeat(40);
const otherVersion = "22222222-2222-2222-2222-222222222222";
const revision = { commit: sha, version_id: workerVersion };
const byFloor = Date.parse(floorAt);
const graphUrl = "https://api.cloudflare.com/client/v4/graphql";
const tag = (version = workerVersion, requests = 250, errors = 2) => ({
  dimensions: { scriptVersion: version },
  sum: { requests, errors },
});
const graph = (...rows) => ({
  errors: null,
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

function mockReads({
  versions = [identity, identity],
  revisions = [revision, revision],
  analytics = graph(tag()),
  headers = { "x-two-origin": "two-web-next", "cache-control": "no-store" },
  upStatus = 200,
  nowMs = byFloor,
} = {}) {
  const calls = [];
  const queries = [];
  const options = {
    accountId: "c".repeat(32),
    token: "synthetic-analytics-token",
    now: () => nowMs,
    fetchImpl: async (input, init) => {
      const url = String(input);
      calls.push(url);
      if (url === `${STAGING_ORIGIN}/version`) return Response.json(versions.shift());
      if (url === `${STAGING_ORIGIN}/up`) {
        assert.deepEqual(init.headers, { "cache-control": "no-cache" });
        return Response.json({ revision: revisions.shift() }, { status: upStatus, headers });
      }
      assert.equal(url, graphUrl);
      assert.equal(init.method, "POST");
      assert.equal(init.redirect, "error");
      queries.push(JSON.parse(init.body));
      return Response.json(analytics);
    },
  };
  return { calls, queries, options };
}

test("captures bounded post-floor counts for the same version on ordinary staging routing", async () => {
  const { calls, queries, options } = mockReads();
  const receipt = await captureStagingSoakReceipt(evidence, options);
  const stagingReads = [`${STAGING_ORIGIN}/version`, `${STAGING_ORIGIN}/up`];
  assert.deepEqual(calls, [...stagingReads, graphUrl, ...stagingReads]);
  assert.match(queries[0].query, /scriptVersion: \$versionId/);
  assert.deepEqual(queries[0].variables, {
    accountTag: options.accountId,
    scriptName: "two-web-next",
    versionId: workerVersion,
    since: completedAt,
    until: floorAt,
  });
  assert.deepEqual(receipt, expected);
  assert.deepEqual(validateStagingSoakReceipt(evidence, expected, { nowMs: byFloor }), expected);
});

test("a late sample still queries the interval from E2E completion", async () => {
  const observedAt = "2026-01-01T11:00:00.000Z";
  const { queries, options } = mockReads({ nowMs: Date.parse(observedAt) });
  await captureStagingSoakReceipt(evidence, options);
  assert.equal(queries[0].variables.since, completedAt);
  assert.equal(queries[0].variables.until, observedAt);
});

test("refuses early and mismatched deploy or E2E evidence before any reads", async () => {
  const { calls, options } = mockReads();
  await assert.rejects(
    captureStagingSoakReceipt(evidence, { ...options, now: () => byFloor - 1 }),
    /floor has not elapsed/,
  );
  for (const invalid of [
    { attempt: 2 },
    { conclusion: "skipped" },
    { before: undefined },
    { after: undefined },
    { after: { ...identity, sha: otherSha } },
    { after: { ...identity, deployedAt: completedAt } },
  ]) {
    await assert.rejects(
      captureStagingSoakReceipt({ ...evidence, e2e: { ...evidence.e2e, ...invalid } }, options),
    );
  }
  const invalidDate = { ...evidence.e2e, completedAt: "2026-02-30T10:09:00Z" };
  await assert.rejects(
    captureStagingSoakReceipt({ ...evidence, e2e: invalidDate }, options),
    /Invalid staging soak timestamp/,
  );
  assert.deepEqual(calls, []);
});

test("refuses a replacement or unready Worker and missing or untagged analytics", async () => {
  for (const input of [
    { revisions: [{ ...revision, commit: otherSha }] },
    { revisions: [revision, { ...revision, version_id: otherVersion }] },
    { versions: [identity, { ...identity, deployedAt: completedAt }] },
    { upStatus: 503 },
    { headers: { "cache-control": "no-store" } },
    { headers: { "x-two-origin": "two-web-next", "cache-control": "public" } },
    { analytics: graph(tag(otherVersion)) },
    { analytics: graph({ sum: tag().sum }) },
    { analytics: { ...graph(tag()), errors: [{ message: "synthetic-response-body" }] } },
    { analytics: { ...graph(tag()), errors: "synthetic-response-body" } },
    { analytics: graph(tag(workerVersion, 1, 2)) },
    { analytics: graph() },
    { analytics: graph(tag(workerVersion, 0, 0)) },
  ]) {
    await assert.rejects(captureStagingSoakReceipt(evidence, mockReads(input).options), (error) => {
      assert.doesNotMatch(error.message, /synthetic-/);
      return true;
    });
  }
});

test("validates stored receipts against independent pins and rejects partial or altered evidence", async () => {
  const receipt = await captureStagingSoakReceipt(evidence, mockReads().options);
  for (const altered of [
    { sha: otherSha },
    { workerVersion: otherVersion },
    { deployRunId: 102 },
    { e2eRunId: 102 },
    { floorAt: completedAt },
    { sample: undefined },
    { sample: { ...receipt.sample, observedAt: completedAt } },
    { sample: { ...receipt.sample, observedAt: "2026-01-01T10:39:00.001Z" } },
    { sample: { ...receipt.sample, workerVersion: otherVersion } },
    { sample: { ...receipt.sample, debug: "synthetic-response-body" } },
  ]) {
    assert.throws(() =>
      validateStagingSoakReceipt(evidence, { ...receipt, ...altered }, { nowMs: byFloor }),
    );
  }
});

test("records explicit supersession before or after the floor and preserves earlier receipts", async () => {
  const historical = await captureStagingSoakReceipt(evidence, mockReads().options);
  const saved = JSON.stringify(historical);
  for (const observedAt of [completedAt, "2026-01-01T10:42:00.000Z"]) {
    const replacement = { sha, workerVersion: otherVersion, observedAt };
    const known = { ...evidence, replacement };
    const { calls, options } = mockReads({ nowMs: Date.parse(observedAt) });
    const receipt = await captureStagingSoakReceipt(known, options);
    assert.deepEqual(calls, []);
    assert.equal(receipt.status, "superseded");
    assert.deepEqual(receipt.replacement, replacement);
    assert.equal(receipt.sample, undefined);
    assert.deepEqual(validateStagingSoakReceipt(known, receipt), receipt);
    assert.throws(() => validateStagingSoakReceipt(known, historical), /receipt mismatch/);
  }
  const sameVersion = { sha, workerVersion, observedAt: floorAt };
  await assert.rejects(
    captureStagingSoakReceipt({ ...evidence, replacement: sameVersion }, mockReads().options),
    /Invalid staging supersession/,
  );
  assert.equal(JSON.stringify(historical), saved);
});

test("a restored Worker needs continuous soak and fresh E2E for its new allocation", async () => {
  let deployments = () => [first];
  const sample = ({
    run = preRollback,
    nowMs = byFloor,
    analytics,
    skipped,
    manual = false,
  } = {}) => {
    const { queries, options } = mockReads({ nowMs, analytics });
    const env = {
      ...soakEnv(options),
      ...(manual && { GITHUB_EVENT_NAME: "workflow_dispatch", INPUT_SHA: sha }),
    };
    return {
      queries,
      result: verifyAllocationSoak(env, {
        now: options.now,
        fetchImpl: trustedReads(options, { deployments, run, skipped }),
      }),
    };
  };
  const historical = await sample().result;
  assert.equal(historical.allocationId, first.id);
  assert.deepEqual(historical.sample, expected.sample);
  const saved = JSON.stringify(historical);
  await assert.rejects(sample({ run: failedManual }).result, /failed or was re-run/);
  let reads = 0;
  deployments = () => (reads++ === 0 ? [first] : [rollback, restored, first]);
  const during = sample();
  await assert.rejects(during.result, /allocation changed during sampling/);
  assert.equal(during.queries.length, 1);
  deployments = () => [rollback, restored, first];
  const stale = sample({ nowMs: Date.parse("2026-01-01T10:44:00Z") });
  await assert.rejects(stale.result, /fresh E2E is required/);
  assert.deepEqual(stale.queries, []);
  assert.equal(JSON.stringify(historical), saved);
  assert.deepEqual(validateStagingSoakReceipt(evidence, expected, { nowMs: byFloor }), expected);

  const floor = Date.parse("2026-01-01T11:20:00Z");
  const manual = { run: fresh, manual: true };
  await assert.rejects(sample({ ...manual, nowMs: floor - 1 }).result, /has not soaked 30 minutes/);
  await assert.rejects(
    sample({ ...manual, nowMs: floor, skipped: true }).result,
    /Missing executed staging-journeys/,
  );
  await assert.rejects(sample({ run: fresh, nowMs: floor }).result, /fresh E2E is required/);
  const ready = sample({ ...manual, nowMs: floor, analytics: graph() });
  const receipt = await ready.result;
  assert.equal(receipt.allocationId, restored.id);
  assert.equal(receipt.workerVersion, workerVersion);
  assert.equal(receipt.e2e.runId, fresh.id);
  assert.equal(receipt.sample.requests, 0);
  assert.equal(receipt.sample.errors, 0);
  assert.equal(ready.queries[0].variables.since, "2026-01-01T10:50:00.000Z");
});
