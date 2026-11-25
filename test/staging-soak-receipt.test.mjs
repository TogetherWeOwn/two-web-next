import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import {
  captureStagingSoakReceipt,
  validateStagingSoakReceipt,
} from "../ci/staging-soak-receipt.mjs";

const sha = "a".repeat(40);
const otherSha = "b".repeat(40);
const workerVersion = "11111111-1111-1111-1111-111111111111";
const otherVersion = "22222222-2222-2222-2222-222222222222";
const identity = { sha, deployedAt: "2026-01-01T10:00:00.000Z" };
const revision = { commit: sha, version_id: workerVersion };
const completedAt = "2026-01-01T10:09:00.000Z";
const floorAt = "2026-01-01T10:39:00.000Z";
const byFloor = Date.parse(floorAt);
const evidence = {
  sha,
  deployment: { ...identity, workerVersion, runId: 100, attempt: 1 },
  e2e: {
    runId: 101,
    attempt: 1,
    conclusion: "success",
    completedAt,
    before: identity,
    after: identity,
  },
};
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
  assert.equal(receipt.status, "sampled");
  assert.equal(receipt.floorAt, floorAt);
  assert.deepEqual(receipt.sample, {
    observedAt: floorAt,
    workerVersion,
    requests: 250,
    errors: 2,
  });
  assert.deepEqual(
    validateStagingSoakReceipt(evidence, JSON.parse(JSON.stringify(receipt))),
    receipt,
  );
});

test("a late sample still queries the interval from E2E completion", async () => {
  const observedAt = "2026-01-01T11:00:00.000Z";
  const { queries, options } = mockReads({ nowMs: Date.parse(observedAt) });
  await captureStagingSoakReceipt(evidence, options);
  assert.equal(queries[0].variables.since, completedAt);
  assert.equal(queries[0].variables.until, observedAt);
});

test("refuses early and mismatched deploy or E2E evidence before any reads", async () => {
  const { calls, options } = mockReads({ nowMs: byFloor - 1 });
  await assert.rejects(captureStagingSoakReceipt(evidence, options), /floor has not elapsed/);
  for (const after of [
    undefined,
    { ...identity, sha: otherSha },
    { ...identity, deployedAt: completedAt },
  ]) {
    await assert.rejects(
      captureStagingSoakReceipt({ ...evidence, e2e: { ...evidence.e2e, after } }, options),
    );
  }
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
    { sample: { ...receipt.sample, workerVersion: otherVersion } },
    { sample: { ...receipt.sample, debug: "synthetic-response-body" } },
  ]) {
    assert.throws(() => validateStagingSoakReceipt(evidence, { ...receipt, ...altered }));
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
  assert.equal(JSON.stringify(historical), saved);
});
