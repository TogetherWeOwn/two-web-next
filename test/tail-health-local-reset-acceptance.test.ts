import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  HealthTracker,
  createTailWorker,
} from "../tail/worker";

// Acceptance: a healthy scheduled probe must clear stale local outage
// state even when the durable aggregator handles that observation
// successfully. Today a successful aggregator response bypasses the
// local HealthTracker, so a fallback-red run, then an
// aggregator-handled healthy run, then another fallback-red run can
// page as if health had been continuously red since the first run.
// These tests drive the real scheduled worker with the real
// AlertAggregator Durable Object behind an availability toggle: when
// the toggle is off the stub answers 503 without applying anything,
// which is the unreachable-aggregator shape that takes the existing
// local fallback. Assertions are on actual webhook POSTs (and, for
// the stale-state contract, the injected local tracker's snapshot).

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const uptime = "https://example.test/up";

// Scheduled runs on a five-minute boundary also probe the synthetic
// main flows; answer those paths healthily so only /up drives the
// assertions. Returns null for the /up probe itself.
const healthySynthetic = (target: string): Response | null => {
  const path = new URL(target).pathname;
  if (path === "/up") return null;
  if (path === "/login") {
    return new Response(null, { status: 302, headers: { location: "/auth/discord" } });
  }
  return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
};

function fixture() {
  let now = t0;
  let upStatuses: number[] = [503];
  let lastUpStatus = 503;
  let aggregatorAvailable = false;
  let webhookStatuses: number[] = [];
  const forwardedHealth: { ok: boolean; at: number }[] = [];

  const store = new Map<string, unknown>();
  const aggregator = new AlertAggregator({
    storage: {
      get: async (key: string) => store.get(key),
      put: async (key: string, value: unknown) => {
        store.set(key, structuredClone(value));
      },
    },
  } as never);

  const send = vi.fn(async (...args: [string, RequestInit?]) => {
    const [target, init] = args;
    if (init?.method === "POST") {
      return new Response(null, { status: webhookStatuses.shift() ?? 200 });
    }
    const synthetic = healthySynthetic(target);
    if (synthetic) return synthetic;
    const status = upStatuses.shift() ?? lastUpStatus;
    lastUpStatus = status;
    return new Response(null, {
      status,
      headers: status === 200 ? { "x-two-origin": "two-web-next" } : undefined,
    });
  });
  const sink = vi.fn();
  const localHealth = new HealthTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    tracker: new AggregateTracker(() => now),
    health: localHealth,
    now: () => now,
    sleep: async () => {},
  });
  const env = {
    OPS_ALERT_WEBHOOK_URL: secret,
    UPTIME_URL: uptime,
    ALERT_AGGREGATOR: {
      idFromName: () => ({}),
      get: () => ({
        fetch: async (url: string, init?: RequestInit) => {
          if (!aggregatorAvailable) return new Response(null, { status: 503 });
          if (url.endsWith("/health") && typeof init?.body === "string") {
            forwardedHealth.push(JSON.parse(init.body) as { ok: boolean; at: number });
          }
          return aggregator.fetch(new Request(url, init));
        },
      }),
    },
  };
  const event = { cron: "* * * * *", scheduledTime: t0, noRetry() {} };

  const webhookPosts = () =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => url === `${secret}?wait=true`,
    );
  const pages = () =>
    webhookPosts()
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content))
      .filter((content) => content.event === "uptime.down");
  const receipts = () =>
    sink.mock.calls
      .map(([line]) => JSON.parse(line as string))
      .filter((line) => line.event === "uptime.down");

  return {
    localHealth,
    forwardedHealth,
    pages,
    receipts,
    webhookPosts,
    failNextWebhook: () => {
      webhookStatuses = [500];
    },
    run: async (
      offsetMs: number,
      opts: { up: number | number[]; aggregator: boolean },
    ): Promise<void> => {
      now = t0 + offsetMs;
      event.scheduledTime = now;
      upStatuses = Array.isArray(opts.up) ? [...opts.up] : [opts.up];
      aggregatorAvailable = opts.aggregator;
      await worker.scheduled(event, env as never);
    },
  };
}

