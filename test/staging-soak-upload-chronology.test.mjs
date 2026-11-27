import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

test("allocation soak rejects a Worker uploaded after its allocation started", async () => {
  const { sha, workerVersion, floorAt, sample } = fixture.receipt;
  const e2e = {
    runId: preRollback.id,
    startedAt: preRollback.run_started_at,
    completedAt: preRollback.updated_at,
  };
  const accountId = "c".repeat(32);
  const provider = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next`;
  const deployments = `${provider}/deployments`;
  const versionMetadata = `${provider}/versions/${workerVersion}`;
  const servedVersion = `${STAGING_ORIGIN}/version`;
  const readiness = `${STAGING_ORIGIN}/up`;
  const analytics = "https://api.cloudflare.com/client/v4/graphql";

  // Both uploads are in the same millisecond as the allocation. Serving
  // identity stays identical while the provider timestamps straddle its start.
  const deployedAt = "2026-01-01T10:01:00.123Z";
  const capture = (uploadedAt, reads) => {
    const responses = new Map([
      [deployments, { success: true, result: { deployments: [first] } }],
      [
        versionMetadata,
        {
          success: true,
          result: {
            id: workerVersion,
            annotations: { "workers/tag": sha },
            metadata: { created_on: uploadedAt },
          },
        },
      ],
      [servedVersion, { sha, deployedAt }],
      [readiness, { revision: { commit: sha, version_id: workerVersion } }],
      [
        analytics,
        {
          data: {
            viewer: {
              accounts: [
                {
                  workersInvocationsAdaptive: [
                    {
                      dimensions: { scriptVersion: workerVersion },
                      sum: { requests: sample.requests, errors: sample.errors },
                    },
                  ],
                },
              ],
            },
          },
        },
      ],
    ]);
    return captureAllocationSoak(
      { sha, e2e },
      {
        accountId,
        token: "synthetic-analytics-token",
        now: () => Date.parse(floorAt),
        fetchImpl: async (input) => {
          const url = String(input);
          reads.push(url);
          assert.ok(responses.has(url), `Unexpected fixture request: ${url}`);
          const headers =
            url === readiness
              ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
              : {};
          return Response.json(responses.get(url), { headers });
        },
      },
    );
  };

  const controlReads = [];
  const receipt = await capture("2026-01-01T10:01:00.123455Z", controlReads);
  assert.deepEqual(controlReads, [
    deployments,
    versionMetadata,
    servedVersion,
    readiness,
    analytics,
    servedVersion,
    readiness,
    deployments,
  ]);
  assert.equal(receipt.schema, "staging-soak/2");
  assert.equal(receipt.status, "sampled");
  assert.equal(receipt.sha, sha);
  assert.equal(receipt.allocationId, first.id);
  assert.deepEqual(receipt.sample, sample);

  const lateUploadReads = [];
  await assert.rejects(capture("2026-01-01T10:01:00.123457Z", lateUploadReads), {
    message: "Staging provider version does not match the allocation and candidate",
  });
  assert.deepEqual(lateUploadReads, [deployments, versionMetadata]);
});
