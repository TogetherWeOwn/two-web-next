import assert from "node:assert/strict";
import { test } from "node:test";
import { createRouteEvidenceRequest } from "./route-evidence-github.mjs";
import { fetchRouteEvidenceProducer } from "./route-evidence-jobs.mjs";

const body = (value) => new Response(value);

test("authenticated attempt jobs request selects the unique producer", async () => {
  const request = createRouteEvidenceRequest("owner/repo", "test-token", async (url, options) => {
    assert.equal(
      url,
      "https://api.github.com/repos/owner/repo/actions/runs/12/attempts/2/jobs?per_page=100&page=1",
    );
    assert.equal(options.headers.Authorization, "Bearer test-token");
    assert.equal(options.redirect, "error");
    assert.ok(options.signal);
    return body(JSON.stringify({ total_count: 1, jobs: [{ id: 7, name: "producer" }] }));
  });
  assert.equal((await fetchRouteEvidenceProducer(request, 12, 2, "producer")).id, 7);
});

test("metadata client rejects unsafe paths, invalid responses and oversized bodies", async () => {
  const request = createRouteEvidenceRequest("owner/repo", "test-token", async () => body("{}"));
  for (const path of [
    "https://example.com/",
    "/pulls/1?x=1",
    "/actions/runs/1/attempts/1/jobs?per_page=100&page=11",
  ])
    await assert.rejects(request(path), /invalid GitHub metadata path/);
  assert.throws(
    () => createRouteEvidenceRequest("owner/repo/other", "token"),
    /invalid GitHub configuration/,
  );
  for (const response of [
    new Response("bad", { status: 403 }),
    body("not json"),
    body(""),
    body(JSON.stringify({ padding: "x".repeat(1024 * 1024 - 13) })),
    body(new Uint8Array([255])),
  ]) {
    const rejected = createRouteEvidenceRequest("owner/repo", "test-token", async () => response);
    await assert.rejects(rejected("/pulls/1"), /GitHub metadata unavailable/);
  }
});

test("metadata client accepts valid JSON at the byte limit", async () => {
  const value = { padding: "x".repeat(1024 * 1024 - 14) };
  const json = JSON.stringify(value);
  assert.equal(Buffer.byteLength(json), 1024 * 1024);
  const request = createRouteEvidenceRequest("owner/repo", "test-token", async () => body(json));
  assert.deepEqual(await request("/pulls/1"), value);
});

for (const stalledPart of ["headers", "body"]) {
  test(`metadata deadline aborts stalled ${stalledPart}`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    let bodyStarted = false;
    const request = createRouteEvidenceRequest(
      "owner/repo",
      "test-token",
      async (_url, options) => {
        signal = options.signal;
        const stalled = () =>
          new Promise((_, reject) => {
            signal.addEventListener("abort", () => reject(new Error("test-token")), { once: true });
          });
        if (stalledPart === "headers") return stalled();
        return new Response(
          new ReadableStream({
            start(controller) {
              signal.addEventListener("abort", () => controller.error(new Error("test-token")), {
                once: true,
              });
            },
            pull() {
              bodyStarted = true;
            },
          }),
        );
      },
    );
    const result = request("/pulls/1");
    const rejection = assert.rejects(result, {
      message: "route evidence refused: GitHub metadata unavailable",
    });
    await Promise.resolve();
    if (stalledPart === "body") assert.equal(bodyStarted, true);
    t.mock.timers.tick(9_999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    assert.equal(signal.aborted, true);
    await rejection;
  });
}

test("metadata client aborts a refused response before rejecting", async () => {
  let signal;
  let aborted = false;
  const request = createRouteEvidenceRequest("owner/repo", "test-token", async (_url, options) => {
    signal = options.signal;
    signal.addEventListener(
      "abort",
      () => {
        aborted = true;
      },
      { once: true },
    );
    return { ok: false, body: { secret: "test-token" } };
  });
  await assert.rejects(request("/pulls/1"), {
    message: "route evidence refused: GitHub metadata unavailable",
  });
  assert.equal(signal.aborted, true);
  assert.equal(aborted, true);
});

test("metadata client redacts errors from the transport", async () => {
  const request = createRouteEvidenceRequest("owner/repo", "test-token", async () => {
    throw new Error("test-token");
  });
  await assert.rejects(request("/pulls/1"), (error) => !error.message.includes("test-token"));
});
