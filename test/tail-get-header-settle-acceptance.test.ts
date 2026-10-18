// Acceptance contract: GET header waits in the Tail prober settle
// independently within the existing attempt budget.
//
// The /up probe and each synthetic main-flow probe await the injected
// fetch's headers with only AbortSignal.timeout as a bound. That signal
// is cooperative: a transport that never settles and ignores its signal
// leaves the await pending forever, so the second uptime attempt, the
// health observation, and every synthetic check queued behind the
// stalled one in the serial loop never run. Attribution body reads
// (after headers) already race an independent deadline; the header wait
// itself does not.
//
// Post-fix contract, under the existing prober policy — no new target,
// timeout value, retry count, cadence, threshold or channel:
// - Each /up and synthetic GET attempt settles within its existing
//   ten-second attempt budget even when the transport never resolves
//   and ignores abort. A header wait that expires is the existing
//   transport treatment: status 0, eligible for the existing second
//   attempt after the existing ten-second delay.
// - A stalled synthetic header wait cannot starve later routes: every
//   remaining check is still probed in the same run, the five-minute
//   synthetic cadence is unchanged, and a healthy run makes exactly
//   the same requests as today.
// - Late responses and late rejections from an expired attempt cannot
//   change the settled verdict, page twice, or surface as an
//   unhandled rejection. A late response gets best-effort inert body
//   cleanup (cancel attempted, never awaited, outcome swallowed), and
//   nothing from a late error reaches a receipt or a page.
// - The cooperative AbortSignal stays on every GET as cleanup; it is
//   just no longer the only bound.
//
// Positive controls (immediate answers and immediate transport
// rejections) pass before and after. The stall cases fail today
// because the scheduled run never settles: the settle assertions below
// fail fast on a tracked promise instead of hanging on the test
// timeout, so a red run reports "did not settle" rather than timing
// out.
//
// Why a plain send function: a `vi.fn(async ...)` records its own
// settled result, which handles rejections and would make the
// unhandled-rejection assertions vacuous. The injected fetch here is
// a plain function returning raw promises, so only production's own
// handling keeps a late rejection handled. Stalled attempts ignore
// `init.signal` entirely — that is the uncooperative transport this
// contract is about.
//
// Everything is hermetic: injected fetch/sleep/clock, fake deadline
// timers, no live webhook, database or network contact.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeliveryMute, createTailWorker } from "../tail/worker";

const timestamp = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const uptime = "https://next.togetherweown.com/up";
const upEnv = { OPS_ALERT_WEBHOOK_URL: secret, UPTIME_URL: uptime };
// The existing budgets, restated as literals so a change to either is
// visible as a behavior change here rather than silently following
// the production constant.
const ATTEMPT_BUDGET_MS = 10_000;
const RETRY_DELAY_MS = 10_000;
// Baked into every late failure: if a late error (or anything it
// names) ever reaches a receipt or a page, this marker surfaces it.
const lateSecret = `late transport failed for ${secret} body=never-send`;

type Probe = {
  status?: number;
  origin?: string | null;
  contentType?: string | null;
  location?: string | null;
};

type Behavior = ({ kind: "respond" } & Probe) | { kind: "stall" } | { kind: "reject" };

const respond = (probe: Probe): Behavior => ({ kind: "respond", ...probe });
const stall: Behavior = { kind: "stall" };
const reject: Behavior = { kind: "reject" };

const healthyUp = respond({ status: 200, origin: "two-web-next" });

const healthySynthetic = (path: string): Behavior => {
  if (path === "/login") return respond({ status: 302, location: "/auth/discord" });
  return respond({ status: 200, contentType: "text/html; charset=UTF-8" });
};

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let rejectFn!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    rejectFn = rej;
  });
  return { promise, resolve, reject: rejectFn };
}

type GetRecord = {
  path: string;
  signal: unknown;
  cancelCalls: number;
  stalled?: Deferred<Response>;
};

