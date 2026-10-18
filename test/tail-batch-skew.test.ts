// Acceptance contract: future-skewed Tail batch timestamps neither wipe
// real spikes nor poison later paging.
//
// A trace batch carries a source timestamp (`at`, from the trace
// eventTimestamp). Window eviction keys off that timestamp, so one batch
// stamped far in the future must not be able to evict every in-window
// bucket (a real spike then never pages), leave a retained bucket dated
// beyond the window, date an alert in the future, or arm a
// pending/cooldown marker in the future (real pages then stay
// suppressed). Batches skewed beyond now plus a documented slack are
// therefore rejected or clamped to around now at ingest. The pins below
// are written so either disposition — and either fix site, at the ingest
// boundaries or inside the tracker they feed — passes: skewed batches
// that must not affect totals carry zero counts, and skewed batches with
// counts assert only the shared invariants (prior buckets survive,
// exactly one page, never future-dated). The slack bound itself is the
// builder's documented choice; "far future" here starts at +24h, beyond
// the five-minute spike window, the fifteen-minute cooldown, and any
// sane slack, while a one-bucket (+30s) skew and merely-late batches are
// positive controls whose counts must still land (so the slack is at
// least one bucket, or beyond-slack batches are clamped, never silently
// dropped for ordinary clock drift).
//
// Skewed timestamps enter production through exactly two boundaries, and
// both are pinned end to end: the createTailWorker tail() path, where a
// skewed trace eventTimestamp becomes a batch, and the AlertAggregator
// /observe wire, where validBatch guards the durable tracker. A guard
// covering only one boundary leaves the other able to wipe the window.
// Mutable clocks advance with on-time arrivals, as a wall clock would;
// skewed batches arrive while the clock still reads their arrival time.
// The aggregator's clock is the real wall clock, so its fixtures are
// dated from Date.now(). No live webhook, database, or network: the
// Durable Object runs over fake storage and the worker over mock fetch.
// The positive controls at the end pin the existing spike, cooldown,
// late-batch, interleave, and per-script behavior a fix must not change.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_CRASHES,
  SPIKE_MIN_ERRORS,
  SPIKE_WINDOW_MS,
  createTailWorker,
  type SpikeAlert,
  type TraceBatch,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const DAY_MS = 86_400_000;
const MAIN = "two-web-next";
const JOBS = "two-web-jobs";
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

const crash = (at: number, crashes = 1, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: 0,
  errors: 0,
  crashes,
});

// A batch with no counts at all: rejecting it and clamping it are
// indistinguishable in every total, so it isolates the eviction harm.
const zero = (at: number, script = MAIN): TraceBatch => ({
  script,
  at,
  requests: 0,
  errors: 0,
  crashes: 0,
});

function expectNotFutureDated(timestamp: string, now: number) {
  const stamped = Date.parse(timestamp);
  expect(stamped).toBeGreaterThanOrEqual(now - SPIKE_WINDOW_MS);
  expect(stamped).toBeLessThanOrEqual(now + SPIKE_WINDOW_MS);
}

// Local-fallback worker on a mutable wall clock, mirroring the aggregate
// suites: pages are read back from the webhook mock, and the tracker
// stays reachable so retained buckets can be asserted.
function workerFixture() {
  let now = t0;
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const tracker = new AggregateTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: vi.fn(),
    mute: new DeliveryMute(() => now),
    tracker,
    now: () => now,
    sleep: async () => {},
  });
  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url === `${secret}?wait=true`)
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  return {
    worker,
    tracker,
    contents,
    setNow: (value: number) => {
      now = value;
    },
  };
}

const fetchTrace = (status: number, at: number) => ({
  scriptName: MAIN,
  scriptVersion: { tag: sha },
  outcome: "ok",
  exceptions: [],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [],
});

const crashTrace = (at: number) => ({
  scriptName: MAIN,
  scriptVersion: { tag: sha },
  outcome: "exception",
  exceptions: [{ name: "BoomError", message: "password=never-send", timestamp: at }],
  eventTimestamp: at,
  event: { queue: "private-queue", batchSize: 1 },
  logs: [],
});

