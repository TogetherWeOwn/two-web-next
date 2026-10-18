// Acceptance contract: aggregate Tail counts survive interleaved time
// buckets.
//
// Trace batches do not necessarily arrive in timestamp order: the same
// 30-second bucket can recur after a different bucket has been observed.
// Repeated observations of one bucket must coalesce regardless of arrival
// order, so the retained in-window buckets are keyed by bucket time (one
// entry per distinct bucket), never duplicated per arrival. Duplicates
// are not harmless: the tracker's bucket cap then evicts still-live
// in-window counts — four crashes inside the five-minute window can be
// discarded by 42 successful batches alternating between two later
// buckets, and the fifth in-window crash never pages.
//
// These tests drive the real AggregateTracker directly with explicit
// batch timestamps (a hermetic fake clock): no webhook, Durable Object,
// database, or network. Crash batches contribute no requests/errors and
// successful batches contribute no crashes/errors, so only the crash
// gate can fire in the interleaved sequences and no other threshold
// fires first. The guards at the end pin the existing window, cooldown,
// settlement, alert-shape, and allowlist behavior that a fix must not
// change.
import { describe, expect, it } from "vitest";
import {
  AggregateTracker,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_CRASHES,
  SPIKE_WINDOW_MS,
  type SpikeAlert,
  type TraceBatch,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const BUCKET_MS = 30_000;
const MAX_BUCKETS = 40;
const MAIN = "two-web-next";
const JOBS = "two-web-jobs";

const crash = (at: number, crashes = 1, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: 0,
  errors: 0,
  crashes,
});

const success = (at: number, requests = 1, script = MAIN): TraceBatch => ({
  script,
  at,
  requests,
  errors: 0,
  crashes: 0,
});

const errorBatch = (at: number, requests: number, errors: number): TraceBatch => ({
  script: MAIN,
  at,
  requests,
  errors,
  crashes: 0,
});

// 42 successful batches alternating between the +30s and +60s buckets.
// Every arrival revisits a bucket that is no longer the most recent one.
const interleavedSuccesses = (count = 42, startIndex = 0, script = MAIN): TraceBatch[] =>
  Array.from({ length: count }, (_, i) =>
    success(t0 + ((startIndex + i) % 2 === 0 ? 30_000 : 60_000), 1, script),
  );

// Simple timestamp-keyed reference model: one entry per 30s bucket,
// counts summed per bucket, buckets kept while any part of them is
// inside the spike window as of `asOf`, sorted by bucket time.
type BucketTotals = { at: number; requests: number; errors: number; crashes: number };
function referenceBuckets(batches: TraceBatch[], script: string, asOf: number): BucketTotals[] {
  const byBucket = new Map<number, BucketTotals>();
  for (const batch of batches) {
    if (batch.script !== script) continue;
    const at = Math.floor(batch.at / BUCKET_MS) * BUCKET_MS;
    const bucket = byBucket.get(at) ?? { at, requests: 0, errors: 0, crashes: 0 };
    bucket.requests += batch.requests;
    bucket.errors += batch.errors;
    bucket.crashes += batch.crashes;
    byBucket.set(at, bucket);
  }
  return [...byBucket.values()]
    .filter((b) => b.at + BUCKET_MS > asOf - SPIKE_WINDOW_MS)
    .sort((a, b) => a.at - b.at);
}

function snapshotBuckets(tracker: AggregateTracker, script = MAIN): BucketTotals[] {
  return (tracker.snapshot()[script]?.buckets ?? []).map((b) => ({
    at: b.at,
    requests: b.requests,
    errors: b.errors,
    crashes: b.crashes,
  }));
}

// The retained buckets must be exactly the reference buckets: one entry
// per distinct bucket time, with those totals. Sorting a copy means
// internal ordering is not pinned; duplicate bucket times are.
function expectRetained(
  tracker: AggregateTracker,
  batches: TraceBatch[],
  script: string,
  asOf: number,
) {
  const actual = snapshotBuckets(tracker, script);
  expect(new Set(actual.map((b) => b.at)).size).toBe(actual.length);
  expect([...actual].sort((a, b) => a.at - b.at)).toEqual(referenceBuckets(batches, script, asOf));
}

function observeAll(tracker: AggregateTracker, batches: TraceBatch[]): SpikeAlert[] {
  const alerts: SpikeAlert[] = [];
  for (const batch of batches) {
    const alert = tracker.observe(batch);
    if (alert) alerts.push(alert);
  }
  return alerts;
}

