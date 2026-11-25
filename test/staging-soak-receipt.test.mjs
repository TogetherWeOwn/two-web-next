import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import {
  captureStagingSoakReceipt,
  validateArchivedStagingSoakReceipt,
  validateStagingSoakReceipt,
} from "../ci/staging-soak-receipt.mjs";
import {
  basePath,
  graph,
  graphUrl,
  mockReads,
  original,
  restore,
  rollback,
  tag,
} from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { evidence: archived, receipt: expected } = fixture;
const { sha, workerVersion, e2eCompletedAt: completedAt, floorAt } = expected;
const identity = archived.e2e.before;
const evidence = {
  sha,
  e2e: {
    runId: 101,
    attempt: 1,
    conclusion: "success",
    startedAt: "2026-01-01T10:02:00Z",
    completedAt,
  },
};
const otherSha = "b".repeat(40);
const otherVersion = "22222222-2222-2222-2222-222222222222";
const revision = { commit: sha, version_id: workerVersion };
const byFloor = Date.parse(floorAt);

test("captures bounded post-floor counts for the same version on ordinary staging routing", async () => {
  const { calls, queries, options } = mockReads();
  const proof = await captureStagingSoakReceipt(evidence, options);
  const providerUrl = `https://api.cloudflare.com/client/v4/accounts/${options.accountId}${basePath}`;
  const stagingReads = [
    `${STAGING_ORIGIN}/version`,
    `${STAGING_ORIGIN}/up`,
    `${providerUrl}/versions/${workerVersion}`,
    `${providerUrl}/deployments`,
  ];
  assert.deepEqual(calls, [...stagingReads, graphUrl, ...stagingReads]);
  assert.match(queries[0].query, /scriptVersion: \$versionId/);
  assert.deepEqual(queries[0].variables, {
    accountTag: options.accountId,
    scriptName: "two-web-next",
    versionId: workerVersion,
    since: completedAt,
    until: floorAt,
  });
  assert.deepEqual(proof.receipt, {
    schema: "staging-soak/2",
    sha,
    workerVersion,
    deployedAt: identity.deployedAt,
    allocationId: original.id,
    allocationStartedAt: "2026-01-01T10:00:01.123456000Z",
    e2eRunId: 101,
    e2eAttempt: 1,
    e2eStartedAt: "2026-01-01T10:02:00.000Z",
    e2eCompletedAt: completedAt,
    floorAt,
    status: "sampled",
    sample: expected.sample,
  });
  assert.deepEqual(
    validateStagingSoakReceipt(proof.evidence, proof.receipt, { nowMs: byFloor }),
    proof.receipt,
  );
});

test("a late sample still queries the interval from E2E completion", async () => {
  const observedAt = "2026-01-01T11:00:00.000Z";
  const { queries, options } = mockReads({ nowMs: Date.parse(observedAt) });
  await captureStagingSoakReceipt(evidence, options);
  assert.equal(queries[0].variables.since, completedAt);
  assert.equal(queries[0].variables.until, observedAt);
});

