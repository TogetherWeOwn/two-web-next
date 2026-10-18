// Acceptance contract: webhook delivery attempts settle independently of
// response-body cleanup, for both the ordinary Tail pager and the
// scheduled (synthetic prober) pager.
//
// A webhook POST is uncooperative in three ways here: the fetch promise
// never settles (ignoring its AbortSignal), the response body's cancel()
// never settles, or cancel() rejects. The attempt must settle on an
// independent deadline well within the harness bound below (the
// long-standing per-attempt budget is 5 s), the delivery verdict must
// come from the HTTP response alone — a known 2xx stays delivered (and
// muted) no matter what cleanup does — and a timed-out attempt must free
// the pending mute reservation so a later attempt can page. Response
// cleanup is still attempted, but its outcome never reaches a receipt,
// a mute decision, or the process as an unhandled rejection.
//
// Negative controls named in the titles: an abort-only wait (fetch that
// ignores its signal) and cleanup-overrides-success (rejecting/never
// settling cancel on a 2xx) must both be impossible. Non-2xx and
// redirect responses stay failures and stay unmuted.
//
// All fetches are injected hermetic stubs, deadlines are fake timers,
// and receipts/payloads are checked to carry no secret material.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryMute, createTailWorker } from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
// One webhook attempt must settle well within 30 s of fake time (budget 5 s).
const ATTEMPT_BOUND_MS = 30_000;
// A scheduled synthetic run also waits out the 10 s probe retry delay.
const SCHEDULED_BOUND_MS = 45_000;

const requestAlert = {
  level: "critical",
  event: "error.alert",
  fingerprint: "TypeError@/join",
  route: "/join",
  exception: "password=never-send",
};

const alertTrace = () => ({
  scriptName: "two-web-next",
  logs: [{ message: [JSON.stringify(requestAlert)], timestamp: t0, level: "error" }],
});

const env = { OPS_ALERT_WEBHOOK_URL: secret };
const scheduledEnv = {
  OPS_ALERT_WEBHOOK_URL: secret,
  UPTIME_URL: "https://next.togetherweown.com/up",
};

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
// implementation would leave pending forever: failures must fail fast
// (on the tracked assertion), not hang on the test timeout.
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

// Drive a run to settlement within a fake-time bound. Real async work
// (alert parsing uses subtle crypto, whose threadpool time varies with
// host load) must first reach the attempt — signalled by a pending fake
// timer (a settlement deadline, or the injected retry sleep) — before
// the fake-time budget starts counting; counting it during parsing
// would make the bound flaky on a loaded runner. Then advance the fake
// clock in chunks, interleaved with real progress, until the caller
// settles or the bound is spent.
async function driveUntilSettled(state: { settled: boolean }, budgetMs: number): Promise<void> {
  for (let i = 0; i < 2000 && !state.settled && vi.getTimerCount() === 0; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
  let elapsed = 0;
  while (!state.settled && elapsed <= budgetMs) {
    await vi.advanceTimersByTimeAsync(500);
    elapsed += 500;
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
  for (let i = 0; i < 50 && !state.settled; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(0);
  }
}

type CancelMode = "resolve" | "reject" | "never";

// A minimal Response stand-in exposing exactly what delivery reads
// (ok/status/headers/body.cancel), with cancel's behavior under test
// control. The rejection deliberately names the secret: it must never
// reach a payload, a receipt, or an unhandled rejection.
function fakeResponse(status: number, cancelMode: CancelMode) {
  const cancel = vi.fn(async () => {
    if (cancelMode === "never") return new Promise<void>(() => {});
    if (cancelMode === "reject") throw new Error(`cleanup failed for ${secret}`);
  });
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: { cancel },
  } as unknown as Response;
  return { response, cancel };
}

function makeWorker(send: ReturnType<typeof vi.fn>) {
  const sink = vi.fn();
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => t0),
    now: () => t0,
    // Route every implementation wait through the fake timer queue so
    // advancing fake time controls each deadline mechanism equally.
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const receipts = () => sink.mock.calls.map(([line]) => JSON.parse(line as string));
  const posts = () =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([, init]) => init?.method === "POST",
    );
  return { worker, sink, receipts, posts };
}