describe("counts retained across interleaved time buckets", () => {
  it("pages on the fifth in-window crash after 42 successes alternate between two later buckets", () => {
    const tracker = new AggregateTracker(() => t0);
    const beforeFifth = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
      ...interleavedSuccesses(),
    ];
    expect(observeAll(tracker, beforeFifth)).toEqual([]);
    expectRetained(tracker, beforeFifth, MAIN, t0 + 60_000);

    const alert = tracker.observe(crash(t0 + 90_000));
    expect(alert).toEqual({
      event: "error.spike",
      script: MAIN,
      logs: "Workers & Pages > two-web-next > Observability > Logs",
      window_seconds: SPIKE_WINDOW_MS / 1000,
      requests: 42,
      errors: 0,
      crashes: SPIKE_MIN_CRASHES,
      error_rate: 0,
      timestamp: new Date(t0 + 90_000).toISOString(),
    });
  });

  it("retains the same buckets for interleaved and monotonic arrivals of the same batches", () => {
    // Below every alert gate (3 crashes, 3 errors), with unaligned
    // timestamps flooring into earlier buckets and buckets revisited
    // nonadjacently. A final batch at the maximum time normalizes the
    // window cutoff for both orderings.
    const batches: TraceBatch[] = [
      crash(t0),
      success(t0 + 30_000, 2),
      success(t0 + 60_000, 3),
      errorBatch(t0 + 30_000, 4, 1),
      crash(t0),
      success(t0 + 90_000),
      errorBatch(t0 + 60_000, 4, 1),
      success(t0 + 45_000, 2),
      crash(t0 + 90_000),
      success(t0 + 10_000, 5),
      errorBatch(t0 + 75_000, 4, 1),
      success(t0 + 120_000),
    ];
    const interleaved = new AggregateTracker(() => t0);
    const monotonic = new AggregateTracker(() => t0);
    expect(observeAll(interleaved, batches)).toEqual([]);
    expect(
      observeAll(
        monotonic,
        [...batches].sort((a, b) => a.at - b.at),
      ),
    ).toEqual([]);

    expectRetained(interleaved, batches, MAIN, t0 + 120_000);
    expect([...snapshotBuckets(interleaved)].sort((a, b) => a.at - b.at)).toEqual(
      [...snapshotBuckets(monotonic)].sort((a, b) => a.at - b.at),
    );
  });

  it("keeps the interleaved counts through a snapshot/restore continuation", () => {
    const first = new AggregateTracker(() => t0);
    const firstHalf = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
      ...interleavedSuccesses(21),
    ];
    expect(observeAll(first, firstHalf)).toEqual([]);

    const revived = new AggregateTracker(() => t0);
    revived.restore(JSON.parse(JSON.stringify(first.snapshot())));
    const secondHalf = interleavedSuccesses(21, 21);
    expect(observeAll(revived, secondHalf)).toEqual([]);
    expectRetained(revived, [...firstHalf, ...secondHalf], MAIN, t0 + 60_000);

    expect(revived.observe(crash(t0 + 90_000))).toMatchObject({
      event: "error.spike",
      script: MAIN,
      requests: 42,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(t0 + 90_000).toISOString(),
    });
  });

  it("coalesces duplicate buckets already persisted in a restored snapshot before applying the cap", () => {
    // A snapshot stored by a last-bucket-only writer can hold more
    // entries than the cap while covering only three distinct buckets.
    // Restore must merge by bucket time first; trimming raw entries
    // would drop the crash bucket at the front.
    const persisted = {
      [MAIN]: {
        buckets: [
          { at: t0, requests: 0, errors: 0, crashes: SPIKE_MIN_CRASHES - 1 },
          ...Array.from({ length: 42 }, (_, i) => ({
            at: t0 + (i % 2 === 0 ? 30_000 : 60_000),
            requests: 1,
            errors: 0,
            crashes: 0,
          })),
        ],
        cooldownUntil: 0,
      },
    };
    const tracker = new AggregateTracker(() => t0);
    tracker.restore(JSON.parse(JSON.stringify(persisted)));

    const batches = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
      ...interleavedSuccesses(),
    ];
    expectRetained(tracker, batches, MAIN, t0 + 60_000);
    expect(tracker.observe(crash(t0 + 90_000))).toMatchObject({
      event: "error.spike",
      script: MAIN,
      requests: 42,
      crashes: SPIKE_MIN_CRASHES,
    });
  });

  it("keeps interleaved counts isolated per script, including the triggering totals", () => {
    const tracker = new AggregateTracker(() => t0);
    const mainBatches = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0, 1, MAIN)),
      ...interleavedSuccesses(42, 0, MAIN),
    ];
    // Same buckets, opposite alternation phase, different script.
    const jobsBatches = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0, 1, JOBS)),
      ...Array.from({ length: 42 }, (_, i) =>
        success(t0 + (i % 2 === 0 ? 60_000 : 30_000), 1, JOBS),
      ),
    ];
    const mixed: TraceBatch[] = [];
    for (let i = 0; i < mainBatches.length; i++) mixed.push(mainBatches[i]!, jobsBatches[i]!);
    expect(observeAll(tracker, mixed)).toEqual([]);

    expect(tracker.observe(crash(t0 + 90_000, 1, MAIN))).toMatchObject({
      event: "error.spike",
      script: MAIN,
      requests: 42,
      crashes: SPIKE_MIN_CRASHES,
    });
    expectRetained(tracker, jobsBatches, JOBS, t0 + 60_000);
    expect(tracker.observe(crash(t0 + 90_000, 1, JOBS))).toMatchObject({
      event: "error.spike",
      script: JOBS,
      logs: "Workers & Pages > two-web-jobs > Observability > Logs",
      requests: 42,
      crashes: SPIKE_MIN_CRASHES,
    });
  });

  it("stays bounded by distinct in-window buckets under sustained alternation", () => {
    const tracker = new AggregateTracker(() => t0);
    const batches = [
      ...Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
      ...interleavedSuccesses(200),
    ];
    expect(observeAll(tracker, batches)).toEqual([]);

    const retained = snapshotBuckets(tracker);
    expect(retained.length).toBeLessThanOrEqual(MAX_BUCKETS);
    expectRetained(tracker, batches, MAIN, t0 + 60_000);
    expect(retained).toHaveLength(3);
    expect(tracker.observe(crash(t0 + 90_000))).toMatchObject({
      requests: 200,
      crashes: SPIKE_MIN_CRASHES,
    });
  });
});

