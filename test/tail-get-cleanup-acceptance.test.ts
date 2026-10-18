// Acceptance contract: GET response cleanup in the Tail prober is inert.
//
// The /up probe and each synthetic main-flow probe compute their verdict
// from status + headers, then cancel the (never read) response body.
// That cleanup must behave exactly like the webhook-delivery cleanup
// already treated as inert elsewhere in tail/worker.ts: it is attempted,
// its outcome is swallowed, and it can never flip a verdict, invent an
// outage, or stall the serial checks that follow it.
//
// Pre-fix red proof: both GET probes `await response.body?.cancel()`
// inside the same try that maps any throw to `{ ok: false, status: 0 }`.
// A throwing or rejecting cancel therefore rewrites a healthy verdict
// into a status-0 outage (retried, then paged once the health window or
// synthetic retry confirms it), a genuine failure loses its real status
// to 0, and a cancel that never settles leaves the probe — and every
// synthetic check queued behind it in the serial loop — pending forever.
// The positive controls (resolving cleanup, null body, genuine failures
// with resolving cleanup) pass before and after.
//
// Post-fix contract, under the existing prober policy — no new target,
// threshold, channel, retry or cadence:
// - A known-healthy /up or synthetic response keeps its verdict when
//   cancel throws, rejects, or never settles: one probe, no retry sleep,
//   no page, and the scheduled run still settles.
// - A genuine failure (bad status, wrong origin marker, wrong
//   content-type, wrong redirect host/path) stays unhealthy with its
//   REAL status in the page, retried after the existing 10 s delay.
// - Cleanup is still attempted on every GET response, but no cleanup
//   rejection, response body or secret reaches a sink receipt, a webhook
//   payload, or an unhandled rejection — including a pending cancel
//   that rejects only after the verdict has settled.
// - A stalled first synthetic cleanup cannot starve the later routes:
//   every remaining check is still probed (and still pages on a genuine
//   failure) in the same run.
//
// Why plain cancel stubs: a `vi.fn(async ...)` cancel records its own
// settled result, which handles the rejection and makes an
// unhandled-rejection assertion vacuous. These cancels are plain
// functions returning raw promises, so only production's own swallow
// keeps a rejection handled. The fake GET responses expose only
// status/headers/body.cancel — there is deliberately no body reader,
// because the prober must never read or log a probe body.
//
// Everything is hermetic: injected fetch/sleep/clock, no webhook,
// database or network contact, and no external GETs.
import { describe, expect, it, vi } from "vitest";
import { DeliveryMute, createTailWorker } from "../tail/worker";

const timestamp = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";
const uptime = "https://next.togetherweown.com/up";
const upEnv = { OPS_ALERT_WEBHOOK_URL: secret, UPTIME_URL: uptime };
// Baked into every cleanup failure: if a cleanup error (or anything it
// names) ever reaches a receipt or a page, these markers surface it.
const cleanupSecret = `cleanup failed for ${secret} body=never-send`;

type CancelMode = "resolve" | "throw" | "reject" | "pending" | "none";

type Probe = {
  status?: number;
  origin?: string | null;
  contentType?: string | null;
  location?: string | null;
  cancel?: CancelMode;
};

const healthyUp: Probe = { status: 200, origin: "two-web-next" };

const healthySynthetic = (path: string): Probe => {
  if (path === "/login") return { status: 302, location: "/auth/discord" };
  return { status: 200, contentType: "text/html; charset=UTF-8" };
};

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type GetRecord = {
  path: string;
  cancelCalls: number;
  pending?: Deferred;
};