// Durable Object aggregator over fake storage. Its clock is the real
// wall clock, so wire fixtures date on-time batches from Date.now().
function aggregatorFixture(seed?: Record<string, unknown>) {
  const store = new Map<string, unknown>();
  if (seed) store.set("scripts", structuredClone(seed));
  const state = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
  };
  const aggregator = new AlertAggregator(state as never);
  const observe = (batch: TraceBatch) =>
    aggregator.fetch(
      new Request("https://aggregator.invalid/observe", {
        method: "POST",
        body: JSON.stringify(batch),
      }),
    );
  const storedBuckets = (script = MAIN) => {
    const stored = (store.get("scripts") ?? {}) as Record<
      string,
      { buckets: { at: number; requests: number; errors: number; crashes: number }[] }
    >;
    return stored[script]?.buckets ?? [];
  };
  return { aggregator, observe, storedBuckets };
}

describe("future-skewed traces cannot wipe a real spike on the tail path", () => {
  it("pages a crash spike split around a trace stamped a day in the future, retaining no future bucket", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES - 1 }, () => crashTrace(t0)),
      env,
    );
    await f.worker.tail([fetchTrace(200, t0 + DAY_MS)], env);
    f.setNow(t0 + 60_000);
    await f.worker.tail([crashTrace(t0 + 60_000)], env);

    expect(f.contents()).toHaveLength(1);
    const page = f.contents()[0];
    expect(page).toMatchObject({ event: "error.spike", script: MAIN, crashes: SPIKE_MIN_CRASHES });
    // The skewed success contributes its request only when clamped.
    expect(page.requests).toBeLessThanOrEqual(1);
    expectNotFutureDated(page.timestamp, t0);
    expect(JSON.stringify(page)).not.toMatch(/never-send|example\.test/);
    for (const bucket of f.tracker.snapshot()[MAIN]?.buckets ?? []) {
      expect(bucket.at).toBeLessThanOrEqual(t0 + SPIKE_WINDOW_MS);
    }
  });

  it("pages an error-rate spike split around a far-future trace", async () => {
    const f = workerFixture();
    await f.worker.tail([fetchTrace(500, t0), fetchTrace(500, t0)], env);
    await f.worker.tail([fetchTrace(200, t0 + DAY_MS)], env);
    f.setNow(t0 + 30_000);
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_ERRORS - 2 }, () => fetchTrace(500, t0 + 30_000)),
      env,
    );

    expect(f.contents()).toHaveLength(1);
    const page = f.contents()[0];
    expect(page).toMatchObject({ event: "error.spike", script: MAIN, errors: SPIKE_MIN_ERRORS });
    // Five erroring requests, plus the skewed success only when clamped.
    expect(page.requests).toBeGreaterThanOrEqual(SPIKE_MIN_ERRORS);
    expect(page.requests).toBeLessThanOrEqual(SPIKE_MIN_ERRORS + 1);
    expectNotFutureDated(page.timestamp, t0);
  });

  it("does not let a far-future spike future-date its page or poison the cooldown for a later real spike", async () => {
    const f = workerFixture();
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES }, () => crashTrace(t0 + DAY_MS)),
      env,
    );
    // Clamped, the skewed spike pages once, dated around now; rejected,
    // it never pages. It must never page dated a day ahead.
    expect(f.contents().length).toBeLessThanOrEqual(1);
    for (const page of f.contents()) expectNotFutureDated(page.timestamp, t0);
    const pagesBefore = f.contents().length;

    const later = t0 + SPIKE_COOLDOWN_MS + 30_000;
    f.setNow(later);
    await f.worker.tail(
      Array.from({ length: SPIKE_MIN_CRASHES }, () => crashTrace(later)),
      env,
    );
    expect(f.contents()).toHaveLength(pagesBefore + 1);
    expect(f.contents().at(-1)).toMatchObject({
      event: "error.spike",
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(later).toISOString(),
    });
  });
});

