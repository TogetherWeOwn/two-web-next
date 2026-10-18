// Acceptance contract: fingerprint paging stays live when the Tail
// aggregator stalls.
//
// The aggregator Durable Object binding can be uncooperative: a stub fetch
// that never settles (ignoring its AbortSignal), response headers followed
// by a JSON body that never settles, or a result acknowledgement that
// never settles. Each complete aggregator operation — request plus body
// parsing — must expire on an independent settlement deadline (cooperative
// abort stays on as cleanup only), take the existing local fallback, and
// let the fingerprint pager run. These tests drive the real
// createTailWorker path with hermetic stubs and fake timers: no live
// webhook, Worker, or network.
//
// Finite bound used below: one aggregator operation must settle well
// within 30 s of fake time (the long-standing per-call budget is 5 s);
// a result acknowledgement is two such attempts, so its total wait must
// settle well within 65 s. A stalled attempt counts as a failed attempt,
// so the acknowledgement still makes exactly one retry.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AggregateTracker, DeliveryMute, HealthTracker, createTailWorker } from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const ONE_OPERATION_MS = 30_000;
const ACK_TOTAL_MS = 65_000;

const alertLine = JSON.stringify({
  level: "critical",
  event: "error.alert",
  fingerprint: "TypeError@/join",
  route: "/join",
  exception: "password=never-send",
});

// One ordinary 200 fetch trace carrying an already-present error.alert.
const alertTrace = () => ({
  scriptName: "two-web-next",
  outcome: "ok",
  exceptions: [],
  eventTimestamp: t0,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status: 200 },
  },
  logs: [{ message: [alertLine], timestamp: t0, level: "error" }],
});

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Track settlement without awaiting a promise that a defective
// implementation would leave pending forever: the assertions below must
// fail fast, not hang on the test timeout.
function tracked(promise: Promise<unknown>) {
  const state = { settled: false };
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

// Let real async work (body streams, subtle crypto in alert parsing)
// run to completion without moving the fake deadline clocks.
async function flushAsync(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

function makeWorker(now: () => number, send: ReturnType<typeof vi.fn>) {
  const sink = vi.fn();
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(now),
    tracker: new AggregateTracker(now),
    health: new HealthTracker(now),
    now,
    // Route any implementation wait through the (fake) timer queue so
    // advancing fake time controls every deadline mechanism equally.
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const contents = () =>
    (send.mock.calls as unknown as [string, RequestInit][]).map(([, init]) =>
      JSON.parse(JSON.parse(init.body as string).content),
    );
  return { worker, sink, contents };
}

function aggregatorEnv(stubFetch: (...args: never[]) => unknown) {
  return {
    OPS_ALERT_WEBHOOK_URL: secret,
    UPTIME_URL: "https://next.togetherweown.com/up",
    ALERT_AGGREGATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: stubFetch }),
    },
  } as never;
}