function fixture(
  upBehaviors: Behavior[] = [healthyUp],
  synthetic: Partial<Record<string, Behavior[]>> = {},
) {
  let now = timestamp;
  const sleeps: number[] = [];
  const gets: GetRecord[] = [];
  const posts: { target: string; body: unknown }[] = [];
  const sinkLines: string[] = [];
  const upQueue = [...upBehaviors];
  let lastUp: Behavior = upBehaviors[upBehaviors.length - 1] ?? healthyUp;
  const syntheticQueues = new Map(
    Object.entries(synthetic).map(([path, list]) => [path, [...(list ?? [])]]),
  );
  const lastSynthetic = new Map<string, Behavior>();

  const makeResponse = (record: GetRecord, probe: Probe): Response => {
    // Plain function on purpose: no test-framework tracking may handle
    // a cleanup promise for production.
    const cancel = (): Promise<void> => {
      record.cancelCalls += 1;
      return Promise.resolve();
    };
    const headers: Record<string, string> = {};
    if (probe.origin != null) headers["x-two-origin"] = probe.origin;
    if (probe.contentType != null) headers["content-type"] = probe.contentType;
    if (probe.location != null) headers.location = probe.location;
    const status = probe.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      body: { cancel },
    } as unknown as Response;
  };

  // Plain send (see header): returns the raw promise each behavior
  // dictates. A "stall" promise never settles on its own and never
  // reads init.signal, so cooperative abort cannot release it.
  const send = (target: string, init?: RequestInit): Promise<Response> => {
    if (init?.method === "POST") {
      posts.push({ target, body: init.body });
      return Promise.resolve(new Response(null, { status: 200 }));
    }
    const path = new URL(target).pathname;
    const record: GetRecord = { path, signal: init?.signal, cancelCalls: 0 };
    gets.push(record);
    let next: Behavior;
    if (path === "/up") {
      next = upQueue.shift() ?? lastUp;
      lastUp = next;
    } else {
      next =
        syntheticQueues.get(path)?.shift() ?? lastSynthetic.get(path) ?? healthySynthetic(path);
      lastSynthetic.set(path, next);
    }
    if (next.kind === "reject") return Promise.reject(new Error(lateSecret));
    if (next.kind === "stall") {
      record.stalled = deferred<Response>();
      return record.stalled.promise;
    }
    return Promise.resolve(makeResponse(record, next));
  };

  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink: (line: string): void => {
      sinkLines.push(line);
    },
    mute: new DeliveryMute(() => now),
    now: () => now,
    // Route every production wait through the (fake) timer queue so
    // advancing fake time controls deadlines and retry delays alike.
    sleep: (ms: number) => {
      sleeps.push(ms);
      return new Promise<void>((resolve) => setTimeout(resolve, ms));
    },
  });
  const event = { cron: "* * * * *", scheduledTime: timestamp, noRetry() {} };
  return {
    worker,
    gets,
    posts,
    sinkLines,
    sleeps,
    event,
    advance: (ms: number) => {
      now += ms;
      event.scheduledTime += ms; // The next cron slot is later by the same step.
    },
    // Settle a stalled attempt late, with a response whose body cleanup
    // is counted on the same record as the attempt that produced it.
    resolveStalled: (record: GetRecord, probe: Probe) => {
      record.stalled?.resolve(makeResponse(record, probe));
    },
    rejectStalled: (record: GetRecord) => {
      record.stalled?.reject(new Error(lateSecret));
    },
  };
}

type Fx = ReturnType<typeof fixture>;

const getsFor = (fx: Fx, path: string) => fx.gets.filter((g) => g.path === path);
const getPaths = (fx: Fx) => fx.gets.map((g) => g.path);
const pageContents = (fx: Fx) =>
  fx.posts.map((post) => JSON.parse(JSON.parse(post.body as string).content as string));
const everythingOutbound = (fx: Fx) =>
  JSON.stringify({ sink: fx.sinkLines, posts: fx.posts.map((p) => p.body) });

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

const flushMicrotasks = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

// Move fake time, then let real microtask/async work drain without
// moving the clocks again.
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
  await flushMicrotasks(5);
}

// Drive one scheduled run to settlement in 1 s fake-time steps. A run
// still pending after a generous fake budget (several full attempt +
// retry + delivery cycles) is stalled, not slow: fail with that
// evidence instead of hanging on the test timeout.
async function runScheduled(fx: Fx): Promise<void> {
  const run = fx.worker.scheduled(fx.event as never, upEnv);
  const state = tracked(run);
  await flushMicrotasks(5);
  for (let elapsed = 0; elapsed < 180_000 && !state.settled; elapsed += 1_000) {
    await advance(1_000);
  }
  expect(state.settled).toBe(true);
  await run;
}

// Three failing one-minute runs: health red for 121 s, past the >2 min gate.
async function runDownPastGate(fx: Fx) {
  await runScheduled(fx);
  fx.advance(60_000);
  await runScheduled(fx);
  fx.advance(61_000);
  await runScheduled(fx);
}

function watchUnhandled() {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => {
    unhandled.push(reason);
  };
  process.on("unhandledRejection", onUnhandled);
  return { unhandled, stop: () => process.off("unhandledRejection", onUnhandled) };
}

