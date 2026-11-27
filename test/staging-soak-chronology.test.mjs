import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureStagingSoakReceipt } from "../ci/staging-soak-receipt.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

test("refuses E2E completed before its claimed staging deploy without making any reads", async () => {
  const { evidence, receipt } = fixture;
  const { sha, workerVersion, deployedAt, floorAt, sample } = receipt;
  const deployedAtMs = Date.parse(deployedAt);
  const withCompletion = (offsetMs) => ({
    ...evidence,
    e2e: { ...evidence.e2e, completedAt: new Date(deployedAtMs + offsetMs).toISOString() },
  });

  const calls = [];
  const versionUrl = `${STAGING_ORIGIN}/version`;
  const readinessUrl = `${STAGING_ORIGIN}/up`;
  const analyticsUrl = "https://api.cloudflare.com/client/v4/graphql";
  const options = {
    accountId: "c".repeat(32),
    token: "synthetic-analytics-token",
    now: () => Date.parse(floorAt),
    fetchImpl: async (input) => {
      const url = String(input);
      calls.push(url);
      if (url === versionUrl) return Response.json({ sha, deployedAt });
      if (url === readinessUrl) {
        return Response.json(
          { revision: { commit: sha, version_id: workerVersion } },
          { headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" } },
        );
      }
      assert.equal(url, analyticsUrl);
      return Response.json({
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
      });
    },
  };

  await assert.rejects(
    captureStagingSoakReceipt(withCompletion(-1), options),
    /^Error: Inconsistent staging deploy and E2E chronology$/,
  );
  assert.deepEqual(calls, []);

  const ordered = withCompletion(1);
  const captured = await captureStagingSoakReceipt(ordered, options);
  assert.deepEqual(calls, [versionUrl, readinessUrl, analyticsUrl, versionUrl, readinessUrl]);
  assert.equal(captured.status, "sampled");
  assert.equal(captured.e2eCompletedAt, ordered.e2e.completedAt);
  assert.deepEqual(captured.sample, sample);
});
