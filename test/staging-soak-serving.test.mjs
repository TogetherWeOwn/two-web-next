import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback, trustedReads } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion, deployedAt, floorAt } = fixture.receipt;
const e2e = {
  runId: preRollback.id,
  startedAt: preRollback.run_started_at,
  completedAt: preRollback.updated_at,
};
const readinessHeaders = { "x-two-origin": "two-web-next", "cache-control": "no-store" };
const revision = { commit: sha, version_id: workerVersion };
const ready = (marker = revision, init = { headers: readinessHeaders }) =>
  Response.json({ revision: marker }, init);
const privateDetail = "synthetic private response or transport detail";
const refusedRead = () => {
  throw new Error(privateDetail);
};

test("staging soak refuses serving failures with fixed labels at either observation", async () => {
  const origin = "Staging origin identity could not be verified";
  const readiness = "Staging readiness contract could not be verified";
  const mismatch = "Staging serving deployment or version mismatch";
  const graphPath = "/client/v4/graphql";
  const servingPaths = ["/version", "/up"];
  const graph = {
    data: {
      viewer: {
        accounts: [
          {
            workersInvocationsAdaptive: [
              { dimensions: { scriptVersion: workerVersion }, sum: { requests: 250, errors: 2 } },
            ],
          },
        ],
      },
    },
  };
  const cases = [
    ["/version", refusedRead, origin],
    ["/version", () => new Response(privateDetail.repeat(100)), origin],
    ["/version", () => Response.json({ sha: "b".repeat(40), deployedAt }), origin],
    ["/up", refusedRead, readiness],
    ["/up", () => ready(revision, { status: 503, headers: readinessHeaders }), readiness],
    [
      "/up",
      () => ready(revision, { headers: { ...readinessHeaders, "x-two-origin": privateDetail } }),
      readiness,
    ],
    [
      "/up",
      () => ready(revision, { headers: { ...readinessHeaders, "cache-control": "public" } }),
      readiness,
    ],
    ["/up", () => new Response(privateDetail, { headers: readinessHeaders }), readiness],
    ["/version", () => Response.json({ sha, deployedAt: "2026-01-01T10:00:01.000Z" }), mismatch],
    ["/up", () => ready({ ...revision, commit: "b".repeat(40) }), mismatch],
    [
      "/up",
      () => ready({ ...revision, version_id: "22222222-2222-2222-2222-222222222222" }),
      mismatch,
    ],
    ["/up", () => ready(null), mismatch],
  ];

  for (const [path, respond, message] of cases) {
    for (const observation of [1, 2]) {
      const reads = [];
      let pathReads = 0;
      const fetchFixture = trustedReads(
        {
          fetchImpl: async (input) => {
            const url = new URL(input);
            if (url.pathname === graphPath) return Response.json(graph);
            assert.equal(url.origin, STAGING_ORIGIN);
            if (url.pathname === path && ++pathReads === observation) return respond();
            if (url.pathname === "/version") return Response.json({ sha, deployedAt });
            assert.equal(url.pathname, "/up");
            return ready();
          },
        },
        { deployments: () => [first], run: preRollback },
      );
      await assert.rejects(
        captureAllocationSoak(
          { sha, e2e },
          {
            accountId: "c".repeat(32),
            token: "synthetic-analytics-token",
            now: () => Date.parse(floorAt),
            fetchImpl: async (input, init) => {
              reads.push(new URL(input).pathname);
              return fetchFixture(input, init);
            },
          },
        ),
        (error) => {
          assert.deepEqual(error, new Error(message));
          assert.equal(error.cause, undefined);
          return true;
        },
      );
      assert.equal(reads[0].split("/").at(-1), "deployments");
      assert.equal(reads[1].split("/").at(-1), workerVersion);
      assert.deepEqual(reads.slice(2), [
        ...(observation === 2 ? [...servingPaths, graphPath] : []),
        ...(message === origin ? ["/version"] : servingPaths),
      ]);
    }
  }
});