describe("aggregator-handled recovery resets the local red window", () => {
  it("does not page when an aggregator-handled healthy probe separates two fallback-red runs", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(60_000, { up: 200, aggregator: true });
    // The healthy observation really reached the durable aggregator.
    expect(fx.forwardedHealth).toContainEqual({ ok: true, at: t0 + 60_000 });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(121_000, { up: 503, aggregator: false });
    // 121 s after the first red run but only the first red run of a
    // fresh window: no sustained-outage page yet.
    expect(fx.pages()).toHaveLength(0);
    expect(fx.receipts()).toHaveLength(0);
  });

  it("clears the stale local outage snapshot on an aggregator-handled healthy probe", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    expect(fx.localHealth.snapshot().downSince).toBe(t0);
    await fx.run(60_000, { up: 200, aggregator: true });
    expect(fx.localHealth.snapshot()).toEqual({
      downSince: null,
      cooldownUntil: 0,
      pendingAt: null,
      // The healthy observation establishes the ordering watermark at its
      // own source time, so a delayed older sample cannot reopen the window.
      lastObservedAt: t0 + 60_000,
    });
  });

  it("starts a fresh strict two-minute window after aggregator-handled recovery", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    await fx.run(60_000, { up: 200, aggregator: true });
    await fx.run(121_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(181_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    // Exactly 120 s into the fresh window: strictly-over gate, no page.
    await fx.run(241_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    // 121 s into the fresh window: the genuine sustained outage pages,
    // measured from the fresh window, not from the pre-recovery run.
    await fx.run(242_000, { up: 503, aggregator: false });
    expect(fx.pages()).toEqual([
      {
        event: "uptime.down",
        status: 503,
        down_seconds: 121,
        timestamp: new Date(t0 + 242_000).toISOString(),
      },
    ]);
    expect(fx.receipts()).toMatchObject([{ delivery: "ops.alert.delivered" }]);
  });

  it("does not page when recovery arrives on the in-run retry and the aggregator handles it", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    // First probe red, the retry inside the same run healthy.
    await fx.run(60_000, { up: [503, 200], aggregator: true });
    expect(fx.forwardedHealth).toContainEqual({ ok: true, at: t0 + 60_000 });
    await fx.run(121_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    expect(fx.receipts()).toHaveLength(0);
  });
});

describe("positive controls around the local reset", () => {
  it("continuous fallback red still pages only strictly past two minutes, then cools down", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    await fx.run(60_000, { up: 503, aggregator: false });
    await fx.run(120_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(121_000, { up: 503, aggregator: false });
    expect(fx.pages()).toEqual([
      {
        event: "uptime.down",
        status: 503,
        down_seconds: 121,
        timestamp: new Date(t0 + 121_000).toISOString(),
      },
    ]);
    await fx.run(181_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(1); // Delivered page armed the cooldown.
  });

  it("continuous aggregator-handled red still pages only strictly past two minutes", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: true });
    await fx.run(60_000, { up: 503, aggregator: true });
    await fx.run(120_000, { up: 503, aggregator: true });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(121_000, { up: 503, aggregator: true });
    expect(fx.pages()).toEqual([
      {
        event: "uptime.down",
        status: 503,
        down_seconds: 121,
        timestamp: new Date(t0 + 121_000).toISOString(),
      },
    ]);
    await fx.run(181_000, { up: 503, aggregator: true });
    expect(fx.pages()).toHaveLength(1);
  });

  it("a fallback-handled healthy probe already resets the local window (differential control)", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: false });
    await fx.run(60_000, { up: 200, aggregator: false });
    await fx.run(121_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(242_000, { up: 503, aggregator: false });
    expect(fx.pages()).toMatchObject([{ down_seconds: 121 }]);
  });

  it("an aggregator-handled healthy probe already resets the aggregator window (differential control)", async () => {
    const fx = fixture();
    await fx.run(0, { up: 503, aggregator: true });
    await fx.run(60_000, { up: 200, aggregator: true });
    await fx.run(121_000, { up: 503, aggregator: true });
    expect(fx.pages()).toHaveLength(0);
    await fx.run(242_000, { up: 503, aggregator: true });
    expect(fx.pages()).toMatchObject([{ down_seconds: 121 }]);
  });

  it("a failed fallback page delivery re-pages on the next red run (delivered-only cooldown)", async () => {
    const fx = fixture();
    fx.failNextWebhook();
    await fx.run(0, { up: 503, aggregator: false });
    await fx.run(60_000, { up: 503, aggregator: false });
    await fx.run(121_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(1);
    expect(fx.receipts()).toMatchObject([{ delivery: "ops.alert.delivery_failed" }]);
    await fx.run(181_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(2);
    expect(fx.receipts()).toMatchObject([
      { delivery: "ops.alert.delivery_failed" },
      { delivery: "ops.alert.delivered" },
    ]);
    await fx.run(242_000, { up: 503, aggregator: false });
    expect(fx.pages()).toHaveLength(2); // The delivered retry armed the cooldown.
  });
});
