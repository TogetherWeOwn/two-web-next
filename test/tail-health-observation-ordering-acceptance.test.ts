// Acceptance contract: health observation ordering is fenced by source
// timestamp, not arrival order.
//
// A delayed older healthy sample must not clear a newer outage (or its
// pending page attempt), and a delayed older red sample must not resurrect
// an outage a newer healthy sample already cleared. The tracker therefore
// persists a monotonic source-observation watermark: an observation whose
// source time is STRICTLY OLDER than the newest observation already applied
// is ignored before it can mutate the outage start, the pending attempt, or
// the cooldown. An ignored observation is a successful no-op (it returns
// null / an ok null response), never an error: the caller treats an
// aggregator error as "fall back to local counting", which would
// double-apply a merely stale sample.
//
// Equal timestamps are NOT strictly older, so they are processed normally:
// a same-time duplicate or retry (e.g. a healthy retry inside the same
// scheduled run, stamped with the same source time as the red run before
// it) still takes effect. This definition is pinned explicitly below.
//
// The watermark is part of the persisted state: it survives snapshot /
// restore and a Durable Object restart, a rejected persistence write rolls
// it back together with the rest of the state (an unpublished observation
// must not fence out a slightly older later one), and legacy persisted
// snapshots that predate the watermark load safely and establish the
// watermark from the first observation accepted after the restore.
//
// Assertions are behavioral only (return values, snapshot equality across an
// ignored observation, persisted-store equality, page timing). They do not
// name the watermark field, so any storage shape that satisfies the
// ordering contract passes. Hermetic: direct HealthTracker (the local
// fallback tracker) plus the real AlertAggregator over cloning fake
// storage. No live Durable Object, webhook, Worker, or network.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AlertAggregator, HEALTH_COOLDOWN_MS, HealthTracker } from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");

// ---------------------------------------------------------------------------
// Fake Durable Object storage: cloning, with a scriptable next-put rejection.
// ---------------------------------------------------------------------------
function fakeState() {
  const store = new Map<string, unknown>();
  let rejectNext = false;
  const state = {
    storage: {
      get: async (key: string) => {
        const value = store.get(key);
        return value === undefined ? undefined : structuredClone(value);
      },
      put: async (key: string, value: unknown) => {
        if (rejectNext) {
          rejectNext = false;
          throw new Error("storage put rejected");
        }
        store.set(key, structuredClone(value));
      },
    },
  };
  return {
    state,
    rejectNextPut: () => {
      rejectNext = true;
    },
    persisted: (key: string) => (store.has(key) ? structuredClone(store.get(key)) : undefined),
  };
}

