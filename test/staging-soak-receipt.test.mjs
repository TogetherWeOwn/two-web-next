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
const evidence = {
  sha,
  deployment: { ...identity, workerVersion, runId: 100, attempt: 1 },
  e2e: {
    runId: 101,
    attempt: 1,
    conclusion: "success",
    completedAt: "2026-01-01T10:09:00Z",
    before: identity,
    after: identity,
  },
};
const floorAt = "2026-01-01T10:39:00.000Z";
const byFloor = Date.parse(floorAt);
const tag = (version = workerVersion, requests = 250, errors = 2) => ({
  dimensions: { scriptVersion: version },
  sum: { requests, errors },
});
const graph = (...rows) => ({
  data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
});

function mockReads({
  versions = [identity, identity],
  revisions = [
    { commit: sha, version_id: workerVersion },
    { commit: sha, version_id: workerVersion },
  ],
  analytics = graph(tag()),
  upStatus = 200,
  nowMs = byFloor,
} = {}) {
  const calls = [];
  const queries = [];
  return {
    calls,
    queries,
    options: {
      accountId: "c".repeat(32),
      token: "synthetic-analytics-token",
      now: () => nowMs,
      fetchImpl: async (input, init) => {
        const url = String(input);
        calls.push(url);
        if (url === `${STAGING_ORIGIN}/version`) {
          assert.equal(init.redirect, "error");
          return Response.json(versions.shift());
        }
        if (url === `${STAGING_ORIGIN}/up`) {
          assert.deepEqual(init.headers, { "cache-control": "no-cache" });
          return Response.json(
            { revision: revisions.shift(), unrelated: "synthetic-origin-body" },
            {
              status: upStatus,
              headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" },
            },
          );
        }
        assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
        assert.equal(init.method, "POST");
        assert.equal(init.redirect, "error");
        queries.push(JSON.parse(init.body));
        return Response.json(analytics);
      },
    },
  };
}

test("captures bounded post-floor counts for the same version on ordinary staging routing", async () => {
  const { calls, queries, options } = mockReads();
  const receipt = await captureStagingSoakReceipt(evidence, options);
  assert.deepEqual(calls, [
    `${STAGING_ORIGIN}/version`,
    `${STAGING_ORIGIN}/up`,
    "https://api.cloudflare.com/client/v4/graphql",
    `${STAGING_ORIGIN}/version`,
    `${STAGING_ORIGIN}/up`,
  ]);
  assert.deepEqual(queries[0].variables, {
    accountTag: options.accountId,
    scriptName: "two-web-next",
    versionId: workerVersion,
    since: "2026-01-01T10:09:00.000Z",
    until: floorAt,
  });
  assert.match(queries[0].query, /scriptVersion: \$versionId/);
  assert.deepEqual(receipt, {
    schema: "staging-soak/1",
    status: "sampled",
    ...identity,
    workerVersion,
    deployRunId: 100,
    deployAttempt: 1,
    e2eRunId: 101,
    e2eAttempt: 1,
    e2eCompletedAt: "2026-01-01T10:09:00.000Z",
    floorAt,
    sample: { observedAt: floorAt, workerVersion, requests: 250, errors: 2 },
  });
  assert.deepEqual(
    validateStagingSoakReceipt(evidence, JSON.parse(JSON.stringify(receipt)), {
      nowMs: byFloor,
    }),
    receipt,
  );
});

test("refuses early and mismatched deploy or E2E evidence before any reads", async () => {
  const { calls, options } = mockReads({ nowMs: byFloor - 1 });
  await assert.rejects(captureStagingSoakReceipt(evidence, options), /floor has not elapsed/);
  for (const invalid of [
    { sha: otherSha },
    { deployment: { ...evidence.deployment, deployedAt: "2026-01-01T10:01:00.000Z" } },
    { e2e: { ...evidence.e2e, after: { ...identity, sha: otherSha } } },
    { e2e: { ...evidence.e2e, before: undefined } },
    { e2e: { ...evidence.e2e, completedAt: "2026-02-30T10:09:00Z" } },
    { e2e: { ...evidence.e2e, attempt: 2 } },
    { e2e: { ...evidence.e2e, conclusion: "skipped" } },
  ]) {
    await assert.rejects(captureStagingSoakReceipt({ ...evidence, ...invalid }, options));
  }
  assert.deepEqual(calls, []);
});