beforeEach(() => {
  // Fake only the deadline clocks; leave setImmediate/queueMicrotask
  // real so promise and stream work can still make progress.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("acceptance: GET header waits — positive controls (pass before and after)", () => {
  it("a fully healthy boundary run probes each target once in order and stays silent", async () => {
    const fx = fixture();
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
    for (const get of fx.gets) expect(get.cancelCalls).toBe(1);
    expect(fx.sleeps).toEqual([]);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("synthetics keep their five-minute cadence: a healthy off-boundary run probes only /up", async () => {
    const fx = fixture();
    fx.advance(60_000); // Minute 1: not a synthetic boundary.
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up"]);
    expect(fx.sleeps).toEqual([]);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a genuine /up failure retries at 10 s and pages its real status once past the health window", async () => {
    const fx = fixture([respond({ status: 503 })]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(6); // Two attempts per run, three runs.
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 503, down_seconds: 121, timestamp: expect.any(String) },
    ]);
  });

  it("an immediately rejecting /up transport keeps the existing status-0 two-attempt treatment", async () => {
    const fx = fixture([reject]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(6);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 0, down_seconds: 121, timestamp: expect.any(String) },
    ]);
    expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send/);
  });

  it("a genuine synthetic failure retries only that check and pages its real status", async () => {
    const fx = fixture([healthyUp], { "/events": [respond({ status: 503 })] });
    await runScheduled(fx);
    expect(getsFor(fx, "/events")).toHaveLength(2);
    expect(getsFor(fx, "/")).toHaveLength(1);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/events",
        target: "next.togetherweown.com",
        status: 503,
        timestamp: expect.any(String),
      },
    ]);
  });

  it("an immediately rejecting synthetic transport pages status 0 after the existing retry", async () => {
    const fx = fixture([healthyUp], { "/join": [reject] });
    await runScheduled(fx);
    expect(getsFor(fx, "/join")).toHaveLength(2);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/join",
        target: "next.togetherweown.com",
        status: 0,
        timestamp: expect.any(String),
      },
    ]);
    expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send/);
  });
});

