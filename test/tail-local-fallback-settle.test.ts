import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  HealthTracker,
  SPIKE_MIN_ERRORS,
  createTailWorker,
} from "../tail/worker";

// A Durable Object reply lost after it applied: /observe (or /health) sets
// the DO pending attempt, then the answer never reaches the worker, so the
// worker falls back to a local page. The local result must still settle the
// orphaned DO attempt, or the failed delivery cannot retry until it ages
// out. Spike and health shapes mirror each other.

const t0 = Date.parse("2026-10-01T00:00:00Z");
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";

// Scheduled runs on a five-minute boundary also probe the synthetic main
// flows; health fixtures answer those paths healthily so only /up drives
// the assertions. Returns null for the /up probe itself.
const healthySynthetic = (target: string): Response | null => {
  const path = new URL(target).pathname;
  if (path === "/up") return null;
  if (path === "/login") {
    return new Response(null, { status: 302, headers: { location: "/auth/discord" } });
  }
  return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
};

const fetchTrace = (status: number, at = t0, scriptName = "two-web-next", tag: string = sha) => ({
  scriptName,
  scriptVersion: { tag },
  outcome: "ok",
  exceptions: [],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [],
});

function fakeState() {
  const store = new Map<string, unknown>();
  return {
    store,
    state: {
      storage: {
        get: async (key: string) => store.get(key),
        put: async (key: string, value: unknown) => {
          store.set(key, structuredClone(value));
        },
      },
    },
  };
}

describe("local fallback settles an applied-but-unacknowledged DO attempt", () => {
  // The first /observe applies the DO pending attempt, then its reply is
  // lost; every later call (including result posts) reaches the real DO.
  function appliedThenLostObserveEnv() {
    const { state } = fakeState();
    const aggregator = new AlertAggregator(state as never);
    let observeCalls = 0;
    return {
      OPS_ALERT_WEBHOOK_URL: secret,
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith("/observe")) {
              observeCalls += 1;
              const applied = await aggregator.fetch(new Request(url, init));
              if (observeCalls === 1) return new Response(null, { status: 503 });
              return applied;
            }
            return aggregator.fetch(new Request(url, init));
          },
        }),
      },
    };
  }

  it("a failed local spike delivery pages again on the next burst", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async () => {
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const aggEnv = appliedThenLostObserveEnv();
    const burst = (at: number) =>
      Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));
    await worker.tail(burst(t0), aggEnv as never);
    now = t0 + 60_000;
    await worker.tail(burst(t0 + 60_000), aggEnv as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
      { event: "error.spike", delivery: "ops.alert.delivered" },
    ]);
  });

  // The first three /health calls apply the DO pending marker, then lose
  // the reply; the local fallback warms its own red window over the same
  // runs and pages locally on the third. Later calls (including result
  // posts) reach the real DO.
  function appliedThenLostHealthEnv() {
    const { state } = fakeState();
    const aggregator = new AlertAggregator(state as never);
    let healthCalls = 0;
    return {
      OPS_ALERT_WEBHOOK_URL: secret,
      UPTIME_URL: "https://next.togetherweown.com/up",
      ALERT_AGGREGATOR: {
        idFromName: () => ({}),
        get: () => ({
          fetch: async (url: string, init?: RequestInit) => {
            if (url.endsWith("/health")) {
              healthCalls += 1;
              const applied = await aggregator.fetch(new Request(url, init));
              if (healthCalls <= 3) return new Response(null, { status: 503 });
              return applied;
            }
            return aggregator.fetch(new Request(url, init));
          },
        }),
      },
    };
  }

  it("a failed local health delivery re-pages on the next red run", async () => {
    let now = t0;
    let posts = 0;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method !== "POST") {
        return healthySynthetic(target) ?? new Response(null, { status: 503 });
      }
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => now),
      tracker: new AggregateTracker(() => now),
      health: new HealthTracker(() => now),
      now: () => now,
      sleep: async () => {},
    });
    const aggEnv = appliedThenLostHealthEnv();
    const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };
    await worker.scheduled(event, aggEnv as never);
    now += 61_000;
    await worker.scheduled(event, aggEnv as never);
    now += 60_000;
    await worker.scheduled(event, aggEnv as never); // 121 s red: page attempt, POST 500.
    now += 60_000;
    await worker.scheduled(event, aggEnv as never);
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "uptime.down", delivery: "ops.alert.delivery_failed" },
      { event: "uptime.down", delivery: "ops.alert.delivered" },
    ]);
  });
});