test("a late sample still queries the interval from E2E completion", async () => {
  const observedAt = "2026-01-01T11:00:00.000Z";
  const { queries, options } = mockReads({ nowMs: Date.parse(observedAt) });
  const receipt = await captureStagingSoakReceipt(evidence, options);
  assert.equal(queries[0].variables.since, receipt.e2eCompletedAt);
  assert.equal(queries[0].variables.until, observedAt);
});

test("refuses a replacement or unready Worker and missing or untagged analytics", async () => {
  for (const badReads of [
    { revisions: [{ commit: otherSha, version_id: workerVersion }] },
    { revisions: [{ commit: sha, version_id: otherVersion }] },
    {
      revisions: [
        { commit: sha, version_id: workerVersion },
        { commit: sha, version_id: otherVersion },
      ],
    },
    { versions: [identity, { ...identity, sha: otherSha }] },
    { versions: [identity, { ...identity, deployedAt: "2026-01-01T10:01:00.000Z" }] },
    { upStatus: 503 },
    { analytics: graph(tag(otherVersion)) },
    { analytics: graph({ sum: { requests: 250, errors: 0 } }) },
    { analytics: { ...graph(tag()), errors: [{ message: "synthetic-origin-body" }] } },
    { analytics: { ...graph(tag()), errors: "malformed" } },
    { analytics: graph(tag(workerVersion, 1, 2)) },
    { analytics: graph() },
    { analytics: graph(tag(workerVersion, 0, 0)) },
  ]) {
    const { options } = mockReads(badReads);
    await assert.rejects(captureStagingSoakReceipt(evidence, options), (error) => {
      assert.doesNotMatch(error.message, /synthetic-/);
      return true;
    });
  }
});

test("validates stored receipts against independent pins and rejects partial or altered evidence", async () => {
  const { options } = mockReads();
  const receipt = await captureStagingSoakReceipt(evidence, options);
  for (const altered of [
    { sha: otherSha },
    { workerVersion: otherVersion },
    { deployRunId: 102 },
    { e2eRunId: 102 },
    { floorAt: "2026-01-01T10:10:00.000Z" },
    { sample: { ...receipt.sample, observedAt: "2026-01-01T10:38:59.999Z" } },
    { sample: { ...receipt.sample, observedAt: "2026-01-01T10:39:00.001Z" } },
    { sample: { ...receipt.sample, workerVersion: otherVersion } },
    { sample: { ...receipt.sample, requests: 0, errors: 0 } },
    { sample: { ...receipt.sample, debug: "synthetic-origin-body" } },
    { sample: undefined },
  ]) {
    assert.throws(() =>
      validateStagingSoakReceipt(evidence, { ...receipt, ...altered }, { nowMs: byFloor }),
    );
  }
});

test("records explicit supersession before or after the floor and preserves earlier receipts", async () => {
  const { options } = mockReads();
  const historical = await captureStagingSoakReceipt(evidence, options);
  const saved = JSON.stringify(historical);
  for (const observedAt of ["2026-01-01T10:20:00Z", "2026-01-01T10:42:00Z"]) {
    const known = {
      ...evidence,
      replacement: { sha, workerVersion: otherVersion, observedAt },
    };
    const nowMs = Date.parse(observedAt);
    const { calls, options } = mockReads({ nowMs });
    const receipt = await captureStagingSoakReceipt(known, options);
    assert.deepEqual(calls, []);
    assert.equal(receipt.status, "superseded");
    assert.equal(receipt.replacement.workerVersion, otherVersion);
    assert.equal(receipt.sample, undefined);
    assert.deepEqual(validateStagingSoakReceipt(known, receipt, { nowMs }), receipt);
    assert.throws(
      () => validateStagingSoakReceipt(known, historical, { nowMs }),
      /receipt mismatch/,
    );
    assert.throws(
      () =>
        validateStagingSoakReceipt(
          known,
          {
            ...receipt,
            sample: historical.sample,
          },
          { nowMs },
        ),
      /receipt mismatch/,
    );
  }
  await assert.rejects(
    captureStagingSoakReceipt(
      {
        ...evidence,
        replacement: { sha: otherSha, workerVersion, observedAt: floorAt },
      },
      options,
    ),
    /Invalid staging supersession/,
  );
  assert.equal(JSON.stringify(historical), saved);
});
