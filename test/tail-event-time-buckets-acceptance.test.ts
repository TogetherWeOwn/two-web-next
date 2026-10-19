// Acceptance contract: one Tail invocation preserves event-time buckets.
//
// A single tail() invocation can carry same-script traces whose
// eventTimestamp values are minutes apart. Those traces must be coalesced
// by script AND by the existing 30-second event-time bucket — never by
// script alone with the merged batch re-stamped at the newest trace time —
// and the resulting buckets must be fed to the spike tracker in
// chronological order, whatever order the traces arrived in. Otherwise
// four crashes at t0 plus one crash six minutes later collapse into a
// five-crash "spike" at the newer time, even though no rolling
// five-minute window ever contained five crashes, and the page's counts
// and build attribution blame a window that never existed.
//
// The contract in one line: the verdicts, retained buckets and build
// attribution of one mixed-age invocation are exactly what feeding the
// same traces bucket-by-bucket in event-time order would produce.
// Thresholds, cooldowns, pending/retry settlement and the redacted alert
// shape are unchanged; provenance stays per counted bucket, so a build
// whose counts have already expired out of the window neither counts
// toward a later spike nor pollutes its build_sha.
//
// These tests drive the real createTailWorker.tail with hermetic
// fixtures (fake clock, fake webhook fetch, real AggregateTracker on the
// local path, real AlertAggregator over fake storage on the Durable
// Object path): no live webhook, Durable Object service, database, or
// network. Fixture clocks sit at the newest trace time, as a real
// invocation's wall clock would, so the old traces are merely late
// arrivals — not future-skew cases. Non-fetch crash traces contribute no
// requests/errors, so only the crash gate can fire in the crash sequences.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  SPIKE_MIN_CRASHES,
  SPIKE_MIN_ERRORS,
  SPIKE_WINDOW_MS,
  createTailWorker,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const BUCKET_MS = 30_000;
// Six minutes after t0: one full bucket past the five-minute spike window
// plus its edge, so counts at t0 are unambiguously expired as of T.
const T = t0 + SPIKE_WINDOW_MS + 60_000;
const MAIN = "two-web-next";
const JOBS = "two-web-jobs";
const shaA = "0123456789abcdef0123456789abcdef01234567";
const shaB = "fedcba9876543210fedcba9876543210fedcba98";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const env = { OPS_ALERT_WEBHOOK_URL: secret };

type Trace = ReturnType<typeof crashTrace> | ReturnType<typeof fetchTrace>;

const crashTrace = (at: number, tag: string = shaA, scriptName: string = MAIN) => ({
  scriptName,
  scriptVersion: { tag },
  outcome: "exception",
  exceptions: [{ name: "BoomError", message: "password=never-send", timestamp: at }],
  eventTimestamp: at,
  event: { queue: "private-queue", batchSize: 1 },
  logs: [] as never[],
});

const fetchTrace = (status: number, at: number, tag: string = shaA) => ({
  scriptName: MAIN,
  scriptVersion: { tag },
  outcome: "ok",
  exceptions: [] as never[],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [] as never[],
});

const crashes = (n: number, at: number, tag: string = shaA, scriptName: string = MAIN): Trace[] =>
  Array.from({ length: n }, () => crashTrace(at, tag, scriptName));