function watchUnhandled() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown) => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    unhandled,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

beforeEach(() => {
  // Fake only the deadline clocks; leave setImmediate/queueMicrotask real.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("acceptance: ordinary Tail webhook attempts settle independently of cleanup", () => {
  it("control: an immediate 2xx with clean cleanup delivers once and mutes the repeat", async () => {
    const send = vi.fn(async () => fakeResponse(200, "resolve").response);
    const { worker, receipts, posts } = makeWorker(send);
    const first = worker.tail([alertTrace()], env);
    const firstState = tracked(first);
    await driveUntilSettled(firstState, ATTEMPT_BOUND_MS);
    expect(firstState.settled).toBe(true);
    await first;
    const second = worker.tail([alertTrace()], env);
    const secondState = tracked(second);
    await driveUntilSettled(secondState, ATTEMPT_BOUND_MS);
    expect(secondState.settled).toBe(true);
    await second;
    expect(posts()).toHaveLength(1);
    expect(receipts()).toMatchObject([{ event: "error.alert", delivery: "ops.alert.delivered" }]);
  });

  it("abort-only negative control: a never-settling send that ignores its signal expires as failed and frees the reservation for a later page", async () => {
    const hanging = deferred<Response>();
    let call = 0;
    const send = vi.fn(async () => {
      call += 1;
      return call === 1 ? hanging.promise : fakeResponse(200, "resolve").response;
    });
    const { worker, receipts, posts } = makeWorker(send);
    const first = worker.tail([alertTrace()], env);
    const firstState = tracked(first);
    await driveUntilSettled(firstState, ATTEMPT_BOUND_MS);
    expect(firstState.settled).toBe(true);
    await first;
    expect(posts()).toHaveLength(1);
    const [target, init] = posts()[0]!;
    expect(target).toBe(`${secret}?wait=true`);
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(receipts()).toMatchObject([
      { event: "error.alert", delivery: "ops.alert.delivery_failed" },
    ]);
    // The timed-out attempt freed the pending reservation: the same
    // fingerprint pages again, and this time succeeds.
    const second = worker.tail([alertTrace()], env);
    const secondState = tracked(second);
    await driveUntilSettled(secondState, ATTEMPT_BOUND_MS);
    expect(secondState.settled).toBe(true);
    await second;
    expect(posts()).toHaveLength(2);
    expect(receipts()[1]).toMatchObject({ delivery: "ops.alert.delivered" });
  });

  it("a late send settlement after the deadline cannot flip the verdict, mute the fingerprint, or leak an unhandled rejection", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      // Late resolution with a 2xx: the attempt already counted as failed.
      const lateOk = deferred<Response>();
      let okCall = 0;
      const sendOk = vi.fn(async () => {
        okCall += 1;
        return okCall === 1 ? lateOk.promise : fakeResponse(200, "resolve").response;
      });
      const first = makeWorker(sendOk);
      const run = first.worker.tail([alertTrace()], env);
      const state = tracked(run);
      await driveUntilSettled(state, ATTEMPT_BOUND_MS);
      expect(state.settled).toBe(true);
      await run;
      expect(first.receipts()).toMatchObject([{ delivery: "ops.alert.delivery_failed" }]);
      lateOk.resolve(fakeResponse(200, "resolve").response);
      const retry = first.worker.tail([alertTrace()], env);
      const retryState = tracked(retry);
      await driveUntilSettled(retryState, ATTEMPT_BOUND_MS);
      expect(retryState.settled).toBe(true);
      await retry;
      // The late 2xx did not mute: a fresh attempt was made and delivered.
      expect(first.posts()).toHaveLength(2);
      expect(first.receipts()[1]).toMatchObject({ delivery: "ops.alert.delivered" });

      // Late rejection naming the secret: swallowed and never logged.
      const lateErr = deferred<Response>();
      const sendErr = vi.fn(async () => lateErr.promise);
      const second = makeWorker(sendErr);
      const run2 = second.worker.tail([alertTrace()], env);
      const state2 = tracked(run2);
      await driveUntilSettled(state2, ATTEMPT_BOUND_MS);
      expect(state2.settled).toBe(true);
      await run2;
      expect(second.receipts()).toMatchObject([{ delivery: "ops.alert.delivery_failed" }]);
      lateErr.reject(new Error(`transport died fetching ${secret}`));
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(second.sink.mock.calls)).not.toMatch(/test-only-token|never-send/);
    } finally {
      stop();
    }
  });

  it("cleanup-overrides-success negative control: a rejecting cancel cannot turn a 2xx into a failure, and the success still mutes", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const { response, cancel } = fakeResponse(200, "reject");
      const send = vi.fn(async () => response);
      const { worker, sink, receipts, posts } = makeWorker(send);
      const first = worker.tail([alertTrace()], env);
      const firstState = tracked(first);
      await driveUntilSettled(firstState, ATTEMPT_BOUND_MS);
      expect(firstState.settled).toBe(true);
      await first;
      expect(cancel).toHaveBeenCalled(); // Cleanup is attempted…
      expect(receipts()).toMatchObject([
        { event: "error.alert", delivery: "ops.alert.delivered" }, // …but cannot override the 2xx.
      ]);
      expect(JSON.stringify(sink.mock.calls)).not.toMatch(/test-only-token|never-send/);
      const second = worker.tail([alertTrace()], env);
      const secondState = tracked(second);
      await driveUntilSettled(secondState, ATTEMPT_BOUND_MS);
      expect(secondState.settled).toBe(true);
      await second;
      expect(posts()).toHaveLength(1); // Delivered means muted.
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      stop();
    }
  });

  it("a never-settling cancel cannot stall a 2xx: the caller settles, the page counts as delivered, and the repeat is muted", async () => {
    const { response, cancel } = fakeResponse(200, "never");
    const send = vi.fn(async () => response);
    const { worker, receipts, posts } = makeWorker(send);
    const first = worker.tail([alertTrace()], env);
    const firstState = tracked(first);
    await driveUntilSettled(firstState, ATTEMPT_BOUND_MS);
    expect(firstState.settled).toBe(true);
    await first;
    expect(cancel).toHaveBeenCalled();
    expect(receipts()).toMatchObject([{ delivery: "ops.alert.delivered" }]);
    const second = worker.tail([alertTrace()], env);
    const secondState = tracked(second);
    await driveUntilSettled(secondState, ATTEMPT_BOUND_MS);
    expect(secondState.settled).toBe(true);
    await second;
    expect(posts()).toHaveLength(1);
  });

  it("a redirect with a never-settling cancel still settles as a failure and does not mute", async () => {
    const { response } = fakeResponse(302, "never");
    const send = vi.fn(async () => response);
    const { worker, receipts, posts } = makeWorker(send);
    for (let i = 0; i < 2; i += 1) {
      const run = worker.tail([alertTrace()], env);
      const state = tracked(run);
      await driveUntilSettled(state, ATTEMPT_BOUND_MS);
      expect(state.settled).toBe(true);
      await run;
    }
    expect(posts()).toHaveLength(2); // 3xx is never ok: retried, never muted.
    expect(receipts()).toHaveLength(2);
    expect(receipts().every((r) => r.delivery === "ops.alert.delivery_failed")).toBe(true);
  });

  it("control: a non-2xx with a rejecting cancel settles as a failure and does not mute", async () => {
    const { response } = fakeResponse(500, "reject");
    const send = vi.fn(async () => response);
    const { worker, receipts, posts } = makeWorker(send);
    for (let i = 0; i < 2; i += 1) {
      const run = worker.tail([alertTrace()], env);
      const state = tracked(run);
      await driveUntilSettled(state, ATTEMPT_BOUND_MS);
      expect(state.settled).toBe(true);
      await run;
    }
    expect(posts()).toHaveLength(2);
    expect(receipts().every((r) => r.delivery === "ops.alert.delivery_failed")).toBe(true);
  });
});

