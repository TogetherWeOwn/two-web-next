// Acceptance contract: a rejected initial storage load must not wedge the
// AlertAggregator Durable Object for the life of the instance.
//
// The aggregator restores its script counts and health window from storage
// on first use. If either read rejects (a transient storage fault), that
// request fails and the caller keeps its per-isolate fallback — but a later
// request on the SAME instance must retry the load once storage is healthy
// again, restoring the persisted counts/cooldowns/health state coherently.
// A successful load stays single-flight: it happens exactly once no matter
// how many requests follow, sequentially or concurrently. A failed load
// must never serve half-restored state or overwrite stored state with
// defaults: when only the second read fails, the already-read half may not
// be applied twice or leak into a snapshot write.
//
// These tests drive the real AlertAggregator (and, for the fallback pin,
// the real createTailWorker path) over scriptable fake storage that stays
// broken until the test heals it. No live webhook, Worker, or network.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  HEALTH_DOWN_MS,
  HealthTracker,
  SPIKE_MIN_ERRORS,
  createTailWorker,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";

// Persisted state seeded through the real trackers: three sub-threshold
// errors for two-web-next, and a health window that went red at t0.
function seedScripts() {
  const tracker = new AggregateTracker(() => t0);
  tracker.observe({
    script: "two-web-next",
    buildSha: sha,
    at: t0,
    requests: 3,
    errors: 3,
    crashes: 0,
  });
  return tracker.snapshot();
}

function seedHealth() {
  const health = new HealthTracker(() => t0);
  health.observe(false, t0);
  return health.snapshot();
}

type Deferred = { promise: Promise<void>; resolve: () => void };

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

// Fake Durable Object storage. Keys in `broken` reject on read until the
// test heals them; `gate`, when armed, holds every read in flight until
// released, so concurrent requests provably overlap one load attempt.
function fakeStorage() {
  const store = new Map<string, unknown>([
    ["scripts", structuredClone(seedScripts())],
    ["health", structuredClone(seedHealth())],
  ]);
  const broken = new Set<string>();
  const getCounts = new Map<string, number>();
  let putCount = 0;
  let gate: Deferred | null = null;
  const state = {
    storage: {
      get: async (key: string) => {
        getCounts.set(key, (getCounts.get(key) ?? 0) + 1);
        if (gate) await gate.promise;
        if (broken.has(key)) throw new Error(`storage read failed: ${key}`);
        return structuredClone(store.get(key));
      },
      put: async (key: string, value: unknown) => {
        putCount += 1;
        store.set(key, structuredClone(value));
      },
    },
  };
  return {
    store,
    state,
    breakKey: (key: string) => broken.add(key),
    heal: () => broken.clear(),
    getCount: (key: string) => getCounts.get(key) ?? 0,
    putCount: () => putCount,
    armGate: () => {
      gate = deferred();
    },
    releaseGate: () => {
      gate?.resolve();
      gate = null;
    },
  };
}

const observe = (aggregator: AlertAggregator, requests: number, errors: number, at = t0) =>
  aggregator.fetch(
    new Request("https://aggregator.invalid/observe", {
      method: "POST",
      body: JSON.stringify({
        script: "two-web-next",
        buildSha: sha,
        at,
        requests,
        errors,
        crashes: 0,
      }),
    }),
  );

const healthProbe = (aggregator: AlertAggregator, at: number) =>
  aggregator.fetch(
    new Request("https://aggregator.invalid/health", {
      method: "POST",
      body: JSON.stringify({ ok: false, at }),
    }),
  );

