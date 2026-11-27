import assert from "node:assert/strict";
import { test, vi } from "vitest";
import { STAGING_ORIGIN } from "../ci/operator-constants.mjs";
import { captureAllocationSoak } from "../ci/staging-soak-receipt.mjs";
import { first, preRollback } from "./fixtures/staging-soak-http.mjs";
import fixture from "./fixtures/staging-soak-receipt.json" with { type: "json" };

const { sha, workerVersion, deployedAt, floorAt, sample } = fixture.receipt;
const e2e = {
  runId: preRollback.id,
  startedAt: preRollback.run_started_at,
  completedAt: preRollback.updated_at,
};
const accountId = "c".repeat(32);
const workerApi = `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/scripts/two-web-next`;
const deployments = `${workerApi}/deployments`;
const version = `${workerApi}/versions/${workerVersion}`;
const analytics = "https://api.cloudflare.com/client/v4/graphql";
const route = `${STAGING_ORIGIN}/version`;
const readiness = `${STAGING_ORIGIN}/up`;
const reads = [deployments, version, route, readiness, analytics, route, readiness, deployments];
const responseBudget = 1024 * 1024;
const replies = {
  [deployments]: { success: true, result: { deployments: [first] } },
  [version]: {
    success: true,
    result: {
      id: workerVersion,
      annotations: { "workers/tag": sha },
      metadata: { created_on: deployedAt },
    },
  },
  [route]: { sha, deployedAt },
  [readiness]: { revision: { commit: sha, version_id: workerVersion } },
  [analytics]: {
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
};

function capture(calls, replaceResponse = () => undefined) {
  return captureAllocationSoak(
    { sha, e2e },
    {
      accountId,
      token: "synthetic-provider-token",
      now: () => Date.parse(floorAt),
      fetchImpl: async (input) => {
        const url = String(input);
        calls.push(url);
        assert.ok(Object.hasOwn(replies, url), "Unexpected fixture URL");
        return (
          replaceResponse(url, calls.length) ??
          Response.json(replies[url], {
            headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" },
          })
        );
      },
    },
  );
}

function providerBodyAtLimit(url) {
  const payload = { ...replies[url], note: "synthetic-provider-body é" };
  const prefix = new TextEncoder().encode(JSON.stringify(payload));
  return [prefix, new Uint8Array(responseBudget - prefix.byteLength).fill(32)];
}

test("captures a qualifying synthetic allocation with ordinary provider responses", async () => {
  const calls = [];
  const receipt = await capture(calls);
  assert.equal(receipt.schema, "staging-soak/2");
  assert.equal(receipt.status, "sampled");
  assert.equal(receipt.allocationId, first.id);
  assert.deepEqual(receipt.sample, sample);
  assert.deepEqual(calls, reads);
});

test("qualifies a provider body of exactly 1 MiB", async () => {
  const calls = [];
  const receipt = await capture(calls, (url) => {
    if (url === deployments || url === version) {
      return new Response(new Blob(providerBodyAtLimit(url)).stream());
    }
  });
  assert.equal(receipt.status, "sampled");
  assert.deepEqual(calls, reads);
});

test.each([
  ["initial deployments", 1],
  ["version", 2],
  ["final deployments", reads.length],
])(
  "cancels a %s body one byte over the limit after a valid JSON prefix",
  async (_path, readNumber) => {
    const calls = [];
    const chunks = [...providerBodyAtLimit(reads[readNumber - 1]), Uint8Array.of(32)];
    let cancelled = false;
    let reachedEof = false;
    const body = new ReadableStream(
      {
        pull(controller) {
          const chunk = chunks.shift();
          if (chunk) controller.enqueue(chunk);
          else {
            reachedEof = true;
            controller.close();
          }
        },
        cancel() {
          cancelled = true;
        },
      },
      { highWaterMark: 0 },
    );
    await assert.rejects(
      capture(calls, (_url, index) => (index === readNumber ? new Response(body) : undefined)),
      { message: "Cannot read staging provider evidence" },
    );
    assert.equal(cancelled, true);
    assert.equal(reachedEof, false);
    assert.deepEqual(calls, reads.slice(0, readNumber));
  },
);

test.each([
  ["empty", ""],
  ["malformed", '{"success":true,"result":synthetic-provider-body}'],
])("refuses an %s provider body without exposing details", async (_kind, text) => {
  const calls = [];
  await assert.rejects(
    capture(calls, () => new Response(text)),
    {
      message: "Cannot read staging provider evidence",
    },
  );
  assert.deepEqual(calls, [deployments]);
});

test("refuses a provider stream that fails after a complete JSON prefix", async () => {
  const calls = [];
  const prefix = new TextEncoder().encode(JSON.stringify(replies[deployments]));
  let sentPrefix = false;
  const body = new ReadableStream({
    pull(controller) {
      if (sentPrefix) controller.error(new Error("synthetic-provider-stream-error"));
      else {
        controller.enqueue(prefix);
        sentPrefix = true;
      }
    },
  });
  await assert.rejects(
    capture(calls, () => new Response(body)),
    { message: "Cannot read staging provider evidence" },
  );
  assert.equal(sentPrefix, true);
  assert.deepEqual(calls, [deployments]);
});

test("refuses a stalled provider read at the deadline while cancellation is pending", async ({
  onTestFinished,
}) => {
  const calls = [];
  const deadline = new AbortController();
  const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValueOnce(deadline.signal);
  const { promise: reading, resolve: startRead } = Promise.withResolvers();
  const { promise: cleanup, resolve: finishCleanup } = Promise.withResolvers();
  onTestFinished(() => {
    finishCleanup();
    timeout.mockRestore();
  });
  let cancelled = false;
  const body = new ReadableStream(
    {
      pull() {
        startRead();
      },
      cancel() {
        cancelled = true;
        return cleanup;
      },
    },
    { highWaterMark: 0 },
  );
  const refusal = assert.rejects(
    capture(calls, () => new Response(body)),
    {
      message: "Cannot read staging provider evidence",
    },
  );
  await reading;
  assert.deepEqual(timeout.mock.calls[0], [10_000]);
  deadline.abort(new Error("synthetic-provider-deadline"));
  await refusal;
  assert.equal(cancelled, true);
  assert.equal(body.locked, false);
  assert.deepEqual(calls, [deployments]);
});
