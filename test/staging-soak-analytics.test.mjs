import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback, rollback } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion, deployedAt, floorAt } = fixture.receipt;
const e2e = {
  runId: preRollback.id,
  startedAt: preRollback.run_started_at,
  completedAt: preRollback.updated_at,
};
const accountId = "c".repeat(32);
const provider = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next`;
const graphql = "https://api.cloudflare.com/client/v4/graphql";
const candidateRow = {
  dimensions: { scriptVersion: workerVersion },
  sum: { requests: 250, errors: 0 },
};
const otherVersionRow = {
  dimensions: { scriptVersion: rollback.versions[0].version_id },
  sum: { requests: 10, errors: 0 },
};

test.each([
  ["mixed Worker versions", [candidateRow, otherVersionRow]],
  ["a string request count", [{ ...candidateRow, sum: { requests: "250", errors: 0 } }]],
])("allocation soak rejects analytics with %s after readiness", async (_case, rows) => {
  const reads = [];
  const responses = new Map([
    [
      `${provider}/deployments`,
      () => Response.json({ success: true, result: { deployments: [first] } }),
    ],
    [
      `${provider}/versions/${workerVersion}`,
      () =>
        Response.json({
          success: true,
          result: {
            id: workerVersion,
            annotations: { "workers/tag": sha },
            metadata: { created_on: deployedAt },
          },
        }),
    ],
    [`${STAGING_ORIGIN}/version`, () => Response.json({ sha, deployedAt })],
    [
      `${STAGING_ORIGIN}/up`,
      () =>
        Response.json(
          { revision: { commit: sha, version_id: workerVersion } },
          { headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" } },
        ),
    ],
    [
      graphql,
      () =>
        Response.json({
          data: { viewer: { accounts: [{ workersInvocationsAdaptive: rows }] } },
        }),
    ],
  ]);

  await assert.rejects(
    captureAllocationSoak(
      { sha, e2e },
      {
        accountId,
        token: "synthetic-analytics-token",
        now: () => Date.parse(floorAt),
        fetchImpl: async (input) => {
          const url = String(input);
          reads.push(url);
          const respond = responses.get(url);
          assert.ok(respond, "Unexpected fixture request");
          return respond();
        },
      },
    ),
    (error) => {
      assert.deepEqual(error, new Error("Version-tagged staging analytics could not be verified"));
      return true;
    },
  );
  assert.deepEqual(reads, [
    `${provider}/deployments`,
    `${provider}/versions/${workerVersion}`,
    `${STAGING_ORIGIN}/version`,
    `${STAGING_ORIGIN}/up`,
    graphql,
  ]);
});
