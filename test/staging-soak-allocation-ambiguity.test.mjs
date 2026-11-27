import assert from "node:assert/strict";
import { test } from "vitest";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { sha, floorAt } = fixture.receipt;
const e2e = {
  runId: preRollback.id,
  startedAt: preRollback.run_started_at,
  completedAt: preRollback.updated_at,
};
const earlier = {
  ...first,
  id: "66666666-6666-6666-6666-666666666666",
  created_on: "2026-01-01T10:00:30.123456Z",
};

test.each([
  ["a duplicate deployment ID", { ...earlier, id: first.id }],
  ["a duplicate deployment timestamp", { ...earlier, created_on: first.created_on }],
])("allocation soak refuses %s before downstream reads", async (_description, duplicate) => {
  const accountId = "c".repeat(32);
  const deploymentsUrl = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next/deployments`;
  const reads = [];
  await assert.rejects(
    captureAllocationSoak(
      { sha, e2e },
      {
        accountId,
        token: "synthetic-analytics-token",
        now: () => Date.parse(floorAt),
        fetchImpl: async (url) => {
          reads.push(url);
          assert.equal(url, deploymentsUrl);
          return Response.json({ success: true, result: { deployments: [first, duplicate] } });
        },
      },
    ),
    { message: "Ambiguous staging allocations" },
  );
  assert.deepEqual(reads, [deploymentsUrl]);
});
