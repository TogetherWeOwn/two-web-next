import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  type SpikeAlert,
  type TraceBatch,
  createTailWorker,
} from "../tail/worker";

// Independent acceptance contract: later invocations cannot rewind a script's
// retained event-time window. The existing 30-second bucket overlaps its cutoff
// while bucket.end > endpoint - five minutes; equal timestamps remain additive.
// Only the clock, storage and webhook transport are fakes. No live resources.
const NOW = Date.parse("2026-10-20T12:00:00.000Z");
const MINUTE = 60_000;
const BUCKET = 30_000;
const SCRIPT = "two-web-next";
const JOBS = "two-web-jobs";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const WEBHOOK = "https://discord.com/api/webhooks/123456789/test-only-token";

type Snapshot = ReturnType<AggregateTracker["snapshot"]>;
type WireSpike = SpikeAlert & { attemptId: string };
type Mode = "local" | "durable" | "unavailable";

function batch(at: number, crashes: number, overrides: Partial<TraceBatch> = {}): TraceBatch {
  return { script: SCRIPT, at, requests: 0, errors: 0, crashes, buildSha: SHA, ...overrides };
}

function counts(snapshot: Snapshot, script = SCRIPT) {
  return (snapshot[script]?.buckets ?? [])
    .map(({ at, requests, errors, crashes }) => ({ at, requests, errors, crashes }))
    .sort((a, b) => a.at - b.at);
}