// Local-path worker: no ALERT_AGGREGATOR binding, so the per-isolate
// tracker decides. The clock starts at the newest trace time.
function localFixture(nowStart = T) {
  let now = nowStart;
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const sink = vi.fn();
  const tracker = new AggregateTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    tracker,
    now: () => now,
    sleep: async () => {},
  });
  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url === `${secret}?wait=true`)
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  const buckets = (script = MAIN) =>
    (tracker.snapshot()[script]?.buckets ?? []).map((b) => ({
      at: b.at,
      requests: b.requests,
      errors: b.errors,
      crashes: b.crashes,
    }));
  return {
    worker,
    contents,
    buckets,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("mixed-age traces in one invocation keep their event-time buckets (local path)", () => {
  it("four crashes at t0 plus one six minutes later do not page, and only the new bucket is retained", async () => {
    const f = localFixture();
    await f.worker.tail([...crashes(SPIKE_MIN_CRASHES - 1, t0), ...crashes(1, T)], env);
    expect(f.contents()).toEqual([]);
    expect(f.buckets()).toEqual([{ at: T, requests: 0, errors: 0, crashes: 1 }]);
  });

  it("the surviving new crash still counts: four more in-window crashes then page exactly once", async () => {
    const f = localFixture();
    await f.worker.tail([...crashes(SPIKE_MIN_CRASHES - 1, t0), ...crashes(1, T)], env);
    expect(f.contents()).toEqual([]);

    f.setNow(T + BUCKET_MS);
    await f.worker.tail(crashes(SPIKE_MIN_CRASHES - 1, T + BUCKET_MS), env);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      script: MAIN,
      build_sha: shaA,
      requests: 0,
      errors: 0,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T + BUCKET_MS).toISOString(),
    });
    expect(JSON.stringify(f.contents())).not.toMatch(/never-send|BoomError|private-queue/);
  });

  it("reversing the trace order of the mixed-age invocation yields the same verdict and retained buckets", async () => {
    const forward = localFixture();
    await forward.worker.tail([...crashes(SPIKE_MIN_CRASHES - 1, t0), ...crashes(1, T)], env);

    const reversed = localFixture();
    await reversed.worker.tail([...crashes(1, T), ...crashes(SPIKE_MIN_CRASHES - 1, t0)], env);

    expect(reversed.contents()).toEqual([]);
    expect(reversed.contents()).toEqual(forward.contents());
    expect(reversed.buckets()).toEqual(forward.buckets());
    expect(reversed.buckets()).toEqual([{ at: T, requests: 0, errors: 0, crashes: 1 }]);
  });

  it("positive control: five crashes genuinely inside one window, spread over three buckets, page once", async () => {
    const f = localFixture();
    await f.worker.tail(
      [...crashes(2, T - 240_000), ...crashes(2, T - 60_000), ...crashes(1, T)],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      script: MAIN,
      build_sha: shaA,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T).toISOString(),
    });
  });

  it("the same in-window spike in reversed trace order pages identically, dated at the newest bucket", async () => {
    const forward = localFixture();
    await forward.worker.tail(
      [...crashes(2, T - 240_000), ...crashes(2, T - 60_000), ...crashes(1, T)],
      env,
    );

    const reversed = localFixture();
    await reversed.worker.tail(
      [...crashes(1, T), ...crashes(2, T - 60_000), ...crashes(2, T - 240_000)],
      env,
    );

    expect(reversed.contents()).toEqual(forward.contents());
    expect(reversed.contents()).toHaveLength(1);
    expect(reversed.contents()[0]).toMatchObject({
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T).toISOString(),
    });
    expect([...reversed.buckets()].sort((a, b) => a.at - b.at)).toEqual(
      [...forward.buckets()].sort((a, b) => a.at - b.at),
    );
  });

  it("mixed-age fetch errors do not merge into an error-rate spike either", async () => {
    const f = localFixture();
    await f.worker.tail(
      [
        ...Array.from({ length: SPIKE_MIN_ERRORS - 1 }, () => fetchTrace(500, t0)),
        fetchTrace(500, T),
      ],
      env,
    );
    expect(f.contents()).toEqual([]);
    expect(f.buckets()).toEqual([{ at: T, requests: 1, errors: 1, crashes: 0 }]);
  });

  it("an expired crash from another build neither counts toward nor pollutes a genuine later spike", async () => {
    const f = localFixture();
    await f.worker.tail([...crashes(1, t0, shaB), ...crashes(SPIKE_MIN_CRASHES, T, shaA)], env);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      build_sha: shaA,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T).toISOString(),
    });
    expect(JSON.stringify(f.contents())).not.toContain(shaB);
  });

  it("positive control: two builds genuinely in-window across buckets still page with no build_sha", async () => {
    const f = localFixture();
    await f.worker.tail(
      [...crashes(SPIKE_MIN_CRASHES - 2, T - 120_000, shaA), ...crashes(2, T, shaB)],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ crashes: SPIKE_MIN_CRASHES });
    expect(f.contents()[0]).not.toHaveProperty("build_sha");
    expect(JSON.stringify(f.contents())).not.toContain(shaA);
    expect(JSON.stringify(f.contents())).not.toContain(shaB);
  });

  it("traces seconds apart inside one 30-second bucket still coalesce into that bucket's counts", async () => {
    const f = localFixture(T + 29_000);
    await f.worker.tail([...crashes(3, T + 1_000), ...crashes(2, T + 29_000)], env);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({ crashes: SPIKE_MIN_CRASHES });
    const stamped = Date.parse(f.contents()[0].timestamp);
    expect(stamped).toBeGreaterThanOrEqual(T);
    expect(stamped).toBeLessThan(T + BUCKET_MS);
  });

  it("mixed-age traces stay isolated per script: only the genuinely spiking script pages", async () => {
    const f = localFixture();
    await f.worker.tail(
      [
        ...crashes(SPIKE_MIN_CRASHES - 1, t0, shaA, MAIN),
        ...crashes(SPIKE_MIN_CRASHES, T, shaA, JOBS),
        ...crashes(1, T, shaA, MAIN),
      ],
      env,
    );
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      script: JOBS,
      crashes: SPIKE_MIN_CRASHES,
    });
    expect(f.buckets(MAIN)).toEqual([{ at: T, requests: 0, errors: 0, crashes: 1 }]);
  });
});