describe("acceptance: stalled /up header waits settle within the attempt budget", () => {
  it("a never-settling /up that ignores abort expires at 10 s, makes its second attempt, and still runs synthetics", async () => {
    const fx = fixture([stall]);
    const run = fx.worker.scheduled(fx.event as never, upEnv);
    const state = tracked(run);
    await flushMicrotasks(5);
    expect(getPaths(fx)).toEqual(["/up"]);
    // The cooperative signal is still supplied on the stalled attempt.
    expect(fx.gets[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(state.settled).toBe(false);

    // Just inside the budget the attempt must still be waiting: the
    // deadline is the existing 10 s, not a shorter invented one.
    await advance(ATTEMPT_BUDGET_MS - 1);
    expect(getPaths(fx)).toEqual(["/up"]);
    expect(fx.sleeps).toEqual([]);
    expect(state.settled).toBe(false);

    // At the budget the attempt expires and the existing retry delay starts.
    await advance(1);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(getPaths(fx)).toEqual(["/up"]);
    expect(state.settled).toBe(false);

    // After the delay the second attempt is actually sent, stalls the
    // same way, and expires on its own 10 s budget.
    await advance(RETRY_DELAY_MS);
    expect(getPaths(fx)).toEqual(["/up", "/up"]);
    expect(fx.gets[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(state.settled).toBe(false);

    await advance(ATTEMPT_BUDGET_MS);
    expect(state.settled).toBe(true);
    await run;
    // Health was observed (first red run: no page yet) and the
    // boundary synthetics queued behind /up still ran.
    expect(getPaths(fx)).toEqual(["/up", "/up", "/", "/events", "/join", "/login"]);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a stalled first /up attempt followed by a healthy second settles healthy and never pages", async () => {
    const fx = fixture([stall, healthyUp]);
    await runScheduled(fx);
    expect(getsFor(fx, "/up")).toHaveLength(2);
    expect(getPaths(fx)).toEqual(["/up", "/up", "/", "/events", "/join", "/login"]);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
    // Health stayed healthy: later healthy runs never earn a page.
    fx.advance(183_000);
    await runScheduled(fx);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("stalled /up header waits across the health window page uptime.down once with status 0", async () => {
    const fx = fixture([stall]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(6); // Existing two attempts per run, three runs.
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS, RETRY_DELAY_MS, RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 0, down_seconds: 121, timestamp: expect.any(String) },
    ]);
    expect(fx.sinkLines).toHaveLength(1);
    expect(JSON.parse(fx.sinkLines[0]!)).toMatchObject({
      event: "uptime.down",
      status: 0,
      delivery: "ops.alert.delivered",
    });
    expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send/);
  });
});

describe("acceptance: stalled synthetic header waits cannot starve later routes", () => {
  it("a never-settling first synthetic (/) expires, every later route is probed, and the retry pages status 0", async () => {
    const fx = fixture([healthyUp], { "/": [stall] });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login", "/"]);
    expect(getsFor(fx, "/")[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/",
        target: "next.togetherweown.com",
        status: 0,
        timestamp: expect.any(String),
      },
    ]);
  });

  it("a stalled synthetic that answers healthy on the existing retry never pages", async () => {
    const fx = fixture([healthyUp], {
      "/events": [stall, respond({ status: 200, contentType: "text/html" })],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login", "/events"]);
    expect(getsFor(fx, "/events")).toHaveLength(2);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("two stalled synthetics in one run each expire, retry once, and page once each with status 0", async () => {
    const fx = fixture([healthyUp], { "/": [stall], "/join": [stall] });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login", "/", "/join"]);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/",
        target: "next.togetherweown.com",
        status: 0,
        timestamp: expect.any(String),
      },
      {
        event: "synthetic.down",
        check: "/join",
        target: "next.togetherweown.com",
        status: 0,
        timestamp: expect.any(String),
      },
    ]);
  });

  it("a stalled first synthetic still lets a later genuine failure retry and page its real status", async () => {
    const fx = fixture([healthyUp], {
      "/": [stall, respond({ status: 200, contentType: "text/html" })],
      "/events": [respond({ status: 503 })],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login", "/", "/events"]);
    expect(fx.sleeps).toEqual([RETRY_DELAY_MS]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/events",
        target: "next.togetherweown.com",
        status: 503,
        timestamp: expect.any(String),
      },
    ]);
  });
});

describe("acceptance: late settlements cannot change a settled verdict", () => {
  it("a late healthy response to an expired synthetic attempt does not un-page, re-page, and gets inert cleanup", async () => {
    const fx = fixture([healthyUp], { "/events": [stall] });
    await runScheduled(fx);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/events",
        target: "next.togetherweown.com",
        status: 0,
        timestamp: expect.any(String),
      },
    ]);
    const sinkBefore = [...fx.sinkLines];
    // Both expired attempts finally answer healthy, after the verdict.
    for (const record of getsFor(fx, "/events")) {
      fx.resolveStalled(record, { status: 200, contentType: "text/html" });
    }
    await flushMicrotasks();
    await advance(60_000);
    expect(fx.posts).toHaveLength(1); // No duplicate or corrective page.
    expect(fx.sinkLines).toEqual(sinkBefore);
    expect(getsFor(fx, "/events")).toHaveLength(2); // No extra probe was triggered.
    // Each late response's body got best-effort cleanup without being
    // awaited into the settled run.
    for (const record of getsFor(fx, "/events")) expect(record.cancelCalls).toBe(1);
  });

  it("a late failing response to an expired /up attempt cannot turn a healthy run into an outage", async () => {
    const fx = fixture([stall, healthyUp]);
    await runScheduled(fx);
    expect(fx.posts).toHaveLength(0);
    const stalled = getsFor(fx, "/up")[0]!;
    fx.resolveStalled(stalled, { status: 503 });
    await flushMicrotasks();
    expect(stalled.cancelCalls).toBe(1); // Inert cleanup of the late body.
    // Well past the health window, the late 503 must never have been
    // observed: subsequent healthy runs stay silent.
    fx.advance(183_000);
    await runScheduled(fx);
    expect(fx.posts).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a late rejection from an expired /up attempt is swallowed: no unhandled rejection, page, or leak", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const fx = fixture([stall, healthyUp]);
      await runScheduled(fx);
      fx.rejectStalled(getsFor(fx, "/up")[0]!);
      await flushMicrotasks();
      await advance(60_000);
      expect(unhandled).toEqual([]);
      expect(fx.posts).toHaveLength(0);
      expect(fx.sinkLines).toEqual([]);
      expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send|late transport/);
    } finally {
      stop();
    }
  });

  it("a late rejection from an expired synthetic attempt is swallowed and never duplicates its page", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const fx = fixture([healthyUp], { "/": [stall] });
      await runScheduled(fx);
      expect(fx.posts).toHaveLength(1);
      const sinkBefore = [...fx.sinkLines];
      for (const record of getsFor(fx, "/")) fx.rejectStalled(record);
      await flushMicrotasks();
      await advance(60_000);
      expect(unhandled).toEqual([]);
      expect(fx.posts).toHaveLength(1);
      expect(fx.sinkLines).toEqual(sinkBefore);
      expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send|late transport/);
    } finally {
      stop();
    }
  });
});