function post(aggregator: AlertAggregator, path: string, body: unknown) {
  return aggregator.fetch(
    new Request(`https://aggregator.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

async function health(aggregator: AlertAggregator, ok: boolean, at: number) {
  const response = await post(aggregator, "/health", { ok, at });
  expect(response.ok).toBe(true);
  return (await response.json()) as null | { downMs: number; attemptId: string | null };
}

async function healthResult(
  aggregator: AlertAggregator,
  delivered: boolean,
  attemptId?: string | null,
) {
  const response = await post(aggregator, "/health-result", {
    delivered,
    ...(attemptId !== undefined ? { attemptId } : {}),
  });
  expect(response.ok).toBe(true);
  await response.body?.cancel();
}

async function expectObservationFailure(run: () => Promise<Response>) {
  let response: Response | undefined;
  let threw = false;
  try {
    response = await run();
  } catch {
    threw = true;
  }
  expect(threw || (response !== undefined && !response.ok)).toBe(true);
  if (response?.body) await response.body.cancel();
}

describe("local fallback tracker ignores strictly older observations", () => {
  it("a delayed older healthy sample keeps the newer outage and its pending attempt identity", () => {
    const tracker = new HealthTracker(() => t0);
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
    const attempt = tracker.pendingAttempt();
    expect(attempt).toEqual(expect.any(String));
    const beforeStale = tracker.snapshot();

    // Source-stamped a minute before the page was admitted: stale.
    expect(tracker.observe(true, t0 + 60_000)).toBeNull();
    expect(tracker.snapshot()).toEqual(beforeStale);
    expect(tracker.pendingAttempt()).toBe(attempt);

    // The original attempt still settles by its own identity, and a failed
    // delivery re-pages measured from the original outage start.
    tracker.resolve(false, attempt);
    expect(tracker.observe(false, t0 + 180_000)).toBe(180_000);
  });

  it("a delayed older red sample does not resurrect an outage a newer healthy sample cleared", () => {
    const tracker = new HealthTracker(() => t0);
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(true, t0 + 60_000)).toBeNull();
    const afterRecovery = tracker.snapshot();
    expect(afterRecovery.downSince).toBeNull();

    expect(tracker.observe(false, t0 + 30_000)).toBeNull();
    expect(tracker.snapshot()).toEqual(afterRecovery);

    // The next in-order red sample opens a fresh window at its own time:
    // not due at exactly two minutes, due one second later, measured from
    // the fresh start rather than the stale sample.
    expect(tracker.observe(false, t0 + 120_000)).toBeNull();
    expect(tracker.observe(false, t0 + 240_000)).toBeNull();
    expect(tracker.observe(false, t0 + 241_000)).toBe(121_000);
  });

  it("a delayed older healthy sample does not erase the outage behind an armed cooldown", () => {
    const tracker = new HealthTracker(() => t0);
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
    tracker.resolve(true, tracker.pendingAttempt());
    const afterDelivery = tracker.snapshot();
    expect(afterDelivery.cooldownUntil).toBe(t0 + 121_000 + HEALTH_COOLDOWN_MS);

    expect(tracker.observe(true, t0 + 100_000)).toBeNull();
    expect(tracker.snapshot()).toEqual(afterDelivery);

    // Still red once the cooldown lapses: the page is due immediately and
    // reports the full outage, because the stale healthy sample never
    // cleared the window.
    const afterCooldown = t0 + 121_000 + HEALTH_COOLDOWN_MS + 1_000;
    expect(tracker.observe(false, afterCooldown)).toBe(afterCooldown - t0);
  });

  it("equal-timestamp observations are processed, not ignored (explicit definition)", () => {
    const tracker = new HealthTracker(() => t0);
    expect(tracker.observe(false, t0)).toBeNull();
    // A duplicate red at the same source time does not restart the window.
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.snapshot().downSince).toBe(t0);
    // A healthy retry stamped with the same source time still recovers.
    expect(tracker.observe(true, t0)).toBeNull();
    expect(tracker.snapshot().downSince).toBeNull();
    // And a red at that same time opens a window that pages on schedule.
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
  });

  it("positive control: in-order healthy samples still recover and a fresh window pages on schedule", () => {
    const tracker = new HealthTracker(() => t0);
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(true, t0 + 60_000)).toBeNull();
    expect(tracker.snapshot().downSince).toBeNull();
    expect(tracker.observe(false, t0 + 120_000)).toBeNull();
    expect(tracker.observe(false, t0 + 240_000)).toBeNull();
    expect(tracker.observe(false, t0 + 241_000)).toBe(121_000);
  });
});

describe("watermark persistence: snapshot/restore and legacy state", () => {
  it("the watermark survives a snapshot/restore roundtrip", () => {
    const first = new HealthTracker(() => t0);
    expect(first.observe(false, t0)).toBeNull();
    expect(first.observe(false, t0 + 121_000)).toBe(121_000);
    const snap = first.snapshot();

    const restored = new HealthTracker(() => t0);
    restored.restore(structuredClone(snap));
    expect(restored.snapshot()).toEqual(snap);

    expect(restored.observe(true, t0 + 60_000)).toBeNull();
    expect(restored.snapshot()).toEqual(snap);

    restored.resolve(false, restored.pendingAttempt());
    expect(restored.observe(false, t0 + 180_000)).toBe(180_000);
  });

  it("a legacy snapshot without a watermark loads safely and pages on the original schedule", () => {
    const tracker = new HealthTracker(() => t0);
    // The pre-watermark persisted shape, exactly as older code wrote it.
    tracker.restore({ downSince: t0, cooldownUntil: 0, pendingAt: null });
    expect(tracker.snapshot().downSince).toBe(t0);
    expect(tracker.observe(false, t0 + 120_000)).toBeNull();
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
  });

  it("a legacy cleared snapshot loads safely and a later outage pages normally", () => {
    const tracker = new HealthTracker(() => t0);
    tracker.restore({ downSince: null, cooldownUntil: 0, pendingAt: null });
    expect(tracker.observe(false, t0)).toBeNull();
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
  });

  it("after a legacy restore, the first accepted observation establishes the watermark", () => {
    const tracker = new HealthTracker(() => t0);
    tracker.restore({ downSince: t0, cooldownUntil: 0, pendingAt: null });
    expect(tracker.observe(false, t0 + 121_000)).toBe(121_000);
    const established = tracker.snapshot();

    expect(tracker.observe(true, t0 + 60_000)).toBeNull();
    expect(tracker.snapshot()).toEqual(established);
  });
});

describe("aggregator health path fences out-of-order observations", () => {
  it("a delayed older healthy sample keeps the persisted outage and pending attempt", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    const page = await health(aggregator, false, t0 + 121_000);
    expect(page).toMatchObject({ downMs: 121_000 });
    expect(page?.attemptId).toEqual(expect.any(String));
    const persistedBefore = fake.persisted("health");

    // Ignored observations are a successful no-op, and publish nothing.
    expect(await health(aggregator, true, t0 + 60_000)).toBeNull();
    expect(fake.persisted("health")).toEqual(persistedBefore);

    await healthResult(aggregator, false, page?.attemptId);
    expect(await health(aggregator, false, t0 + 180_000)).toMatchObject({ downMs: 180_000 });
  });

  it("a delayed older red sample does not resurrect a cleared persisted window", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    expect(await health(aggregator, true, t0 + 60_000)).toBeNull();
    const persistedAfterRecovery = fake.persisted("health");

    expect(await health(aggregator, false, t0 + 30_000)).toBeNull();
    expect(fake.persisted("health")).toEqual(persistedAfterRecovery);

    expect(await health(aggregator, false, t0 + 120_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 241_000)).toMatchObject({ downMs: 121_000 });
  });

  it("the watermark survives a Durable Object restart over the same store", async () => {
    const fake = fakeState();
    const first = new AlertAggregator(fake.state as never);
    expect(await health(first, false, t0)).toBeNull();
    const page = await health(first, false, t0 + 121_000);
    expect(page).toMatchObject({ downMs: 121_000 });
    const persistedBefore = fake.persisted("health");

    const restarted = new AlertAggregator(fake.state as never);
    expect(await health(restarted, true, t0 + 60_000)).toBeNull();
    expect(fake.persisted("health")).toEqual(persistedBefore);

    await healthResult(restarted, false, page?.attemptId);
    expect(await health(restarted, false, t0 + 180_000)).toMatchObject({ downMs: 180_000 });
  });

  it("a rejected observation write does not advance the watermark past the unpublished sample", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    const persistedBefore = fake.persisted("health");

    // This red sample would admit a page, but its write is rejected: it is
    // unpublished, so it must not fence out a later sample stamped before
    // it but after the last persisted observation.
    fake.rejectNextPut();
    await expectObservationFailure(() =>
      post(aggregator, "/health", { ok: false, at: t0 + 121_000 }),
    );
    expect(fake.persisted("health")).toEqual(persistedBefore);

    // Accepted (newer than the persisted watermark): recovery takes
    // effect, so the next red sample opens a fresh window.
    expect(await health(aggregator, true, t0 + 100_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 160_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 281_000)).toMatchObject({ downMs: 121_000 });
  });

  it("equal-timestamp observations are processed on the aggregator path too", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    expect(await health(aggregator, true, t0)).toBeNull();
    expect(await health(aggregator, false, t0)).toBeNull();
    expect(await health(aggregator, false, t0 + 121_000)).toMatchObject({ downMs: 121_000 });
  });

  it("positive control: an in-order healthy sample still recovers through the aggregator", async () => {
    const fake = fakeState();
    const aggregator = new AlertAggregator(fake.state as never);
    expect(await health(aggregator, false, t0)).toBeNull();
    expect(await health(aggregator, true, t0 + 60_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 120_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 240_000)).toBeNull();
    expect(await health(aggregator, false, t0 + 241_000)).toMatchObject({ downMs: 121_000 });
  });
});

describe("runbook", () => {
  it("the alerts runbook documents health observation ordering", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    expect(runbook).toMatch(/observation ordering|older observations|out-of-order|watermark/i);
  });
});
