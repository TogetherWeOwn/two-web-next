// Zero-count provenance: untagged batches with no counts never wipe build_sha.
//
// Production runs crons on the app script every 10 minutes
// (wrangler.jsonc "crons": ["*/10 * * * *", ...]). src/jobs/worker.ts seeds
// release metadata but logs no release line on success, so every cron tick
// and every successful queue batch reaches the tracker as an untagged batch
// with no counts. Those batches must not change bucket provenance and must
// not participate in the window SHA decision; otherwise every production
// spike page would silently drop build_sha.
//
// This file pins that rule without touching the acceptance-owned contract
// in test/tail-mixed-build-attribution-acceptance.test.ts (kept byte-for-byte).
// Hermetic: real AggregateTracker and createTailWorker with a fake webhook
// fetch. No Durable Object, webhook, database, or network is touched.
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  DeliveryMute,
  SPIKE_MIN_ERRORS,
  SPIKE_WINDOW_MS,
  createTailWorker,
  type TraceBatch,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const BUCKET_MS = 30_000;
const MAIN = "two-web-next";
const shaA = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

const errBatch = (at: number, n: number, buildSha?: string): TraceBatch => ({
  script: MAIN,
  at,
  requests: n,
  errors: n,
  crashes: 0,
  ...(buildSha !== undefined ? { buildSha } : {}),
});

const zeroBatch = (at: number): TraceBatch => ({
  script: MAIN,
  at,
  requests: 0,
  errors: 0,
  crashes: 0,
});

describe("zero-count batches never wipe build_sha (tracker)", () => {
  it("untagged zero-count batches in the same and earlier buckets keep SHA A", () => {
    const tracker = new AggregateTracker(() => t0);
    // Earlier bucket of its own with no counts: the window loop must skip it.
    expect(tracker.observe(zeroBatch(t0 - 2 * BUCKET_MS))).toBeNull();
    // Same bucket: a zero-count batch first leaves an empty bucket, then the
    // tagged errors adopt the bucket SHA via the priorCounts === 0 branch.
    expect(tracker.observe(zeroBatch(t0))).toBeNull();
    expect(tracker.observe(errBatch(t0, SPIKE_MIN_ERRORS - 2, shaA))).toBeNull();
    // Same bucket zero-count after tagged counts must not clear provenance.
    expect(tracker.observe(zeroBatch(t0))).toBeNull();
    const alert = tracker.observe(errBatch(t0, 2, shaA));
    expect(alert).toMatchObject({
      event: "error.spike",
      script: MAIN,
      build_sha: shaA,
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(alert).not.toBeNull();
    expect(Object.keys(alert!)).toContain("build_sha");
  });
});

describe("zero-count traces never wipe build_sha (one tail invocation)", () => {
  function fixture() {
    const now = t0;
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const contents = () =>
      (send.mock.calls as unknown as [string, RequestInit][])
        .filter(([url]) => url === `${secret}?wait=true`)
        .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
    return { worker, contents };
  }

  const fetchTrace = (status: number, tag: string) => ({
    scriptName: MAIN,
    scriptVersion: { tag },
    outcome: "ok",
    exceptions: [],
    eventTimestamp: t0,
    event: {
      request: { method: "GET", url: "https://example.test/" },
      response: { status },
    },
    logs: [],
  });

  // Production cron tick: scheduled event, no logs, no version tag.
  const scheduledTrace = () => ({
    scriptName: MAIN,
    outcome: "ok",
    exceptions: [],
    eventTimestamp: t0,
    event: { cron: "*/10 * * * *" },
    logs: [],
  });

  it("untagged scheduled traces before and after build-A 500s keep SHA A", async () => {
    const f = fixture();
    await f.worker.tail(
      [
        scheduledTrace(),
        ...Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, shaA)),
        scheduledTrace(),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      script: MAIN,
      build_sha: shaA,
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
    });
    expect(f.contents()[0].window_seconds).toBe(SPIKE_WINDOW_MS / 1000);
  });
});