function fixture(
  upProbes: Probe[] = [healthyUp],
  synthetic: Partial<Record<string, Probe[]>> = {},
) {
  let now = timestamp;
  const sleeps: number[] = [];
  const gets: GetRecord[] = [];
  const sinkLines: string[] = [];
  const upQueue = [...upProbes];
  let lastUp: Probe = upProbes[upProbes.length - 1] ?? healthyUp;
  const syntheticQueues = new Map(
    Object.entries(synthetic).map(([path, list]) => [path, [...(list ?? [])]]),
  );
  const lastSynthetic = new Map<string, Probe>();

  const makeResponse = (path: string, probe: Probe): Response => {
    const record: GetRecord = { path, cancelCalls: 0 };
    gets.push(record);
    const mode: CancelMode = probe.cancel ?? "resolve";
    let body: { cancel: () => Promise<void> } | null = null;
    if (mode !== "none") {
      // Plain function on purpose (see header): no test-framework
      // promise tracking may handle this rejection for production.
      const cancel = (): Promise<void> => {
        record.cancelCalls += 1;
        if (mode === "throw") throw new Error(cleanupSecret);
        if (mode === "reject") return Promise.reject(new Error(cleanupSecret));
        if (mode === "pending") {
          record.pending = deferred();
          return record.pending.promise;
        }
        return Promise.resolve();
      };
      body = { cancel };
    }
    const headers: Record<string, string> = {};
    if (probe.origin != null) headers["x-two-origin"] = probe.origin;
    if (probe.contentType != null) headers["content-type"] = probe.contentType;
    if (probe.location != null) headers.location = probe.location;
    const status = probe.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: new Headers(headers),
      body,
    } as unknown as Response;
  };

  const send = vi.fn(async (...args: [string, RequestInit?]) => {
    const [target, init] = args;
    if (init?.method === "POST") return new Response(null, { status: 200 });
    const path = new URL(target).pathname;
    let next: Probe;
    if (path === "/up") {
      next = upQueue.shift() ?? lastUp;
      lastUp = next;
    } else {
      next =
        syntheticQueues.get(path)?.shift() ?? lastSynthetic.get(path) ?? healthySynthetic(path);
      lastSynthetic.set(path, next);
    }
    return makeResponse(path, next);
  });
  const sink = (line: string): void => {
    sinkLines.push(line);
  };
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    now: () => now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });
  const event = { cron: "* * * * *", scheduledTime: timestamp, noRetry() {} };
  return {
    worker,
    send,
    gets,
    sinkLines,
    sleeps,
    event,
    advance: (ms: number) => {
      now += ms;
      event.scheduledTime += ms; // The next cron slot is later by the same step.
    },
  };
}

type Fx = ReturnType<typeof fixture>;

const getsFor = (fx: Fx, path: string) => fx.gets.filter((g) => g.path === path);
const getPaths = (fx: Fx) => fx.gets.map((g) => g.path);
const pagePosts = (fx: Fx) =>
  (fx.send.mock.calls as unknown as [string, RequestInit][]).filter(
    ([, init]) => init?.method === "POST",
  );
const pageContents = (fx: Fx) =>
  pagePosts(fx).map((page) => JSON.parse(JSON.parse(page[1].body as string).content as string));
const everythingOutbound = (fx: Fx) =>
  JSON.stringify({
    sink: fx.sinkLines,
    posts: pagePosts(fx).map(([, init]) => init.body),
  });

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

