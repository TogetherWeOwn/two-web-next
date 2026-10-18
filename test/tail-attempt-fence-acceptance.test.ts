// Acceptance contract: a retried aggregator result settles only the alert
// attempt it belongs to.
//
// The Tail worker posts each spike/health delivery result to the
// AlertAggregator Durable Object and retries a lost result exactly once.
// "Lost" has two shapes: the call fails before the DO applies it (the
// retry is then the first application), or the DO applies it but the
// acknowledgement is lost on the way back (the retry is then a duplicate
// of an already-settled attempt). Between the applied-but-unacknowledged
// result and its retry, a newer attempt can legitimately be admitted.
// The stale retry must never clear that newer attempt's pending marker
// or arm a cooldown on its behalf: observation creates an internal
// attempt identity, result handling settles only that attempt, and the
// identity never reaches the external alert payload.
//
// These tests drive the real createTailWorker path against the real
// AlertAggregator over fake storage. A scriptable stub sits between
// them: it can apply a result and then lose the acknowledgement, hold
// the bounded retry in flight while a newer attempt is admitted, hold
// a webhook delivery in flight, and swap in a fresh Durable Object
// instance over the same storage (snapshot/restore). No live webhook,
// Worker, or network. Assertions are collected before held gates are
// released, so a failing run reports instead of hanging.
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  AlertAggregator,
  DeliveryMute,
  HEALTH_COOLDOWN_MS,
  HealthTracker,
  SPIKE_COOLDOWN_MS,
  SPIKE_MIN_ERRORS,
  createTailWorker,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const sha = "0123456789abcdef0123456789abcdef01234567";
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";

const fetchTrace = (status: number, at: number) => ({
  scriptName: "two-web-next",
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

const burst = (at: number) => Array.from({ length: SPIKE_MIN_ERRORS }, () => fetchTrace(500, at));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

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

type ResultMode =
  // Every aggregator call is forwarded untouched.
  | "forward"
  // The first result call fails before the DO sees it; the retry applies.
  | "lose-before-apply"
  // The first result call is applied by the DO, then its acknowledgement
  // is lost; the retry is held in flight until the test releases it.
  | "apply-then-lose";

function harness(resultPath: "/spike-result" | "/health-result", mode: ResultMode) {
  let now = t0;
  const { state, store } = fakeState();
  let aggregator = new AlertAggregator(state as never);

  let resultCalls = 0;
  const retryStarted = deferred<undefined>();
  const retryGate = deferred<undefined>();

  const forward = (url: string, init?: RequestInit) =>
    aggregator.fetch(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: init?.body as string,
      }),
    );

  const stubFetch = async (url: string, init?: RequestInit): Promise<Response> => {
    if (!url.endsWith(resultPath) || mode === "forward") return forward(url, init);
    resultCalls += 1;
    if (resultCalls === 1) {
      if (mode === "apply-then-lose") {
        const applied = await forward(url, init);
        await applied.body?.cancel();
      }
      return new Response(null, { status: 503 });
    }
    if (resultCalls === 2 && mode === "apply-then-lose") {
      retryStarted.resolve(undefined);
      await retryGate.promise;
    }
    return forward(url, init);
  };

  // Webhook deliveries by POST index: first uses firstStatus, second is
  // held in flight until released with secondStatus, later ones succeed.
  // GETs are /up probes and always answer red.
  let posts = 0;
  let firstStatus = 500;
  let secondStatus = 500;
  const secondDeliveryStarted = deferred<undefined>();
  const secondDeliveryGate = deferred<undefined>();
  const send = vi.fn(async (...args: [string, RequestInit?]) => {
    const [, init] = args;
    if (init?.method !== "POST") return new Response(null, { status: 503 });
    posts += 1;
    if (posts === 1) return new Response(null, { status: firstStatus });
    if (posts === 2) {
      secondDeliveryStarted.resolve(undefined);
      await secondDeliveryGate.promise;
      return new Response(null, { status: secondStatus });
    }
    return new Response(null, { status: 200 });
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

  const env = {
    OPS_ALERT_WEBHOOK_URL: secret,
    UPTIME_URL: "https://example.test/up",
    ALERT_AGGREGATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: stubFetch }),
    },
  };

  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][])
      .filter(([, init]) => init?.method === "POST")
      .map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));

  return {
    worker,
    env: env as never,
    sink,
    store,
    contents,
    setNow: (at: number) => {
      now = at;
    },
    setDeliveryStatuses: (first: number, second: number) => {
      firstStatus = first;
      secondStatus = second;
    },
    retryStarted: retryStarted.promise,
    releaseRetry: () => retryGate.resolve(undefined),
    secondDeliveryStarted: secondDeliveryStarted.promise,
    releaseSecondDelivery: () => secondDeliveryGate.resolve(undefined),
    restartAggregator: () => {
      aggregator = new AlertAggregator(state as never);
    },
  };
}