beforeEach(() => {
  // Fake only the deadline clocks; leave setImmediate/queueMicrotask real
  // so Response body streams can still make progress.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("acceptance: stalled Tail aggregator never stalls fingerprint paging", () => {
  it("control: an immediately answering aggregator delivers the fingerprint page without any deadline", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const { worker, contents } = makeWorker(() => t0, send);
    const env = aggregatorEnv(async () => Response.json(null));
    const run = worker.tail([alertTrace()], env);
    const state = tracked(run);
    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();
    expect(state.settled).toBe(true);
    await run;
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({
      event: "error.alert",
      route: "/join",
    });
    expect(JSON.stringify(contents())).not.toMatch(/never-send|example\.test/);
  });

  it("control: an immediately rejecting aggregator falls back and delivers the fingerprint page", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const { worker, contents } = makeWorker(() => t0, send);
    const env = aggregatorEnv(async () => {
      throw new Error("aggregator down");
    });
    const run = worker.tail([alertTrace()], env);
    const state = tracked(run);
    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();
    expect(state.settled).toBe(true);
    await run;
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.alert" });
  });

  it("a never-settling observe fetch that ignores abort expires, falls back, and the fingerprint page is delivered once", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const { worker, contents } = makeWorker(() => t0, send);
    // Ignores the AbortSignal entirely: only an independent settlement
    // deadline can release the caller.
    const env = aggregatorEnv(() => new Promise<Response>(() => {}));
    const run = worker.tail([alertTrace()], env);
    const state = tracked(run);
    await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS);
    await flushAsync();
    expect(state.settled).toBe(true);
    await run;
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({
      event: "error.alert",
    });
    expect(JSON.stringify(contents())).not.toMatch(/never-send|example\.test/);
  });

  it("response headers followed by a stalled JSON body expire as one operation and the fingerprint page is delivered once", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const { worker, contents } = makeWorker(() => t0, send);
    const stalledBody = {
      ok: true,
      status: 200,
      json: () => new Promise<unknown>(() => {}),
    };
    const env = aggregatorEnv(async () => stalledBody as unknown as Response);
    const run = worker.tail([alertTrace()], env);
    const state = tracked(run);
    await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS);
    await flushAsync();
    expect(state.settled).toBe(true);
    await run;
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.alert" });
  });

  it("a stalled health call takes the local fallback, and the fallback still pages after two minutes red", async () => {
    // Scheduled slots at :01 and :03 keep the synthetic probes out of
    // this test; only the /up health path runs.
    let now = t0 + 60_000;
    const send = vi.fn(async (...args: [string, RequestInit?]) => {
      const [, init] = args;
      if (init?.method === "POST") return new Response(null, { status: 200 });
      return new Response(null, { status: 503 }); // /up is red.
    });
    const { worker, sink } = makeWorker(() => now, send);
    const env = aggregatorEnv(() => new Promise<Response>(() => {}));
    const event = { cron: "* * * * *", scheduledTime: t0 + 60_000, noRetry() {} };

    const first = worker.scheduled(event as never, env);
    const firstState = tracked(first);
    await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS + 15_000);
    await flushAsync();
    expect(firstState.settled).toBe(true);
    await first;
    expect(sink.mock.calls).toHaveLength(0); // First red run: no page yet.

    now += 121_000; // Red for over two minutes in the local fallback.
    const secondEvent = { cron: "* * * * *", scheduledTime: now, noRetry() {} };
    const second = worker.scheduled(secondEvent as never, env);
    const secondState = tracked(second);
    // The observe deadline and the two-attempt acknowledgement deadline
    // both have to expire inside this run.
    await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS + ACK_TOTAL_MS + 15_000);
    await flushAsync();
    expect(secondState.settled).toBe(true);
    await second;
    const receipts = sink.mock.calls.map(([line]) => JSON.parse(line as string));
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({
      event: "uptime.down",
      delivery: "ops.alert.delivered",
    });
    expect(receipts[0].down_seconds).toBeGreaterThanOrEqual(120);
  });

  it("a stalled spike acknowledgement makes exactly one retry, has a finite total wait, and never duplicates delivery", async () => {
    const send = vi.fn(async () => new Response(null, { status: 200 }));
    const { worker, contents, sink } = makeWorker(() => t0, send);
    const spike = {
      event: "error.spike",
      script: "two-web-next",
      logs: "Workers & Pages > two-web-next > Observability > Logs",
      window_seconds: 300,
      requests: 5,
      errors: 5,
      crashes: 0,
      error_rate: 1,
      timestamp: new Date(t0).toISOString(),
    };
    const ackCalls: Deferred<Response>[] = [];
    const env = aggregatorEnv(async (url: string) => {
      if (url.endsWith("/observe")) return Response.json(spike);
      const pending = deferred<Response>();
      ackCalls.push(pending);
      return pending.promise;
    });
    const trace = {
      scriptName: "two-web-next",
      outcome: "ok",
      exceptions: [],
      eventTimestamp: t0,
      event: {
        request: { method: "GET", url: "https://example.test/" },
        response: { status: 500 },
      },
      logs: [],
    };
    const run = worker.tail([trace], env);
    const state = tracked(run);
    await vi.advanceTimersByTimeAsync(ACK_TOTAL_MS);
    await flushAsync();
    expect(state.settled).toBe(true);
    await run;
    // The spike reached the webhook exactly once, the acknowledgement
    // was attempted exactly twice (initial + one retry), and the caller
    // still resolved with its delivery receipt.
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.spike" });
    expect(ackCalls).toHaveLength(2);
    expect(sink.mock.calls.map(([line]) => JSON.parse(line as string))).toMatchObject([
      { event: "error.spike", delivery: "ops.alert.delivered" },
    ]);
    // Late acknowledgement resolutions change nothing that already settled.
    for (const pending of ackCalls) pending.resolve(new Response("{}", { status: 200 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(contents()).toHaveLength(1);
    expect(sink.mock.calls).toHaveLength(1);
  });

  it("a late observe resolution or rejection after expiry cannot deliver twice or leak an unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Late resolution: the aggregator finally answers with a spike
      // after the caller already fell back and paged the fingerprint.
      const send = vi.fn(async () => new Response(null, { status: 200 }));
      const { worker, contents } = makeWorker(() => t0, send);
      const late = deferred<Response>();
      const env = aggregatorEnv(() => late.promise);
      const run = worker.tail([alertTrace()], env);
      const state = tracked(run);
      await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS);
      await flushAsync();
      expect(state.settled).toBe(true);
      await run;
      expect(contents()).toHaveLength(1);
      late.resolve(
        Response.json({
          event: "error.spike",
          script: "two-web-next",
          logs: "late",
          window_seconds: 300,
          requests: 99,
          errors: 99,
          crashes: 0,
          error_rate: 1,
          timestamp: new Date(t0).toISOString(),
        }),
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(contents()).toHaveLength(1);
      expect(contents()[0]).toMatchObject({ event: "error.alert" });

      // Late rejection: same shape, on a fresh worker.
      const send2 = vi.fn(async () => new Response(null, { status: 200 }));
      const second = makeWorker(() => t0, send2);
      const lateRejection = deferred<Response>();
      const env2 = aggregatorEnv(() => lateRejection.promise);
      const run2 = second.worker.tail([alertTrace()], env2);
      const state2 = tracked(run2);
      await vi.advanceTimersByTimeAsync(ONE_OPERATION_MS);
      await flushAsync();
      expect(state2.settled).toBe(true);
      await run2;
      expect(second.contents()).toHaveLength(1);
      lateRejection.reject(new Error("late aggregator failure"));
      await vi.advanceTimersByTimeAsync(0);
      // Give any unhandled rejection a chance to surface.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(second.contents()).toHaveLength(1);
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