describe("future-skewed batches cannot wipe the durable aggregator window", () => {
  it("keeps in-window counts through a far-future zero-count wire batch, and the next crash pages", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) {
      const response = await f.observe(crash(now));
      expect(response.status).toBe(200);
      expect(await response.json()).toBeNull();
    }

    // Rejected at the wire (400) or accepted-and-clamped (200): either is
    // a valid disposition; a crash (5xx) or silent window wipe is not.
    const skewed = await f.observe(zero(now + DAY_MS));
    expect([200, 400]).toContain(skewed.status);

    const retained = f.storedBuckets();
    expect(retained.reduce((n, b) => n + b.crashes, 0)).toBe(SPIKE_MIN_CRASHES - 1);
    for (const bucket of retained) {
      expect(bucket.at).toBeLessThanOrEqual(now + SPIKE_WINDOW_MS);
    }

    const page = await f.observe(crash(now + 1_000));
    expect(page.status).toBe(200);
    const alert = (await page.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    expectNotFutureDated(alert!.timestamp, now);
  });

  it("keeps in-window counts through a wire batch stamped at the largest safe integer", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now));

    const skewed = await f.observe(zero(Number.MAX_SAFE_INTEGER));
    expect([200, 400]).toContain(skewed.status);
    expect(f.storedBuckets().reduce((n, b) => n + b.crashes, 0)).toBe(SPIKE_MIN_CRASHES - 1);

    const page = await f.observe(crash(now + 1_000));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({ crashes: SPIKE_MIN_CRASHES });
  });

  it("pages exactly once and never future-dates the alert when a skewed crash batch lands between on-time batches", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    const alerts: SpikeAlert[] = [];
    const record = async (batch: TraceBatch) => {
      const response = await f.observe(batch);
      expect([200, 400]).toContain(response.status);
      if (response.status !== 200) return;
      const alert = (await response.json()) as SpikeAlert | null;
      if (alert) alerts.push(alert);
    };
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await record(crash(now));
    await record(crash(now + DAY_MS));
    await record(crash(now + 1_000));

    // Clamped, the skewed crash is the fifth and pages at once; rejected,
    // the on-time crash after it is. Either way: one page, real counts.
    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.crashes).toBeGreaterThanOrEqual(SPIKE_MIN_CRASHES);
    expectNotFutureDated(alerts[0]!.timestamp, now);
  });

  it("keeps restored counts through a skewed wire batch, and the next crash pages", async () => {
    const now = Date.now();
    const seed = new AggregateTracker(() => now);
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) seed.observe(crash(now));
    const f = aggregatorFixture(seed.snapshot());

    const skewed = await f.observe(zero(now + DAY_MS));
    expect([200, 400]).toContain(skewed.status);
    expect(f.storedBuckets().reduce((n, b) => n + b.crashes, 0)).toBe(SPIKE_MIN_CRASHES - 1);

    const page = await f.observe(crash(now + 1_000));
    expect(page.status).toBe(200);
    const alert = (await page.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    expectNotFutureDated(alert!.timestamp, now);
  });

  it("documents the future-skew slack bound next to validBatch", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../tail/worker.ts", import.meta.url).href),
      "utf8",
    );
    const at = source.indexOf("function validBatch");
    expect(at).toBeGreaterThanOrEqual(0);
    const near = source.slice(Math.max(0, at - 1_200), at + 1_200);
    expect(near).toMatch(/future|skew/i);
    expect(near).toMatch(/slack|clamp|reject|bound|allow/i);
  });
});