// Minute 1 of the hour: off the five-minute synthetic boundary, so a
// scheduled run is health probing only.
const healthEvent = { cron: "* * * * *", scheduledTime: t0 + 60_000, noRetry() {} };

describe("retried spike results settle only their own attempt", () => {
  it("positive control: exact external payload, successful delivery arms the cooldown, and a later burst pages again", async () => {
    const h = harness("/spike-result", "forward");
    h.setDeliveryStatuses(200, 200);
    h.releaseSecondDelivery();
    await h.worker.tail(burst(t0), h.env);
    h.setNow(t0 + 60_000);
    await h.worker.tail(burst(t0 + 60_000), h.env);
    const afterCooldownBurst = h.contents().length;
    const later = t0 + SPIKE_COOLDOWN_MS + 60_000;
    h.setNow(later);
    await h.worker.tail(burst(later), h.env);
    expect(afterCooldownBurst).toBe(1);
    expect(h.contents()).toHaveLength(2);
    // The external payload is exactly the long-standing spike shape: the
    // fencing identity is internal and must not appear in it.
    expect(h.contents()[0]).toEqual({
      event: "error.spike",
      script: "two-web-next",
      build_sha: sha,
      logs: "Workers & Pages > two-web-next > Observability > Logs",
      window_seconds: 300,
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
      crashes: 0,
      error_rate: 1,
      timestamp: "2026-10-01T00:00:00.000Z",
    });
    expect(JSON.stringify(h.contents())).not.toMatch(/never-send|example\.test/);
  });

  it("positive control: a result lost before applying is applied by its retry, so a failed delivery reattempts", async () => {
    const h = harness("/spike-result", "lose-before-apply");
    h.releaseSecondDelivery();
    await h.worker.tail(burst(t0), h.env);
    await h.worker.tail(burst(t0 + 60_000), h.env);
    expect(h.contents()).toHaveLength(2);
    const receipts = h.sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
      { event: "error.spike", delivery: "ops.alert.delivery_failed" },
    ]);
  });

  it("A applied-then-lost, B admitted, A retry: C stays suppressed until B settles, then a failed B reattempts", async () => {
    const h = harness("/spike-result", "apply-then-lose");
    const aRun = h.worker.tail(burst(t0), h.env);
    await h.retryStarted; // A's failed result applied; its retry is held.
    h.setNow(t0 + 60_000);
    const bRun = h.worker.tail(burst(t0 + 60_000), h.env);
    await h.secondDeliveryStarted; // B admitted; its delivery is held.
    h.releaseRetry();
    await aRun; // A's stale retry has now landed against pending B.
    h.setNow(t0 + 120_000);
    await h.worker.tail(burst(t0 + 120_000), h.env); // C
    const pagesAfterC = h.contents().length;
    h.releaseSecondDelivery(); // B's delivery fails; B settles as failed.
    await bRun;
    h.setNow(t0 + 180_000);
    await h.worker.tail(burst(t0 + 180_000), h.env); // D reattempt after B.
    expect(pagesAfterC).toBe(2);
    expect(h.contents()).toHaveLength(3);
    expect(JSON.stringify(h.contents())).not.toMatch(/never-send|example\.test/);
  });

  it("the fence survives a Durable Object restart between B's admission and A's retry", async () => {
    const h = harness("/spike-result", "apply-then-lose");
    const aRun = h.worker.tail(burst(t0), h.env);
    await h.retryStarted;
    h.setNow(t0 + 60_000);
    const bRun = h.worker.tail(burst(t0 + 60_000), h.env);
    await h.secondDeliveryStarted;
    h.restartAggregator(); // Same storage, fresh instance: state restores.
    h.releaseRetry();
    await aRun;
    h.setNow(t0 + 120_000);
    await h.worker.tail(burst(t0 + 120_000), h.env); // C
    const pagesAfterC = h.contents().length;
    h.releaseSecondDelivery();
    await bRun;
    expect(pagesAfterC).toBe(2);
  });

  it("a stale delivered result never arms a cooldown for a newer attempt", async () => {
    const h = harness("/spike-result", "apply-then-lose");
    h.setDeliveryStatuses(200, 500); // A delivered; B will fail.
    const aRun = h.worker.tail(burst(t0), h.env);
    await h.retryStarted; // A's delivered result applied (cooldown armed).
    const bAt = t0 + SPIKE_COOLDOWN_MS + 60_000;
    h.setNow(bAt);
    const bRun = h.worker.tail(burst(bAt), h.env); // Past A's cooldown: B.
    await h.secondDeliveryStarted;
    h.releaseRetry();
    await aRun; // A's stale delivered retry lands against pending B.
    h.releaseSecondDelivery(); // B's own delivery fails; B settles failed.
    await bRun;
    h.setNow(bAt + 60_000);
    await h.worker.tail(burst(bAt + 60_000), h.env); // C reattempts B.
    expect(h.contents()).toHaveLength(3);
  });

  it("previously persisted spike state without an attempt identity still suppresses, then pages and settles after age-out", async () => {
    const h = harness("/spike-result", "forward");
    h.setDeliveryStatuses(200, 200);
    h.releaseSecondDelivery();
    // Snapshot shape written before attempt fencing existed.
    h.store.set("scripts", {
      "two-web-next": { buckets: [], cooldownUntil: 0, pendingAt: t0 },
    });
    h.setNow(t0 + 60_000);
    await h.worker.tail(burst(t0 + 60_000), h.env);
    const whileLegacyPending = h.contents().length;
    const later = t0 + SPIKE_COOLDOWN_MS + 60_000;
    h.setNow(later);
    await h.worker.tail(burst(later), h.env);
    h.setNow(later + 60_000);
    await h.worker.tail(burst(later + 60_000), h.env);
    expect(whileLegacyPending).toBe(0);
    expect(h.contents()).toHaveLength(1);
  });
});