async function until(predicate: () => boolean, attempts = 100): Promise<void> {
  for (let i = 0; i < attempts && !predicate(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("recover after a rejected initial storage load", () => {
  it("retries the load on a later request to the same instance after the scripts read rejects, restoring persisted counts", async () => {
    const fake = fakeStorage();
    fake.breakKey("scripts");
    const aggregator = new AlertAggregator(fake.state as never);

    // While storage is broken the request fails (the caller falls back);
    // its batch must not be applied against unrestored state.
    await expect(observe(aggregator, 2, 2)).rejects.toThrow();

    fake.heal();
    const response = await observe(aggregator, 2, 2);
    expect(response.status).toBe(200);
    // The persisted three errors plus these two cross the threshold exactly:
    // the load restored stored counts instead of starting over, and the
    // failed attempt did not count its batch on top of them.
    expect(await response.json()).toMatchObject({
      event: "error.spike",
      errors: SPIKE_MIN_ERRORS,
      requests: SPIKE_MIN_ERRORS,
    });
  });

  it("restores scripts and health coherently when the second (health) read is the one that rejects", async () => {
    const fake = fakeStorage();
    fake.breakKey("health");
    const aggregator = new AlertAggregator(fake.state as never);

    // The scripts read succeeds, the health read rejects: the request fails
    // and the half-restored scripts state must not be applied twice later.
    await expect(healthProbe(aggregator, t0 + HEALTH_DOWN_MS + 1_000)).rejects.toThrow();

    fake.heal();
    // Health went red at the seeded t0, so this probe is due a page with a
    // pending attempt. Had the failed load reset the health window, the
    // red window would start at this probe and nothing would be due.
    const due = await healthProbe(aggregator, t0 + HEALTH_DOWN_MS + 1_000);
    expect(due.status).toBe(200);
    const dueBody = (await due.json()) as { downMs: number; attemptId?: unknown };
    expect(dueBody.downMs).toBe(HEALTH_DOWN_MS + 1_000);
    expect(typeof dueBody.attemptId).toBe("string");

    // The scripts half was readable during the failed load and is read again
    // on recovery; the seeded counts must still be exactly three, so two
    // more errors cross the threshold at five — not eight or ten.
    const alertResponse = await observe(aggregator, 2, 2);
    expect(await alertResponse.json()).toMatchObject({
      event: "error.spike",
      errors: SPIKE_MIN_ERRORS,
      requests: SPIKE_MIN_ERRORS,
    });
  });

  it("keeps failing while storage stays broken, then recovers on the first request after it heals", async () => {
    const fake = fakeStorage();
    fake.breakKey("scripts");
    const aggregator = new AlertAggregator(fake.state as never);

    await expect(observe(aggregator, 1, 1)).rejects.toThrow();
    // A second request during the same outage also fails — recovery is a
    // fresh load attempt per later request, not a cached rejection that
    // poisons the instance or a silent serve from empty state.
    await expect(observe(aggregator, 1, 1)).rejects.toThrow();

    fake.heal();
    const response = await observe(aggregator, 1, 1);
    expect(response.status).toBe(200);
    // Seeded three plus this one is still sub-threshold: no alert yet, and
    // the two failed batches were never counted.
    expect(await response.json()).toBeNull();
  });

  it("concurrent requests share one recovery load after a rejected first attempt", async () => {
    const fake = fakeStorage();
    fake.breakKey("scripts");
    const aggregator = new AlertAggregator(fake.state as never);
    await expect(observe(aggregator, 1, 0)).rejects.toThrow();

    fake.heal();
    const scriptsBefore = fake.getCount("scripts");
    const healthBefore = fake.getCount("health");
    fake.armGate();
    // Settle wrappers attach handlers synchronously: on a still-wedged
    // instance both fetches reject during the gate wait below, and a late
    // Promise.all would leak them as unhandled rejections.
    const settle = (promise: Promise<Response>): Promise<PromiseSettledResult<Response>> =>
      promise.then(
        (value) => ({ status: "fulfilled", value }),
        (reason: unknown) => ({ status: "rejected", reason }),
      );
    const first = settle(observe(aggregator, 1, 0));
    const second = settle(observe(aggregator, 1, 0));
    // Both requests are in flight against the gated read before it settles.
    await until(() => fake.getCount("scripts") > scriptsBefore);
    fake.releaseGate();
    const [firstSettled, secondSettled] = await Promise.all([first, second]);
    expect(firstSettled.status).toBe("fulfilled");
    expect(secondSettled.status).toBe("fulfilled");
    if (firstSettled.status !== "fulfilled" || secondSettled.status !== "fulfilled") return;
    expect(firstSettled.value.status).toBe(200);
    expect(secondSettled.value.status).toBe(200);
    // The recovery load ran once for both requests, not once per request.
    expect(fake.getCount("scripts") - scriptsBefore).toBe(1);
    expect(fake.getCount("health") - healthBefore).toBe(1);
  });

  it("a failed load writes nothing and leaves the stored scripts and health state untouched", async () => {
    const fake = fakeStorage();
    fake.breakKey("health");
    const aggregator = new AlertAggregator(fake.state as never);

    await expect(observe(aggregator, 2, 2)).rejects.toThrow();
    // Serving from half-restored state would persist a default health
    // snapshot (erasing the red window) or counts built on missing state.
    expect(fake.putCount()).toBe(0);
    expect(fake.store.get("scripts")).toEqual(seedScripts());
    expect(fake.store.get("health")).toEqual(seedHealth());
  });

  it("a successful load stays single-flight across later sequential and concurrent requests", async () => {
    const fake = fakeStorage();
    const aggregator = new AlertAggregator(fake.state as never);

    expect((await observe(aggregator, 1, 0)).status).toBe(200);
    const [a, b] = await Promise.all([observe(aggregator, 1, 0), observe(aggregator, 1, 0)]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect((await healthProbe(aggregator, t0)).status).toBe(200);
    expect(fake.getCount("scripts")).toBe(1);
    expect(fake.getCount("health")).toBe(1);
  });

  it("per-fingerprint paging still delivers while aggregator storage cannot load", async () => {
    const fake = fakeStorage();
    fake.breakKey("scripts");
    fake.breakKey("health");
    const aggregator = new AlertAggregator(fake.state as never);
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => t0),
      tracker: new AggregateTracker(() => t0),
      now: () => t0,
      sleep: async () => {},
    });
    const line = JSON.stringify({
      level: "critical",
      event: "error.alert",
      fingerprint: "TypeError@/join",
      route: "/join",
    });
    const brokenEnv = {
      OPS_ALERT_WEBHOOK_URL: secret,
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: (url: string, init?: RequestInit) => aggregator.fetch(new Request(url, init)),
        }),
      },
    };
    await expect(
      worker.tail(
        [
          {
            scriptName: "two-web-next",
            scriptVersion: { tag: sha },
            outcome: "ok",
            exceptions: [],
            eventTimestamp: t0,
            event: {
              request: { method: "GET", url: "https://example.test/private?token=never-send" },
              response: { status: 200 },
            },
            logs: [{ message: [line], timestamp: t0, level: "error" }],
          },
        ],
        brokenEnv as never,
      ),
    ).resolves.toBeUndefined();
    // The existing fingerprint delivery never depended on the aggregator
    // load: exactly one webhook POST, carrying the allowlisted summary only.
    expect(send).toHaveBeenCalledTimes(1);
    const [, init] = send.mock.calls[0] as unknown as [string, RequestInit];
    const content = JSON.parse(JSON.parse(init.body as string).content);
    expect(content).toMatchObject({ event: "error.alert", route: "/join" });
    expect(JSON.stringify(content)).not.toMatch(/never-send|example\.test/);
  });

  it("the alerts runbook documents transient initialization recovery", () => {
    const runbook = readFileSync("docs/runbook-alerts.md", "utf8");
    expect(runbook).toMatch(
      /(initial|first)[\s\S]{0,120}(storage|load|read)[\s\S]{0,240}(retr|recover)/i,
    );
  });
});