describe("existing window, cooldown, settlement, and alert contracts are unchanged", () => {
  it("counts the fifth crash at the window edge and expires the first bucket one bucket later", () => {
    const atEdge = new AggregateTracker(() => t0);
    observeAll(
      atEdge,
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
    );
    expect(atEdge.observe(crash(t0 + SPIKE_WINDOW_MS))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(t0 + SPIKE_WINDOW_MS).toISOString(),
    });

    const pastEdge = new AggregateTracker(() => t0);
    observeAll(
      pastEdge,
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crash(t0)),
    );
    expect(pastEdge.observe(crash(t0 + SPIKE_WINDOW_MS + BUCKET_MS))).toBeNull();
    expect(snapshotBuckets(pastEdge).reduce((n, b) => n + b.crashes, 0)).toBe(1);
  });

  it("holds the pending page, retries after a failed delivery, and cools down after a delivered one", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(crash(t0, SPIKE_MIN_CRASHES))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
    });
    // Pending: further counts accumulate but no second page is offered.
    expect(tracker.observe(crash(t0 + 30_000))).toBeNull();
    // Failed delivery: the next batch re-offers the page with all counts.
    tracker.resolve(MAIN, false);
    expect(tracker.observe(success(t0 + 60_000))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES + 1,
      requests: 1,
      timestamp: new Date(t0 + 60_000).toISOString(),
    });
    // Delivered: the cooldown suppresses new pages, then expires.
    tracker.resolve(MAIN, true);
    expect(tracker.observe(crash(t0 + 120_000, SPIKE_MIN_CRASHES))).toBeNull();
    const afterCooldown = t0 + 60_000 + SPIKE_COOLDOWN_MS + BUCKET_MS;
    expect(tracker.observe(crash(afterCooldown, SPIKE_MIN_CRASHES))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(afterCooldown).toISOString(),
    });
  });

  it("emits exactly the existing redacted alert shape and never forwards an invalid build tag", () => {
    const tracker = new AggregateTracker(() => t0);
    const alert = tracker.observe({ ...crash(t0, SPIKE_MIN_CRASHES), buildSha: "never-send" });
    expect(alert).not.toBeNull();
    expect(Object.keys(alert!)).toEqual([
      "event",
      "script",
      "logs",
      "window_seconds",
      "requests",
      "errors",
      "crashes",
      "error_rate",
      "timestamp",
    ]);
    expect(JSON.stringify(alert)).not.toContain("never-send");
  });

  it("still ignores scripts outside the allowlist instead of tracking them", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(crash(t0, SPIKE_MIN_CRASHES * 2, "other-worker"))).toBeNull();
    expect(tracker.snapshot()).toEqual({});
  });
});