describe("retried health results settle only their own attempt", () => {
  async function redRun(h: ReturnType<typeof harness>, at: number) {
    h.setNow(at);
    await h.worker.scheduled(healthEvent as never, h.env);
  }

  it("positive control: a result lost before applying is applied by its retry, so a failed delivery re-pages", async () => {
    const h = harness("/health-result", "lose-before-apply");
    h.releaseSecondDelivery();
    await redRun(h, t0);
    await redRun(h, t0 + 121_000); // A pages; delivery fails.
    await redRun(h, t0 + 181_000); // Reattempt pages again.
    expect(h.contents()).toHaveLength(2);
    expect(h.contents()[0]).toMatchObject({ event: "uptime.down", status: 503 });
    expect(Object.keys(h.contents()[0]).sort()).toEqual(
      ["down_seconds", "event", "status", "timestamp"].sort(),
    );
  });

  it("A applied-then-lost, B admitted, A retry: C stays suppressed until B settles, then a failed B re-pages", async () => {
    const h = harness("/health-result", "apply-then-lose");
    await redRun(h, t0);
    h.setNow(t0 + 121_000);
    const aRun = h.worker.scheduled(healthEvent as never, h.env);
    await h.retryStarted; // A's failed result applied; its retry is held.
    h.setNow(t0 + 181_000);
    const bRun = h.worker.scheduled(healthEvent as never, h.env);
    await h.secondDeliveryStarted; // B admitted; its delivery is held.
    h.releaseRetry();
    await aRun; // A's stale retry has now landed against pending B.
    await redRun(h, t0 + 241_000); // C
    const pagesAfterC = h.contents().length;
    h.releaseSecondDelivery(); // B's delivery fails; B settles as failed.
    await bRun;
    await redRun(h, t0 + 301_000); // D reattempt after B.
    expect(pagesAfterC).toBe(2);
    expect(h.contents()).toHaveLength(3);
  });

  it("the fence survives a Durable Object restart between B's admission and A's retry", async () => {
    const h = harness("/health-result", "apply-then-lose");
    await redRun(h, t0);
    h.setNow(t0 + 121_000);
    const aRun = h.worker.scheduled(healthEvent as never, h.env);
    await h.retryStarted;
    h.setNow(t0 + 181_000);
    const bRun = h.worker.scheduled(healthEvent as never, h.env);
    await h.secondDeliveryStarted;
    h.restartAggregator();
    h.releaseRetry();
    await aRun;
    await redRun(h, t0 + 241_000); // C
    const pagesAfterC = h.contents().length;
    h.releaseSecondDelivery();
    await bRun;
    expect(pagesAfterC).toBe(2);
  });

  it("a stale delivered health result never arms a cooldown for a newer attempt", async () => {
    const h = harness("/health-result", "apply-then-lose");
    h.setDeliveryStatuses(200, 500); // A delivered; B will fail.
    await redRun(h, t0);
    h.setNow(t0 + 121_000);
    const aRun = h.worker.scheduled(healthEvent as never, h.env);
    await h.retryStarted; // A's delivered result applied (cooldown armed).
    const bAt = t0 + 121_000 + HEALTH_COOLDOWN_MS + 60_000;
    h.setNow(bAt);
    const bRun = h.worker.scheduled(healthEvent as never, h.env); // B.
    await h.secondDeliveryStarted;
    h.releaseRetry();
    await aRun; // A's stale delivered retry lands against pending B.
    h.releaseSecondDelivery(); // B's own delivery fails; B settles failed.
    await bRun;
    await redRun(h, bAt + 60_000); // C reattempts B.
    expect(h.contents()).toHaveLength(3);
  });

  it("previously persisted health state without an attempt identity still suppresses, then pages and cools down after age-out", async () => {
    const h = harness("/health-result", "forward");
    h.setDeliveryStatuses(200, 200);
    h.releaseSecondDelivery();
    // Snapshot shape written before attempt fencing existed.
    h.store.set("health", { downSince: t0, cooldownUntil: 0, pendingAt: t0 + 121_000 });
    await redRun(h, t0 + 181_000);
    const whileLegacyPending = h.contents().length;
    const later = t0 + 121_000 + HEALTH_COOLDOWN_MS + 60_000;
    await redRun(h, later);
    await redRun(h, later + 60_000);
    expect(whileLegacyPending).toBe(0);
    expect(h.contents()).toHaveLength(1);
  });
});

describe("local fallback without the aggregator binding is preserved", () => {
  it("failed deliveries reattempt and delivered pages cool down on the per-isolate tracker", async () => {
    let posts = 0;
    const send = vi.fn(async () => {
      posts += 1;
      return new Response(null, { status: posts === 1 ? 500 : 200 });
    });
    const sink = vi.fn();
    const worker = createTailWorker({
      fetch: send as unknown as typeof fetch,
      sink,
      mute: new DeliveryMute(() => t0),
      tracker: new AggregateTracker(() => t0),
      now: () => t0,
      sleep: async () => {},
    });
    const env = { OPS_ALERT_WEBHOOK_URL: secret };
    await worker.tail(burst(t0), env as never); // A fails.
    await worker.tail(burst(t0 + 60_000), env as never); // B delivers.
    await worker.tail(burst(t0 + 120_000), env as never); // Cooling down.
    expect(posts).toBe(2);
  });
});
