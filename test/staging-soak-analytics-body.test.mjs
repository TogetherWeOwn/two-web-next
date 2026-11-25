import assert from "node:assert/strict";
import { test } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback, trustedReads } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion, deployedAt, floorAt, sample } = fixture.receipt;
const graphUrl = "https://api.cloudflare.com/client/v4/graphql";
const graph = {
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
  extensions: { note: "é" },
};
const encoder = new TextEncoder();
const body = encoder.encode(JSON.stringify(graph));
const padding = new Uint8Array(64 * 1024 - body.byteLength).fill(0x20);
const utf8Bom = encoder.encode("\uFEFF");

function capture(analyticsResponse) {
  const reads = [];
  const fetchImpl = trustedReads(
    {
      fetchImpl: async (input) => {
        const url = String(input);
        if (url === `${STAGING_ORIGIN}/version`) return Response.json({ sha, deployedAt });
        if (url === `${STAGING_ORIGIN}/up`) {
          return Response.json(
            { revision: { commit: sha, version_id: workerVersion } },
            { headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" } },
          );
        }
        assert.equal(url, graphUrl);
        return analyticsResponse;
      },
    },
    { deployments: () => [first], run: preRollback },
  );
  const result = captureAllocationSoak(
    {
      sha,
      e2e: {
        runId: preRollback.id,
        startedAt: preRollback.run_started_at,
        completedAt: preRollback.updated_at,
      },
    },
    {
      accountId: "c".repeat(32),
      token: "synthetic-analytics-token",
      now: () => Date.parse(floorAt),
      fetchImpl(input, init) {
        reads.push(String(input));
        return fetchImpl(input, init);
      },
    },
  );
  return { reads, result };
}

test("certifies ordinary synthetic staging analytics", async () => {
  const { result } = capture(Response.json(graph));
  const receipt = await result;
  assert.equal(receipt.schema, "staging-soak/2");
  assert.equal(receipt.allocationId, first.id);
  assert.deepEqual(receipt.sample, sample);
});

test("certifies staging analytics at exactly 64 KiB of streamed bytes", async () => {
  const response = new Response(
    new ReadableStream({
      start(controller) {
        // A decoder that flushes each chunk leaves an invalid prefix before the JSON.
        controller.enqueue(utf8Bom.subarray(0, 1));
        controller.enqueue(utf8Bom.subarray(1));
        controller.enqueue(body);
        controller.enqueue(padding.subarray(utf8Bom.byteLength));
        controller.close();
      },
    }),
  );
  const { result } = capture(response);
  assert.deepEqual((await result).sample, sample);
});

test("cancels oversized staging analytics before certifying the receipt", async () => {
  const chunks = [body, padding, Uint8Array.of(0x20)];
  let pulls = 0;
  let cancelled = false;
  const response = new Response(
    new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks[pulls++];
          if (chunk) controller.enqueue(chunk);
          else controller.close();
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const { reads, result } = capture(response);
  await assert.rejects(result, {
    message: "Version-tagged staging analytics could not be verified",
  });
  assert.equal(cancelled, true);
  assert.equal(pulls, chunks.length);
  assert.equal(response.body.locked, false);
  assert.equal(reads.at(-1), graphUrl);
});

test("refuses a normal analytics HTTP error before certifying the receipt", async () => {
  const { reads, result } = capture(Response.json(graph, { status: 503 }));
  await assert.rejects(result, {
    message: "Version-tagged staging analytics could not be verified",
  });
  assert.equal(reads.at(-1), graphUrl);
});

test.each([
  ["missing", null],
  ["empty", ""],
  ["malformed", '{"synthetic-response-body":'],
])("refuses a successful analytics response with a %s body", async (_kind, raw) => {
  const { reads, result } = capture(new Response(raw));
  await assert.rejects(result, {
    message: "Version-tagged staging analytics could not be verified",
  });
  assert.equal(reads.at(-1), graphUrl);
});
