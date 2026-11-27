import assert from "node:assert/strict";
import { mock } from "node:test";
import { assertReadinessTraffic } from "../db-readiness-projection.mjs";

function streamResponse(chunks) {
  const cancel = mock.fn();
  let next = 0;
  const body = new ReadableStream(
    {
      pull(controller) {
        const chunk = chunks[next++];
        if (chunk) controller.enqueue(chunk);
        else controller.close();
      },
      cancel,
    },
    // Keep the source open after the last chunk until the reader asks for EOF.
    { highWaterMark: 0 },
  );
  return { response: new Response(body), cancel };
}

export async function assertReadinessResponseBounds() {
  const version = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const timestamps = [1, 2];
  const limit = 16 * 1024;
  const body = Buffer.alloc(limit + 1, " ");
  const health = JSON.stringify({
    revision: { version_id: version },
    db: "ok",
    pending_migrations: 0,
    migration_ledger: timestamps,
    fixture_note: "é",
  });
  assert.ok(body.write(health) < limit);

  const run = (response) =>
    assertReadinessTraffic(version, timestamps, "a".repeat(32), "fixture", async (target) => {
      const { pathname } = new URL(target);
      if (pathname.endsWith("/deployments")) {
        return Response.json({
          success: true,
          result: {
            deployments: [
              {
                created_on: "2026-11-01T06:00:00.123456Z",
                versions: [{ percentage: 100, version_id: version }],
              },
            ],
          },
        });
      }
      assert.equal(pathname, "/up");
      return response;
    });

  const first = body.subarray(0, limit / 2);
  const second = body.subarray(limit / 2, limit);
  const bounded = streamResponse([first, second]);
  await run(bounded.response);
  assert.equal(bounded.cancel.mock.callCount(), 0);

  const oversized = streamResponse([first, second, body.subarray(limit)]);
  await assert.rejects(run(oversized.response), {
    message: "Oversized readiness traffic response",
  });
  assert.equal(
    oversized.cancel.mock.callCount(),
    1,
    "The oversized body must be cancelled before EOF",
  );
}