describe("acceptance: scheduled webhook attempts settle independently of cleanup", () => {
  // /up and the page probes are healthy except /events, which fails
  // persistently, so every boundary run attempts exactly one
  // synthetic.down webhook POST through the scheduled delivery path.
  function scheduledSend(onPost: () => Promise<Response>) {
    return vi.fn(async (...args: [string, RequestInit?]) => {
      const [target, init] = args;
      if (init?.method === "POST") return onPost();
      const path = new URL(target).pathname;
      if (path === "/up")
        return new Response(null, { status: 200, headers: { "x-two-origin": "two-web-next" } });
      if (path === "/events") return new Response(null, { status: 503 });
      if (path === "/login")
        return new Response(null, { status: 302, headers: { location: "/auth/discord" } });
      return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
    });
  }

  const boundaryEvent = () => ({ cron: "* * * * *", scheduledTime: t0, noRetry() {} }) as never;

  async function runScheduled(worker: ReturnType<typeof makeWorker>["worker"]) {
    const run = worker.scheduled(boundaryEvent(), scheduledEnv);
    const state = tracked(run);
    await driveUntilSettled(state, SCHEDULED_BOUND_MS);
    return { run, state };
  }

  it("abort-only negative control: a never-settling scheduled send expires as failed and frees the reservation for the next run", async () => {
    const hanging = deferred<Response>();
    let post = 0;
    const send = scheduledSend(async () => {
      post += 1;
      return post === 1 ? hanging.promise : fakeResponse(200, "resolve").response;
    });
    const { worker, receipts, posts } = makeWorker(send);
    const first = await runScheduled(worker);
    expect(first.state.settled).toBe(true);
    await first.run;
    expect(posts()).toHaveLength(1);
    expect(posts()[0]![0]).toBe(`${secret}?wait=true`);
    expect(posts()[0]![1].redirect).toBe("manual");
    expect(receipts()).toMatchObject([
      { event: "synthetic.down", check: "/events", delivery: "ops.alert.delivery_failed" },
    ]);
    const second = await runScheduled(worker);
    expect(second.state.settled).toBe(true);
    await second.run;
    expect(posts()).toHaveLength(2); // Reservation freed: paged again, now delivered.
    expect(receipts()[1]).toMatchObject({
      event: "synthetic.down",
      delivery: "ops.alert.delivered",
    });
  });

  it("a never-settling cancel cannot stall a scheduled 2xx: the run settles, the page counts as delivered, and the next run is muted", async () => {
    const { response, cancel } = fakeResponse(200, "never");
    const send = scheduledSend(async () => response);
    const { worker, receipts, posts } = makeWorker(send);
    const first = await runScheduled(worker);
    expect(first.state.settled).toBe(true);
    await first.run;
    expect(cancel).toHaveBeenCalled();
    expect(receipts()).toMatchObject([
      { event: "synthetic.down", check: "/events", delivery: "ops.alert.delivered" },
    ]);
    const second = await runScheduled(worker);
    expect(second.state.settled).toBe(true);
    await second.run;
    expect(posts()).toHaveLength(1);
  });

  it("control: a rejecting cancel on a scheduled 2xx leaves the page delivered and muted", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const { response, cancel } = fakeResponse(200, "reject");
      const send = scheduledSend(async () => response);
      const { worker, sink, receipts, posts } = makeWorker(send);
      const first = await runScheduled(worker);
      expect(first.state.settled).toBe(true);
      await first.run;
      expect(cancel).toHaveBeenCalled();
      expect(receipts()).toMatchObject([
        { event: "synthetic.down", delivery: "ops.alert.delivered" },
      ]);
      expect(JSON.stringify(sink.mock.calls)).not.toContain("test-only-token");
      const second = await runScheduled(worker);
      expect(second.state.settled).toBe(true);
      await second.run;
      expect(posts()).toHaveLength(1);
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      stop();
    }
  });

  it("control: a scheduled redirect with a rejecting cancel settles as a failure and does not mute", async () => {
    const { response } = fakeResponse(302, "reject");
    const send = scheduledSend(async () => response);
    const { worker, receipts, posts } = makeWorker(send);
    for (let i = 0; i < 2; i += 1) {
      const attempt = await runScheduled(worker);
      expect(attempt.state.settled).toBe(true);
      await attempt.run;
    }
    expect(posts()).toHaveLength(2);
    expect(receipts()).toHaveLength(2);
    expect(receipts().every((r) => r.delivery === "ops.alert.delivery_failed")).toBe(true);
  });
});
