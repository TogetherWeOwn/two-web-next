import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "vitest";
import { assertReadinessTraffic } from "../ci/db-readiness-projection.mjs";

const account = "0".repeat(32);
const version = "11111111-2222-4333-8444-555555555555";
const timestamps = [123, 456];

function checkTraffic(fetchImpl) {
  return assertReadinessTraffic(version, timestamps, account, "fixture", fetchImpl);
}

test("refuses a non-200 readiness response and cancels its unread body", async () => {
  const cleanup = Promise.withResolvers();
  let requests = 0;
  let pulls = 0;
  let cancellations = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new TextEncoder().encode("synthetic provider response"));
      },
      cancel() {
        cancellations++;
        return cleanup.promise;
      },
    },
    { highWaterMark: 0 },
  );
  const result = checkTraffic(() => {
    requests++;
    assert.equal(requests, 1);
    return new Response(body, { status: 503 });
  });

  // The refusal must settle even while the stream's cleanup is pending.
  await assert.rejects(Promise.race([result, setImmediate()]), {
    name: "AssertionError",
    message: "Readiness traffic check unavailable",
  });
  assert.equal(cancellations, 1, "expected refusal to cancel the body");
  assert.equal(pulls, 0);
  assert.equal(requests, 1);

  cleanup.reject(new Error("synthetic provider cleanup failure"));
  await setImmediate();
});

test("accepts healthy readiness traffic through deployments and health", async () => {
  const paths = [];
  await checkTraffic((url) => {
    const { pathname } = new URL(url);
    paths.push(pathname);
    if (pathname.endsWith("/deployments")) {
      return Response.json({
        success: true,
        result: {
          deployments: [
            {
              created_on: "2026-11-01T06:00:00.123456Z",
              versions: [{ version_id: version, percentage: 100 }],
            },
          ],
        },
      });
    }
    assert.equal(pathname, "/up");
    return Response.json({
      revision: { version_id: version },
      db: "ok",
      pending_migrations: 0,
      migration_ledger: timestamps,
    });
  });
  assert.deepEqual(paths, [
    `/client/v4/accounts/${account}/workers/scripts/two-web-next-production/deployments`,
    "/up",
  ]);
});