function durableFixture(initial?: unknown) {
  const store = new Map<string, unknown>();
  if (initial !== undefined) store.set("scripts", structuredClone(initial));
  let rejectNext = false;
  const state = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error("fixture observation write rejected");
        }
        store.set(key, structuredClone(value));
      },
    },
  };
  let aggregator = new AlertAggregator(state as never);
  const forward = (url: string, init?: RequestInit) => aggregator.fetch(new Request(url, init));
  const post = (path: string, body: unknown) =>
    forward(`https://aggregator.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    forward,
    post,
    async observe(value: TraceBatch) {
      const response = await post("/observe", value);
      expect(response.status).toBe(200);
      return (await response.json()) as WireSpike | null;
    },
    async settle(attemptId: string, delivered: boolean) {
      const response = await post("/spike-result", { script: SCRIPT, attemptId, delivered });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    },
    snapshot: () => structuredClone(store.get("scripts") ?? {}) as Snapshot,
    restart: () => {
      aggregator = new AlertAggregator(state as never);
    },
    rejectNextPut: () => {
      rejectNext = true;
    },
  };
}

async function expectWriteFailure(request: Promise<Response>) {
  let rejected = false;
  let response: Response | undefined;
  try {
    response = await request;
  } catch {
    rejected = true;
  }
  expect(rejected || (response !== undefined && !response.ok)).toBe(true);
  await response?.body?.cancel();
}

function crashTraces(at: number, n: number, tag = SHA) {
  return Array.from({ length: n }, () => ({
    scriptName: SCRIPT,
    scriptVersion: { tag },
    outcome: "exception",
    exceptions: [{ name: "FixtureError", message: "not-for-the-alert", timestamp: at }],
    eventTimestamp: at,
    event: { queue: "fixture-queue", batchSize: 1 },
    logs: [],
  }));
}

function workerFixture(mode: Mode) {
  const durable = durableFixture();
  const tracker = new AggregateTracker(() => Date.now());
  const attempts: Record<string, unknown>[] = [];
  const delivered: Record<string, unknown>[] = [];
  let deliveryOk = true;
  const send = vi.fn(async (url: string, init?: RequestInit) => {
    expect(url).toBe(`${WEBHOOK}?wait=true`);
    const payload = JSON.parse(JSON.parse(init?.body as string).content) as Record<string, unknown>;
    attempts.push(payload);
    if (deliveryOk) delivered.push(payload);
    return new Response(null, { status: deliveryOk ? 200 : 503 });
  });
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: vi.fn(),
    tracker,
    mute: new DeliveryMute(() => Date.now()),
    now: () => Date.now(),
    sleep: async () => {},
  });
  const env = {
    OPS_ALERT_WEBHOOK_URL: WEBHOOK,
    ...(mode === "local"
      ? {}
      : {
          ALERT_AGGREGATOR: {
            idFromName: () => ({}),
            get: () => ({
              fetch: async (url: string, init?: RequestInit) =>
                mode === "unavailable"
                  ? new Response(null, { status: 503 })
                  : durable.forward(url, init),
            }),
          },
        }),
  };
  return {
    attempts,
    delivered,
    tail: (at: number, n: number, tag = SHA) => worker.tail(crashTraces(at, n, tag), env as never),
    snapshot: () => (mode === "durable" ? durable.snapshot() : tracker.snapshot()),
    restart: durable.restart,
    failDelivery: () => {
      deliveryOk = false;
    },
    recoverDelivery: () => {
      deliveryOk = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new Error("Unexpected network access in a hermetic Tail test");
    }),
  );
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("acceptance: per-script retained event-time windows", () => {
  it.each(["recent-first", "old-first"] as const)(
    "never combines four recent crashes with one six-minute-old crash (%s)",
    (order) => {
      const tracker = new AggregateTracker();
      const recent = batch(NOW, 4);
      const old = batch(NOW - 6 * MINUTE, 1);
      const arrivals = order === "recent-first" ? [recent, old] : [old, recent];
      for (const arrival of arrivals) expect(tracker.observe(arrival)).toBeNull();
      expect(tracker.observe(batch(NOW, 1))).toMatchObject({ crashes: 5, requests: 0, errors: 0 });
    },
  );

  it("does not retrospectively page an expired five-crash window after a newer healthy batch", () => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 0, { requests: 1 }))).toBeNull();
    expect(tracker.observe(batch(NOW - 6 * MINUTE, 5))).toBeNull();
    expect(tracker.observe(batch(NOW - MINUTE, 4))).toBeNull();
    expect(tracker.observe(batch(NOW, 1))).toMatchObject({ crashes: 5, requests: 1 });
  });

  it("still lets an in-window late crash complete the five-crash gate", () => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 4))).toBeNull();
    expect(tracker.observe(batch(NOW - MINUTE, 1))).toMatchObject({
      crashes: 5,
      requests: 0,
      errors: 0,
    });
  });

  it.each([
    {
      label: "one millisecond before the oldest overlapping bucket",
      age: 5 * MINUTE + 1,
      pages: false,
    },
    { label: "at the oldest overlapping bucket", age: 5 * MINUTE, pages: true },
    {
      label: "one millisecond inside the oldest overlapping bucket",
      age: 5 * MINUTE - 1,
      pages: true,
    },
  ])("preserves the bucket-end boundary $label", ({ age, pages }) => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 4))).toBeNull();
    const result = tracker.observe(batch(NOW - age, 1));
    if (pages) expect(result).toMatchObject({ crashes: 5 });
    else {
      expect(result).toBeNull();
      expect(counts(tracker.snapshot())).toEqual([{ at: NOW, requests: 0, errors: 0, crashes: 4 }]);
    }
  });

  it("keeps the endpoint at the newest event while later calls revisit an older live bucket", () => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 3))).toBeNull();
    expect(tracker.observe(batch(NOW - 4 * MINUTE, 1))).toBeNull();
    expect(tracker.observe(batch(NOW - 6 * MINUTE, 1))).toBeNull();
    expect(tracker.observe(batch(NOW - 4 * MINUTE + 1, 1))).toMatchObject({ crashes: 5 });
  });

  it("coalesces equal timestamps additively rather than rejecting the fifth observation as stale", () => {
    const tracker = new AggregateTracker();
    for (let n = 0; n < 4; n++) expect(tracker.observe(batch(NOW, 1))).toBeNull();
    expect(tracker.observe(batch(NOW, 1))).toMatchObject({ crashes: 5 });
    expect(counts(tracker.snapshot())).toEqual([{ at: NOW, requests: 0, errors: 0, crashes: 5 }]);
  });

  it.each([
    { requests: 9, pages: true },
    { requests: 10, pages: false },
  ])(
    "preserves the five-error and half-of-requests gates with $requests earlier requests",
    ({ requests, pages }) => {
      const tracker = new AggregateTracker();
      expect(tracker.observe(batch(NOW, 0, { requests, errors: 4 }))).toBeNull();
      const result = tracker.observe(batch(NOW - MINUTE, 0, { requests: 1, errors: 1 }));
      if (pages)
        expect(result).toMatchObject({ requests: 10, errors: 5, crashes: 0, error_rate: 0.5 });
      else expect(result).toBeNull();
    },
  );

  it("does not let stale insertions fill the cap and evict still-live error counts", () => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 0, { requests: 4, errors: 4 }))).toBeNull();
    // More than the existing 40-bucket cap, arriving in descending event time.
    for (let i = 0; i < 80; i++) {
      expect(
        tracker.observe(batch(NOW - 6 * MINUTE - i * BUCKET, 0, { requests: 100 })),
      ).toBeNull();
    }
    expect(tracker.observe(batch(NOW - MINUTE, 0, { requests: 1, errors: 1 }))).toMatchObject({
      requests: 5,
      errors: 5,
      crashes: 0,
      error_rate: 1,
    });
    expect(counts(tracker.snapshot())).toHaveLength(2);
  });

  it("retains only bounded live buckets after sustained stale traffic", () => {
    const tracker = new AggregateTracker();
    tracker.observe(batch(NOW, 4));
    for (let i = 0; i < 160; i++)
      tracker.observe(batch(NOW - 6 * MINUTE - i * BUCKET, 0, { requests: 1 }));
    expect(counts(tracker.snapshot())).toEqual([{ at: NOW, requests: 0, errors: 0, crashes: 4 }]);
  });

  it("advances endpoints per script, not globally across web and jobs", () => {
    const tracker = new AggregateTracker();
    expect(tracker.observe(batch(NOW, 4))).toBeNull();
    expect(tracker.observe(batch(NOW - MINUTE, 4, { script: JOBS }))).toBeNull();
    expect(tracker.observe(batch(NOW - 6 * MINUTE, 1, { script: JOBS }))).toMatchObject({
      script: JOBS,
      crashes: 5,
    });
    expect(tracker.observe(batch(NOW - 6 * MINUTE, 1))).toBeNull();
    expect(tracker.observe(batch(NOW, 1))).toMatchObject({ script: SCRIPT, crashes: 5 });
  });

  it.each([OTHER_SHA, undefined])(
    "expired healthy traffic cannot contaminate attribution (%s)",
    (buildSha) => {
      const tracker = new AggregateTracker();
      expect(tracker.observe(batch(NOW, 4))).toBeNull();
      expect(tracker.observe(batch(NOW - 6 * MINUTE, 0, { requests: 100, buildSha }))).toBeNull();
      expect(tracker.observe(batch(NOW - 4 * MINUTE, 1))).toMatchObject({
        crashes: 5,
        requests: 0,
        errors: 0,
        build_sha: SHA,
      });
    },
  );

  it.each([OTHER_SHA, undefined])(
    "in-window mixed or unknown attribution stays script-wide (%s)",
    (buildSha) => {
      const tracker = new AggregateTracker();
      expect(tracker.observe(batch(NOW, 4))).toBeNull();
      const alert = tracker.observe(batch(NOW - MINUTE, 1, { buildSha }));
      expect(alert).toMatchObject({ crashes: 5 });
      expect(alert).not.toHaveProperty("build_sha");
    },
  );

  it("round-trips the endpoint and homogeneous counts through a JSON snapshot", () => {
    const seeded = new AggregateTracker();
    expect(seeded.observe(batch(NOW, 4))).toBeNull();
    const restored = new AggregateTracker();
    restored.restore(JSON.parse(JSON.stringify(seeded.snapshot())));
    expect(restored.observe(batch(NOW - 6 * MINUTE, 1))).toBeNull();
    expect(restored.observe(batch(NOW - 4 * MINUTE, 1))).toMatchObject({
      crashes: 5,
      build_sha: SHA,
    });
  });
});

describe("acceptance: durable endpoint migration, rollback and settlement", () => {
  it.each(["old-first", "recent-first"] as const)(
    "derives a safe legacy endpoint from the newest retained bucket (%s)",
    async (order) => {
      // No new endpoint field is assumed. Compatible old counts/cooldown survive;
      // legacy provenance remains unknown. Array order is not the event-time order.
      const recent = { at: NOW, requests: 0, errors: 0, crashes: 4 };
      const old = { at: NOW - 6 * MINUTE, requests: 100, errors: 0, crashes: 0 };
      const fixture = durableFixture({
        [SCRIPT]: {
          buckets: order === "old-first" ? [old, recent] : [recent, old],
          cooldownUntil: 0,
        },
      });
      const alert = await fixture.observe(batch(NOW - 4 * MINUTE, 1));
      expect(alert).toMatchObject({ crashes: 5, requests: 0, errors: 0 });
      expect(alert).not.toHaveProperty("build_sha");
    },
  );

  it("keeps an empty legacy state eligible for a new first window", async () => {
    const fixture = durableFixture({ [SCRIPT]: { buckets: [], cooldownUntil: 0 } });
    expect(await fixture.observe(batch(NOW, 5))).toMatchObject({ crashes: 5, build_sha: SHA });
  });

  it("preserves a compatible legacy delivered cooldown", async () => {
    const fixture = durableFixture({
      [SCRIPT]: {
        buckets: [{ at: NOW, requests: 0, errors: 0, crashes: 4 }],
        cooldownUntil: NOW + 15 * MINUTE,
      },
    });
    expect(await fixture.observe(batch(NOW - MINUTE, 1))).toBeNull();
    fixture.restart();
    vi.setSystemTime(NOW + 15 * MINUTE + BUCKET);
    expect(await fixture.observe(batch(Date.now(), 5))).toMatchObject({
      crashes: 5,
      build_sha: SHA,
    });
  });

  it("preserves a compatible legacy pending marker when restoring the endpoint", async () => {
    const fixture = durableFixture({
      [SCRIPT]: {
        buckets: [{ at: NOW, requests: 0, errors: 0, crashes: 4 }],
        cooldownUntil: 0,
        pendingAt: NOW,
      },
    });
    expect(await fixture.observe(batch(NOW - MINUTE, 1))).toBeNull();
    fixture.restart();
    expect(await fixture.observe(batch(NOW - MINUTE, 1))).toBeNull();
  });

  it("restores the committed endpoint across cold starts and ignores expired arrivals", async () => {
    const fixture = durableFixture();
    expect(await fixture.observe(batch(NOW, 4))).toBeNull();
    fixture.restart();
    expect(await fixture.observe(batch(NOW - 6 * MINUTE, 1))).toBeNull();
    fixture.restart();
    expect(await fixture.observe(batch(NOW - 4 * MINUTE, 1))).toMatchObject({
      crashes: 5,
      build_sha: SHA,
    });
  });

  it("does not resurrect the old window after a healthy observation expires it and the DO restarts", async () => {
    const fixture = durableFixture();
    expect(await fixture.observe(batch(NOW - 6 * MINUTE, 4))).toBeNull();
    expect(await fixture.observe(batch(NOW, 0, { requests: 1 }))).toBeNull();
    fixture.restart();
    expect(await fixture.observe(batch(NOW - 6 * MINUTE + BUCKET, 5))).toBeNull();
    expect(await fixture.observe(batch(NOW, 5))).toMatchObject({ crashes: 5, requests: 1 });
  });

  it.each([false, true])(
    "rolls back a rejected newer endpoint, counts and pending attempt (restart=%s)",
    async (restart) => {
      const fixture = durableFixture();
      expect(await fixture.observe(batch(NOW, 4))).toBeNull();
      const committed = fixture.snapshot();
      vi.setSystemTime(NOW + 6 * MINUTE);
      fixture.rejectNextPut();
      await expectWriteFailure(fixture.post("/observe", batch(Date.now(), 5)));
      expect(fixture.snapshot()).toEqual(committed);
      if (restart) fixture.restart();
      // The failed observation never committed its future endpoint or pending
      // attempt; the original window must still accept this late fifth crash.
      expect(await fixture.observe(batch(NOW - MINUTE, 1))).toMatchObject({
        crashes: 5,
        build_sha: SHA,
      });
    },
  );

  it("rejecting an in-window write neither double-counts the retry nor forgets the newer endpoint", async () => {
    const fixture = durableFixture();
    expect(await fixture.observe(batch(NOW, 4))).toBeNull();
    const committed = fixture.snapshot();
    fixture.rejectNextPut();
    await expectWriteFailure(fixture.post("/observe", batch(NOW - MINUTE, 1)));
    expect(fixture.snapshot()).toEqual(committed);
    expect(await fixture.observe(batch(NOW - 6 * MINUTE, 1))).toBeNull();
    expect(await fixture.observe(batch(NOW - MINUTE, 1))).toMatchObject({ crashes: 5 });
  });

  it("keeps attempt fencing and retry totals intact while stale buckets arrive across a restart", async () => {
    const fixture = durableFixture();
    const first = await fixture.observe(batch(NOW, 5));
    expect(first?.attemptId).toEqual(expect.any(String));
    await fixture.settle(first!.attemptId, false);
    vi.setSystemTime(NOW + 1);
    const second = await fixture.observe(batch(NOW - BUCKET, 1));
    expect(second).toMatchObject({ crashes: 6 });
    expect(second?.attemptId).toEqual(expect.any(String));
    expect(second?.attemptId).not.toBe(first!.attemptId);
    fixture.restart();
    expect(await fixture.observe(batch(NOW - 6 * MINUTE, 50))).toBeNull();
    await fixture.settle(first!.attemptId, true);
    expect(await fixture.observe(batch(NOW - MINUTE, 1))).toBeNull();
    await fixture.settle(second!.attemptId, false);
    expect(await fixture.observe(batch(NOW - MINUTE - BUCKET, 1))).toMatchObject({ crashes: 8 });
  });
});

describe.each<Mode>(["local", "durable", "unavailable"])(
  "acceptance: separate Tail invocations via %s",
  (mode) => {
    it.each(["recent-first", "old-first"] as const)(
      "ignores expired crashes without suppressing the next valid page (%s)",
      async (order) => {
        const fixture = workerFixture(mode);
        const arrivals =
          order === "recent-first"
            ? [
                [NOW, 4],
                [NOW - 6 * MINUTE, 1],
              ]
            : [
                [NOW - 6 * MINUTE, 1],
                [NOW, 4],
              ];
        for (const [at, n] of arrivals) {
          await fixture.tail(at!, n!, OTHER_SHA);
          expect(fixture.attempts).toHaveLength(0);
        }
        expect(counts(fixture.snapshot())).toEqual([
          { at: NOW, requests: 0, errors: 0, crashes: 4 },
        ]);
        if (mode === "durable") fixture.restart();
        await fixture.tail(NOW - MINUTE, 1, OTHER_SHA);
        expect(fixture.delivered).toHaveLength(1);
        expect(fixture.delivered[0]).toMatchObject({
          event: "error.spike",
          script: SCRIPT,
          crashes: 5,
          requests: 0,
          errors: 0,
          window_seconds: 300,
          build_sha: OTHER_SHA,
        });
        expect(Object.keys(fixture.delivered[0]!).sort()).toEqual([
          "build_sha",
          "crashes",
          "error_rate",
          "errors",
          "event",
          "logs",
          "requests",
          "script",
          "timestamp",
          "window_seconds",
        ]);
        expect(JSON.stringify(fixture.delivered)).not.toContain("not-for-the-alert");
      },
    );

    it("retries a failed in-window page and starts cooldown only after delivery", async () => {
      const fixture = workerFixture(mode);
      await fixture.tail(NOW, 4);
      fixture.failDelivery();
      await fixture.tail(NOW - MINUTE, 1);
      expect(fixture.attempts.length).toBeGreaterThan(0);
      expect(fixture.delivered).toHaveLength(0);
      fixture.recoverDelivery();
      vi.setSystemTime(NOW + 1);
      await fixture.tail(NOW, 1);
      expect(fixture.delivered).toHaveLength(1);
      expect(fixture.delivered[0]).toMatchObject({ crashes: 6 });
      await fixture.tail(NOW + BUCKET, 5);
      expect(fixture.delivered).toHaveLength(1);
      vi.setSystemTime(NOW + 16 * MINUTE);
      await fixture.tail(Date.now(), 5);
      expect(fixture.delivered).toHaveLength(2);
      expect(fixture.delivered[1]).toMatchObject({ crashes: 5 });
    });

    it("does not let an expired arrival re-page retained old counts when the delivery cooldown ends", async () => {
      const fixture = workerFixture(mode);
      await fixture.tail(NOW, 5);
      expect(fixture.delivered).toHaveLength(1);
      vi.setSystemTime(NOW + 16 * MINUTE);
      await fixture.tail(NOW - 6 * MINUTE, 1);
      expect(fixture.delivered).toHaveLength(1);
      await fixture.tail(Date.now(), 5);
      expect(fixture.delivered).toHaveLength(2);
      expect(fixture.delivered[1]).toMatchObject({ crashes: 5 });
    });
  },
);