// Durable Object path: the real AlertAggregator over fake storage behind a
// fake namespace binding. Observe calls are recorded so the coalescing
// itself is observable: one observe per distinct (script, event-time
// bucket), fed oldest bucket first, whatever the trace order was.
function aggregatorFixture() {
  let now = T;
  const store = new Map<string, unknown>();
  const state = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
  };
  const aggregator = new AlertAggregator(state as never);
  const observed: { at: number; requests: number; errors: number; crashes: number }[] = [];
  const aggEnv = {
    OPS_ALERT_WEBHOOK_URL: secret,
    ALERT_AGGREGATOR: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (url.endsWith("/observe") && typeof init?.body === "string") {
            observed.push(JSON.parse(init.body));
          }
          return aggregator.fetch(new Request(url, init));
        },
      }),
    },
  };
  const send = vi.fn(async () => new Response(null, { status: 200 }));
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: vi.fn(),
    mute: new DeliveryMute(() => now),
    tracker: new AggregateTracker(() => now),
    now: () => now,
    sleep: async () => {},
  });
  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][])
      .filter(([url]) => url === `${secret}?wait=true`)
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  const storedBuckets = (script = MAIN) => {
    const stored = (store.get("scripts") ?? {}) as Record<
      string,
      { buckets: { at: number; requests: number; errors: number; crashes: number }[] }
    >;
    return (stored[script]?.buckets ?? []).map((b) => ({
      at: b.at,
      requests: b.requests,
      errors: b.errors,
      crashes: b.crashes,
    }));
  };
  return {
    worker,
    aggEnv,
    contents,
    observed,
    storedBuckets,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe("mixed-age traces in one invocation keep their event-time buckets (aggregator path)", () => {
  it("reversed old-plus-new crashes feed one observe per bucket, oldest first, and do not page", async () => {
    const f = aggregatorFixture();
    await f.worker.tail(
      [...crashes(1, T), ...crashes(SPIKE_MIN_CRASHES - 1, t0)],
      f.aggEnv as never,
    );
    expect(f.contents()).toEqual([]);
    // Coalesced by bucket (not per trace, not one merged batch) and fed
    // chronologically despite the reversed input.
    expect(f.observed).toHaveLength(2);
    expect(f.observed.map((b) => Math.floor(b.at / BUCKET_MS) * BUCKET_MS)).toEqual([t0, T]);
    expect(f.observed.map((b) => b.crashes)).toEqual([SPIKE_MIN_CRASHES - 1, 1]);
    expect(f.storedBuckets()).toEqual([{ at: T, requests: 0, errors: 0, crashes: 1 }]);

    // The surviving new crash counts toward a genuine later spike.
    f.setNow(T + BUCKET_MS);
    await f.worker.tail(crashes(SPIKE_MIN_CRASHES - 1, T + BUCKET_MS), f.aggEnv as never);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T + BUCKET_MS).toISOString(),
    });
  });

  it("positive control: a genuine in-window spike in reversed order pages once via the aggregator", async () => {
    const f = aggregatorFixture();
    await f.worker.tail(
      [...crashes(1, T), ...crashes(2, T - 60_000), ...crashes(2, T - 240_000)],
      f.aggEnv as never,
    );
    expect(f.observed.map((b) => Math.floor(b.at / BUCKET_MS) * BUCKET_MS)).toEqual([
      T - 240_000,
      T - 60_000,
      T,
    ]);
    expect(f.contents()).toHaveLength(1);
    expect(f.contents()[0]).toMatchObject({
      event: "error.spike",
      build_sha: shaA,
      crashes: SPIKE_MIN_CRASHES,
      timestamp: new Date(T).toISOString(),
    });
    expect(JSON.stringify(f.contents())).not.toMatch(/never-send|BoomError|private-queue/);
  });
});

describe("alerts runbook documents event-time bucket ingestion", () => {
  it("the error.spike section distinguishes event-time buckets from invocation/arrival time", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    const start = runbook.indexOf("Aggregate spike alarm");
    const end = runbook.indexOf("Scheduled `/up` prober", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const section = runbook.slice(start, end);
    expect(section).toMatch(/event[- ]time|eventTimestamp/);
    expect(section).toMatch(/bucket/);
    expect(section).toMatch(/invocation|arrival|arrives/);
    expect(section).toMatch(/chronological|oldest|in (event-time )?order/);
  });
});