// The injected sleep resolves immediately, so a healthy scheduled run
// settles on microtasks alone. A run still pending after this flush is
// stalled on cleanup, not merely slow — fail fast instead of hanging
// until the test timeout.
async function runScheduled(fx: Fx): Promise<void> {
  const run = fx.worker.scheduled(fx.event as never, upEnv);
  const state = tracked(run);
  for (let i = 0; i < 500 && !state.settled; i += 1) {
    await new Promise((r) => setImmediate(r));
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

describe("acceptance: GET cleanup is inert — positive controls (pass before and after)", () => {
  it("a fully healthy boundary run probes each target once in order, cancels each body, and stays silent", async () => {
    const fx = fixture();
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
    for (const get of fx.gets) expect(get.cancelCalls).toBe(1);
    expect(fx.sleeps).toEqual([]);
    expect(pagePosts(fx)).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a healthy run whose GET responses have no body at all stays silent", async () => {
    const fx = fixture([{ ...healthyUp, cancel: "none" }], {
      "/": [{ status: 200, contentType: "text/html", cancel: "none" }],
      "/events": [{ status: 200, contentType: "text/html", cancel: "none" }],
      "/join": [{ status: 200, contentType: "text/html", cancel: "none" }],
      "/login": [{ status: 302, location: "/auth/discord", cancel: "none" }],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
    expect(fx.sleeps).toEqual([]);
    expect(pagePosts(fx)).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a genuine /up failure with resolving cleanup retries at 10 s and pages once past the health window", async () => {
    const fx = fixture([{ status: 503 }]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(6); // Two attempts per run, three runs.
    expect(fx.sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 503, down_seconds: 121, timestamp: expect.any(String) },
    ]);
    // Still red inside the cooldown: no second page.
    fx.advance(60_000);
    await runScheduled(fx);
    expect(pagePosts(fx)).toHaveLength(1);
  });

  it("a genuine synthetic failure with resolving cleanup retries only that check and pages its real status", async () => {
    const fx = fixture([healthyUp], { "/events": [{ status: 503 }] });
    await runScheduled(fx);
    expect(getsFor(fx, "/events")).toHaveLength(2);
    expect(getsFor(fx, "/")).toHaveLength(1);
    expect(fx.sleeps).toEqual([10_000]);
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

describe("acceptance: healthy /up verdict survives bad cleanup", () => {
  it.each(["throw", "reject", "pending"] as const)(
    "healthy /up with %s cancel is probed once, never retried, and the run (incl. synthetics) still settles silently",
    async (mode) => {
      const { unhandled, stop } = watchUnhandled();
      try {
        const fx = fixture([{ ...healthyUp, cancel: mode }]);
        await runScheduled(fx);
        expect(getsFor(fx, "/up")).toHaveLength(1);
        expect(getsFor(fx, "/up")[0]?.cancelCalls).toBe(1);
        // Synthetics behind the /up probe still ran in the same run.
        expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
        expect(fx.sleeps).toEqual([]);
        expect(pagePosts(fx)).toHaveLength(0);
        expect(fx.sinkLines).toEqual([]);
        await flushMicrotasks();
        expect(unhandled).toEqual([]);
        expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send/);
      } finally {
        stop();
      }
    },
  );

  it("healthy /up with rejecting cancel never invents an outage across the whole health window", async () => {
    const fx = fixture([{ ...healthyUp, cancel: "reject" }]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(3); // Exactly one probe per run: no retry was ever earned.
    expect(fx.sleeps).toEqual([]);
    expect(pagePosts(fx)).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });
});

describe("acceptance: genuine /up failures keep their real status under bad cleanup", () => {
  it("bad-status /up with rejecting cancel pages status 503, not 0, after the existing retries", async () => {
    const fx = fixture([{ status: 503, cancel: "reject" }]);
    await runDownPastGate(fx);
    expect(getsFor(fx, "/up")).toHaveLength(6);
    for (const get of getsFor(fx, "/up")) expect(get.cancelCalls).toBe(1);
    expect(fx.sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 503, down_seconds: 121, timestamp: expect.any(String) },
    ]);
    expect(everythingOutbound(fx)).not.toMatch(/never-send|cleanup failed/);
  });

  it("wrong-marker /up (200, foreign origin) with throwing cancel pages status 200, not 0", async () => {
    const fx = fixture([{ status: 200, origin: "someone-else", cancel: "throw" }]);
    await runDownPastGate(fx);
    expect(pageContents(fx)).toEqual([
      { event: "uptime.down", status: 200, down_seconds: 121, timestamp: expect.any(String) },
    ]);
    expect(everythingOutbound(fx)).not.toMatch(/never-send|cleanup failed/);
  });
});

describe("acceptance: healthy synthetic verdicts survive bad cleanup", () => {
  it.each(["/", "/events", "/join", "/login"])(
    "healthy %s with rejecting cancel is probed once, never retried, and never pages",
    async (path) => {
      const fx = fixture([healthyUp], {
        [path]: [{ ...healthySynthetic(path), cancel: "reject" as const }],
      });
      await runScheduled(fx);
      expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
      expect(getsFor(fx, path)[0]?.cancelCalls).toBe(1);
      expect(fx.sleeps).toEqual([]);
      expect(pagePosts(fx)).toHaveLength(0);
      expect(fx.sinkLines).toEqual([]);
    },
  );

  it.each(["/", "/login"])(
    "healthy %s with throwing cancel keeps its verdict (page and redirect families)",
    async (path) => {
      const fx = fixture([healthyUp], {
        [path]: [{ ...healthySynthetic(path), cancel: "throw" as const }],
      });
      await runScheduled(fx);
      expect(getsFor(fx, path)).toHaveLength(1);
      expect(getsFor(fx, path)[0]?.cancelCalls).toBe(1);
      expect(fx.sleeps).toEqual([]);
      expect(pagePosts(fx)).toHaveLength(0);
      expect(fx.sinkLines).toEqual([]);
    },
  );

  it("a pending cancel on the first synthetic (/) cannot starve the remaining routes", async () => {
    const fx = fixture([healthyUp], {
      "/": [{ status: 200, contentType: "text/html", cancel: "pending" }],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
    expect(getsFor(fx, "/")[0]?.cancelCalls).toBe(1);
    expect(fx.sleeps).toEqual([]);
    expect(pagePosts(fx)).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });

  it("a pending cancel on / still lets a later genuine /events failure retry and page in the same run", async () => {
    const fx = fixture([healthyUp], {
      "/": [{ status: 200, contentType: "text/html", cancel: "pending" }],
      "/events": [{ status: 503 }],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login", "/events"]);
    expect(fx.sleeps).toEqual([10_000]);
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

  it("a pending cancel on the last synthetic (/login) still lets the run settle silently", async () => {
    const fx = fixture([healthyUp], {
      "/login": [{ status: 302, location: "/auth/discord", cancel: "pending" }],
    });
    await runScheduled(fx);
    expect(getPaths(fx)).toEqual(["/up", "/", "/events", "/join", "/login"]);
    expect(pagePosts(fx)).toHaveLength(0);
    expect(fx.sinkLines).toEqual([]);
  });
});

describe("acceptance: genuine synthetic failures stay unhealthy under bad cleanup", () => {
  it("bad-status / with throwing cancel pages synthetic.down with status 500, not 0", async () => {
    const fx = fixture([healthyUp], { "/": [{ status: 500, cancel: "throw" }] });
    await runScheduled(fx);
    expect(getsFor(fx, "/")).toHaveLength(2);
    for (const get of getsFor(fx, "/")) expect(get.cancelCalls).toBe(1);
    expect(fx.sleeps).toEqual([10_000]);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/",
        target: "next.togetherweown.com",
        status: 500,
        timestamp: expect.any(String),
      },
    ]);
  });

  it("wrong content-type /events (200 JSON) with rejecting cancel pages status 200, not 0", async () => {
    const fx = fixture([healthyUp], {
      "/events": [{ status: 200, contentType: "application/json", cancel: "reject" }],
    });
    await runScheduled(fx);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/events",
        target: "next.togetherweown.com",
        status: 200,
        timestamp: expect.any(String),
      },
    ]);
  });

  it("bad-status /join with rejecting cancel pages synthetic.down with status 503, not 0", async () => {
    const fx = fixture([healthyUp], { "/join": [{ status: 503, cancel: "reject" }] });
    await runScheduled(fx);
    expect(getsFor(fx, "/join")).toHaveLength(2);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/join",
        target: "next.togetherweown.com",
        status: 503,
        timestamp: expect.any(String),
      },
    ]);
  });

  it.each([
    "https://next.togetherweown.com/not-discord?token=never-send",
    "https://evil.example/auth/discord?token=never-send",
  ])(
    "wrong redirect /login (%s) with rejecting cancel pages status 302 and leaks no Location query",
    async (location) => {
      const fx = fixture([healthyUp], {
        "/login": [{ status: 302, location, cancel: "reject" }],
      });
      await runScheduled(fx);
      expect(pageContents(fx)).toEqual([
        {
          event: "synthetic.down",
          check: "/login",
          target: "next.togetherweown.com",
          status: 302,
          timestamp: expect.any(String),
        },
      ]);
      expect(everythingOutbound(fx)).not.toMatch(/never-send|evil\.example|not-discord/);
    },
  );

  it("non-redirect /login (200) with throwing cancel pages synthetic.down with status 200, not 0", async () => {
    const fx = fixture([healthyUp], {
      "/login": [{ status: 200, contentType: "text/html", cancel: "throw" }],
    });
    await runScheduled(fx);
    expect(pageContents(fx)).toEqual([
      {
        event: "synthetic.down",
        check: "/login",
        target: "next.togetherweown.com",
        status: 200,
        timestamp: expect.any(String),
      },
    ]);
  });
});

describe("acceptance: cleanup failures never leak and never surface late", () => {
  it("a genuine page under rejecting cleanup carries only the allowlisted fields, with cleanup attempted on both tries", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const fx = fixture([healthyUp], { "/events": [{ status: 503, cancel: "reject" }] });
      await runScheduled(fx);
      expect(getsFor(fx, "/events")).toHaveLength(2);
      for (const get of getsFor(fx, "/events")) expect(get.cancelCalls).toBe(1);
      expect(pageContents(fx)).toEqual([
        {
          event: "synthetic.down",
          check: "/events",
          target: "next.togetherweown.com",
          status: 503,
          timestamp: expect.any(String),
        },
      ]);
      expect(fx.sinkLines).toHaveLength(1);
      expect(JSON.parse(fx.sinkLines[0]!)).toMatchObject({
        event: "synthetic.down",
        delivery: "ops.alert.delivered",
      });
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
      expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send|cleanup failed/);
    } finally {
      stop();
    }
  });

  it("a pending cancel that rejects after the verdict settled causes no unhandled rejection and no late page", async () => {
    const { unhandled, stop } = watchUnhandled();
    try {
      const fx = fixture([healthyUp], {
        "/events": [{ status: 200, contentType: "text/html", cancel: "pending" }],
      });
      await runScheduled(fx);
      expect(pagePosts(fx)).toHaveLength(0);
      const pending = getsFor(fx, "/events")[0]?.pending;
      expect(pending).toBeDefined();
      pending?.reject(new Error(cleanupSecret));
      await flushMicrotasks();
      expect(unhandled).toEqual([]);
      expect(pagePosts(fx)).toHaveLength(0);
      expect(fx.sinkLines).toEqual([]);
      expect(everythingOutbound(fx)).not.toMatch(/test-only-token|never-send/);
    } finally {
      stop();
    }
  });
});
