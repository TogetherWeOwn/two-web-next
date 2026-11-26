import assert from "node:assert/strict";
import { afterEach, beforeEach, it, vi } from "vitest";
import { assertReadinessTraffic } from "../ci/db-readiness-projection.mjs";

const account = "0".repeat(32);
const version = "00000000-0000-4000-8000-000000000001";
const approvedLedger = [1_700_000_000_000, 1_700_000_002_000];
const deploymentsUrl = `https://api.cloudflare.com/client/v4/accounts/${account}/workers/scripts/two-web-next-production/deployments`;

beforeEach(() => {
  vi.stubGlobal("fetch", () => {
    throw new Error("Readiness fixture requires injected responses");
  });
});

afterEach(() => vi.unstubAllGlobals());

function checkTraffic(reportedLedger) {
  return assertReadinessTraffic(version, approvedLedger, account, "fixture", (url) => {
    if (String(url) === deploymentsUrl) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            {
              created_on: "2026-01-01T00:00:00Z",
              versions: [{ percentage: 100, version_id: version }],
            },
          ],
        },
      });
    }
    assert.equal(String(url), "https://togetherweown.com/up");
    return Response.json({
      revision: { version_id: version },
      db: "ok",
      pending_migrations: 0,
      migration_ledger: reportedLedger,
    });
  });
}

it("refuses a different ordered ledger for the approved Worker with zero pending migrations", async () => {
  const reportedLedger = [1_700_000_001_000, 1_700_000_002_000];
  await assert.rejects(checkTraffic(reportedLedger), {
    code: "ERR_ASSERTION",
    actual: reportedLedger,
    expected: approvedLedger,
  });
});

it("accepts the matching ordered ledger for the approved Worker", async () => {
  await checkTraffic(approvedLedger);
});
