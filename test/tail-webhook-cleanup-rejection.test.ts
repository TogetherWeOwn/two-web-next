// Cleanup-rejection pin: supplementary proof that response-body cleanup
// rejection cannot surface as an unhandled rejection.
//
// Why plain functions: `vi.fn(async () => { throw ... })` records settled
// results by attaching its own `.then` to the returned promise, so the
// rejection is always handled and an `unhandledRejection` assertion can
// never fail. A rejecting `cancel()` built from a plain function with
// separately recorded calls leaves the rejection unhandled unless
// `cleanupResponse` (tail/worker.ts) attaches its own noop handler. Removing
// that handler makes the ordinary and scheduled cleanup tests fail. Removing
// `withDeliveryDeadline`'s explicit noop handler alone does not: its
// `Promise.race` already attaches a rejection handler to the work promise.
// The acceptance-owned file is intentionally untouched; this implementation-
// owned file pins C3/D5 with mutant-killing proof.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryMute, createTailWorker } from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const ATTEMPT_BOUND_MS = 30_000;
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

type CancelMode = "resolve" | "reject";

function fakeResponsePlain(status: number, cancelMode: CancelMode) {
  const cancelCalls: unknown[][] = [];
  const cancel = (...args: unknown[]): Promise<void> => {
    cancelCalls.push(args);
    if (cancelMode === "reject") return Promise.reject(new Error(`cleanup failed for ${secret}`));
    return Promise.resolve();
  };
  const response = {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(),
    body: { cancel },
  } as unknown as Response;
  return { response, cancelCalls };
}

type SendImpl = (target: string, init?: RequestInit) => Promise<Response>;

function makeWorkerPlain(sendImpl: SendImpl) {
  const sinkLines: string[] = [];
  const sink = (line: string): void => {
    sinkLines.push(line);
  };
  const sendCalls: [string, RequestInit?][] = [];
  const send = (target: string, init?: RequestInit): Promise<Response> => {
    sendCalls.push([target, init]);
    return sendImpl(target, init);
  };
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => t0),
    now: () => t0,
    sleep: (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
  });
  const receipts = () => sinkLines.map((line) => JSON.parse(line) as Record<string, unknown>);
  const posts = () => sendCalls.filter(([, init]) => init?.method === "POST");
  return { worker, sinkLines, sendCalls, receipts, posts };
}

function scheduledSendPlain(onPost: () => Promise<Response>): SendImpl {
  return async (target: string, init?: RequestInit) => {
    if (init?.method === "POST") return onPost();
    const path = new URL(target).pathname;
    if (path === "/up")
      return new Response(null, { status: 200, headers: { "x-two-origin": "two-web-next" } });
    if (path === "/events") return new Response(null, { status: 503 });
    if (path === "/login")
      return new Response(null, { status: 302, headers: { location: "/auth/discord" } });
    return new Response(null, { status: 200, headers: { "content-type": "text/html" } });
  };
}

function watchUnhandled() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return {
    unhandled,
    stop: () => process.off("unhandledRejection", onUnhandled),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("cleanup rejection is swallowed without unhandled rejection (plain stubs)", () => {
  it("ordinary 2xx with rejecting cancel stays delivered and muted with no unhandled rejection", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const { response, cancelCalls } = fakeResponsePlain(200, "reject");
      const { worker, sinkLines, receipts, posts } = makeWorkerPlain(async () => response);
      const first = worker.tail([alertTrace()], env);
      const firstState = tracked(first);
      await driveUntilSettled(firstState, ATTEMPT_BOUND_MS);
      expect(firstState.settled).toBe(true);
      await first;
      expect(cancelCalls.length).toBeGreaterThan(0);
      expect(receipts()).toMatchObject([{ event: "error.alert", delivery: "ops.alert.delivered" }]);
      expect(JSON.stringify(sinkLines)).not.toMatch(/test-only-token|never-send/);
      const second = worker.tail([alertTrace()], env);
      const secondState = tracked(second);
      await driveUntilSettled(secondState, ATTEMPT_BOUND_MS);
      expect(secondState.settled).toBe(true);
      await second;
      expect(posts()).toHaveLength(1);
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      stop();
    }
  });

  it("scheduled 2xx with rejecting cancel stays delivered and muted with no unhandled rejection", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const { response, cancelCalls } = fakeResponsePlain(200, "reject");
      const send = scheduledSendPlain(async () => response);
      const { worker, sinkLines, receipts, posts } = makeWorkerPlain(send);
      const boundaryEvent = () => ({ cron: "* * * * *", scheduledTime: t0, noRetry() {} }) as never;
      const firstRun = worker.scheduled(boundaryEvent(), scheduledEnv);
      const firstState = tracked(firstRun);
      await driveUntilSettled(firstState, SCHEDULED_BOUND_MS);
      expect(firstState.settled).toBe(true);
      await firstRun;
      expect(cancelCalls.length).toBeGreaterThan(0);
      expect(receipts()).toMatchObject([
        { event: "synthetic.down", delivery: "ops.alert.delivered" },
      ]);
      expect(JSON.stringify(sinkLines)).not.toContain("test-only-token");
      const secondRun = worker.scheduled(boundaryEvent(), scheduledEnv);
      const secondState = tracked(secondRun);
      await driveUntilSettled(secondState, SCHEDULED_BOUND_MS);
      expect(secondState.settled).toBe(true);
      await secondRun;
      expect(posts()).toHaveLength(1);
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      expect(unhandled).toEqual([]);
    } finally {
      stop();
    }
  });

  it("late send rejection naming the secret stays swallowed with no unhandled rejection", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const lateErr = deferred<Response>();
      const sendCalls: [string, RequestInit?][] = [];
      const send = (target: string, init?: RequestInit): Promise<Response> => {
        sendCalls.push([target, init]);
        return lateErr.promise;
      };
      const { worker, sinkLines, receipts } = makeWorkerPlain(send);
      const run = worker.tail([alertTrace()], env);
      const state = tracked(run);
      await driveUntilSettled(state, ATTEMPT_BOUND_MS);
      expect(state.settled).toBe(true);
      await run;
      expect(receipts()).toMatchObject([{ delivery: "ops.alert.delivery_failed" }]);
      lateErr.reject(new Error(`transport died fetching ${secret}`));
      for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(unhandled).toEqual([]);
      expect(JSON.stringify(sinkLines)).not.toMatch(/test-only-token|never-send/);
      expect(sendCalls.length).toBeGreaterThan(0);
    } finally {
      stop();
    }
  });
});