describe("positive controls: genuine spikes and ordinary batches behave as before", () => {
  it("pages a genuine crash spike with exactly the existing alert shape", () => {
    const tracker = new AggregateTracker(() => t0);
    expect(tracker.observe(crash(t0, SPIKE_MIN_CRASHES))).toEqual({
      event: "error.spike",
      script: MAIN,
      logs: "Workers & Pages > two-web-next > Observability > Logs",
      window_seconds: SPIKE_WINDOW_MS / 1000,
      requests: 0,
      errors: 0,
      crashes: SPIKE_MIN_CRASHES,
      error_rate: 0,
      timestamp: new Date(t0).toISOString(),
    });
  });

  it("holds the pending page, retries after a failed delivery, and cools down after a delivered one", () => {
    let now = t0;
    const tracker = new AggregateTracker(() => now);
    expect(tracker.observe(crash(t0, SPIKE_MIN_CRASHES))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
    });
    now = t0 + 30_000;
    expect(tracker.observe(crash(t0 + 30_000))).toBeNull();
    tracker.resolve(MAIN, false);
    now = t0 + 60_000;
    expect(
      tracker.observe({ script: MAIN, at: t0 + 60_000, requests: 1, errors: 0, crashes: 0 }),
    ).toMatchObject({
      crashes: SPIKE_MIN_CRASHES + 1,
      requests: 1,
      timestamp: new Date(t0 + 60_000).toISOString(),
    });
    tracker.resolve(MAIN, true);
    now = t0 + 120_000;
    expect(tracker.observe(crash(t0 + 120_000, SPIKE_MIN_CRASHES))).toBeNull();
    const afterCooldown = t0 + 60_000 + SPIKE_COOLDOWN_MS + 30_000;
    now = afterCooldown;
    expect(tracker.observe(crash(afterCooldown, SPIKE_MIN_CRASHES))).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(afterCooldown).toISOString(),
    });
  });

  it("keeps paging through interleaved later buckets", () => {
    let now = t0;
    const tracker = new AggregateTracker(() => now);
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) tracker.observe(crash(t0));
    now = t0 + 60_000;
    for (let i = 0; i < 10; i++) {
      expect(
        tracker.observe({
          script: MAIN,
          at: t0 + (i % 2 === 0 ? 30_000 : 60_000),
          requests: 1,
          errors: 0,
          crashes: 0,
        }),
      ).toBeNull();
    }
    now = t0 + 90_000;
    expect(tracker.observe(crash(t0 + 90_000))).toMatchObject({
      event: "error.spike",
      requests: 10,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(t0 + 90_000).toISOString(),
    });
  });

  it("keeps one script's counts isolated from another script's skewed batch", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now, 1, JOBS));
    const skewed = await f.observe(zero(now + DAY_MS, MAIN));
    expect([200, 400]).toContain(skewed.status);

    const page = await f.observe(crash(now + 1_000, 1, JOBS));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      event: "error.spike",
      script: JOBS,
      requests: 0,
      crashes: SPIKE_MIN_CRASHES,
    });
  });

  it("pages an on-time wire spike through the aggregator exactly as before", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    const response = await f.observe(crash(now, SPIKE_MIN_CRASHES));
    expect(response.status).toBe(200);
    const alert = (await response.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    expectNotFutureDated(alert!.timestamp, now);
  });

  it("still counts a merely-late in-window wire batch instead of silently dropping it", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now));
    // Stamped a minute ago, arriving now: late, not skewed, and inside
    // the window, so it is the fifth crash and must page.
    const page = await f.observe(crash(now - 60_000));
    expect(page.status).toBe(200);
    expect(await page.json()).toMatchObject({
      event: "error.spike",
      crashes: SPIKE_MIN_CRASHES,
    });
  });

  it("still counts a wire batch stamped one bucket ahead of the wall clock", async () => {
    const now = Date.now();
    const f = aggregatorFixture();
    for (let i = 0; i < SPIKE_MIN_CRASHES - 1; i++) await f.observe(crash(now));
    const page = await f.observe(crash(now + 30_000));
    expect(page.status).toBe(200);
    const alert = (await page.json()) as SpikeAlert | null;
    expect(alert).toMatchObject({ event: "error.spike", crashes: SPIKE_MIN_CRASHES });
    const stamped = Date.parse(alert!.timestamp);
    expect(stamped).toBeGreaterThanOrEqual(now - SPIKE_WINDOW_MS);
    expect(stamped).toBeLessThanOrEqual(now + 60_000);
  });
});