test("refuses early, incomplete or misordered E2E evidence before any reads", async () => {
  const { calls, options } = mockReads();
  await assert.rejects(
    captureStagingSoakReceipt(evidence, { ...options, now: () => byFloor - 1 }),
    /floor has not elapsed/,
  );
  for (const invalid of [
    { attempt: 2 },
    { conclusion: "skipped" },
    { startedAt: undefined },
    { completedAt: undefined },
    { startedAt: completedAt },
    { completedAt: "2026-01-01T10:08:00Z", startedAt: completedAt },
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
    { versionDetail: { ...identity, id: workerVersion, annotations: { "workers/tag": otherSha } } },
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
  const proof = await captureStagingSoakReceipt(evidence, mockReads().options);
  const { receipt } = proof;
  for (const altered of [
    { sha: otherSha },
    { workerVersion: otherVersion },
    { allocationId: otherVersion },
    { allocationStartedAt: completedAt },
    { e2eRunId: 102 },
    { floorAt: completedAt },
    { sample: undefined },
    { sample: { ...receipt.sample, observedAt: completedAt } },
    { sample: { ...receipt.sample, observedAt: "2026-01-01T10:39:00.001Z" } },
    { sample: { ...receipt.sample, workerVersion: otherVersion } },
    { sample: { ...receipt.sample, debug: "synthetic-response-body" } },
  ]) {
    assert.throws(() =>
      validateStagingSoakReceipt(proof.evidence, { ...receipt, ...altered }, { nowMs: byFloor }),
    );
  }
});

test("validates archived supersession before or after the floor without qualifying old receipts", () => {
  const historical = validateArchivedStagingSoakReceipt(archived, expected, { nowMs: byFloor });
  const saved = JSON.stringify(historical);
  for (const observedAt of [completedAt, "2026-01-01T10:42:00.000Z"]) {
    const replacement = { sha, workerVersion: otherVersion, observedAt };
    const known = { ...archived, replacement };
    const { sample, ...base } = historical;
    assert.deepEqual(sample, expected.sample);
    const receipt = { ...base, replacement, status: "superseded" };
    assert.equal(receipt.status, "superseded");
    assert.deepEqual(receipt.replacement, replacement);
    assert.equal(receipt.sample, undefined);
    assert.deepEqual(validateArchivedStagingSoakReceipt(known, receipt), receipt);
    assert.throws(() => validateArchivedStagingSoakReceipt(known, historical), /receipt mismatch/);
    assert.throws(() => validateStagingSoakReceipt(known, receipt), /no allocation proof/);
  }
  const sameVersion = { sha, workerVersion, observedAt: floorAt };
  assert.throws(
    () => validateArchivedStagingSoakReceipt({ ...archived, replacement: sameVersion }, historical),
    /Invalid staging supersession/,
  );
  assert.equal(JSON.stringify(historical), saved);
});

test("a restored Worker needs continuous soak and fresh E2E for its new allocation", async () => {
  let deployments = [original];
  const provider = () => deployments;
  const historical = await captureStagingSoakReceipt(evidence, mockReads({ provider }).options);
  assert.equal(historical.receipt.allocationId, original.id);
  const saved = JSON.stringify(historical);

  deployments = [original, rollback];
  await assert.rejects(
    captureStagingSoakReceipt(
      evidence,
      mockReads({
        provider,
        nowMs: Date.parse("2026-01-01T10:42:00Z"),
        versions: [{ ...identity, sha: otherSha }],
      }).options,
    ),
    /serving identity/,
  );

  // Restore returns the same /up UUID and /version upload time. The provider
  // history is deliberately unordered and names a distinct active allocation.
  deployments = [rollback, restore, original];
  const resumed = mockReads({ provider, nowMs: Date.parse("2026-01-01T10:44:00Z") });
  await assert.rejects(
    captureStagingSoakReceipt(evidence, resumed.options),
    /fresh E2E is required/,
  );
  assert.deepEqual(resumed.queries, []);
  assert.equal(JSON.stringify(historical), saved);
  assert.deepEqual(
    validateStagingSoakReceipt(historical.evidence, historical.receipt, { nowMs: byFloor }),
    historical.receipt,
  );
  assert.throws(() => validateStagingSoakReceipt(archived, expected), /no allocation proof/);

  const fresh = {
    ...evidence,
    e2e: {
      ...evidence.e2e,
      runId: 102,
      startedAt: "2026-01-01T10:45:00Z",
      completedAt: "2026-01-01T10:50:00Z",
    },
  };
  const freshFloor = Date.parse("2026-01-01T11:20:00Z");
  const early = mockReads({ provider, nowMs: freshFloor - 1 });
  await assert.rejects(captureStagingSoakReceipt(fresh, early.options), /floor has not elapsed/);
  assert.deepEqual(early.calls, []);
  const ready = mockReads({ provider, nowMs: freshFloor });
  const proof = await captureStagingSoakReceipt(fresh, ready.options);
  assert.equal(proof.receipt.allocationId, restore.id);
  assert.equal(proof.receipt.workerVersion, workerVersion);
  assert.equal(proof.receipt.e2eRunId, 102);
  assert.equal(ready.queries[0].variables.since, "2026-01-01T10:50:00.000Z");
  assert.equal(ready.queries[0].variables.until, "2026-01-01T11:20:00.000Z");
  assert.deepEqual(
    validateStagingSoakReceipt(proof.evidence, proof.receipt, { nowMs: freshFloor }),
    proof.receipt,
  );
});

test("refuses missing, split, ambiguous, or changing provider allocations", async () => {
  for (const deployments of [
    [],
    [original, original],
    [original, { ...original, id: otherVersion }],
    [
      {
        ...original,
        versions: [
          { version_id: workerVersion, percentage: 95 },
          { version_id: otherVersion, percentage: 5 },
        ],
      },
    ],
    [{ ...original, created_on: "2026-01-01T10:02:00.000001Z" }],
  ]) {
    const mock = mockReads({ provider: () => deployments });
    await assert.rejects(captureStagingSoakReceipt(evidence, mock.options));
    assert.deepEqual(mock.queries, []);
  }
  let reads = 0;
  const provider = () => [
    reads++ === 0
      ? original
      : {
          ...original,
          id: otherVersion,
          created_on: "2026-01-01T10:39:00.000Z",
        },
  ];
  const interrupted = mockReads({ provider });
  await assert.rejects(
    captureStagingSoakReceipt(evidence, interrupted.options),
    /allocation changed/,
  );
  assert.equal(interrupted.queries.length, 1);
});
