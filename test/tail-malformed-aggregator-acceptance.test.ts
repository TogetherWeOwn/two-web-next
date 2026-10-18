// Acceptance contract: a responsive-but-malformed aggregator falls back
// to local counts.
//
// The aggregator Durable Object is additive: when it cannot answer, the
// per-isolate local tracker / health tracker must observe instead, so a
// malfunctioning aggregator can never suppress spike or uptime pages.
// That fallback already exists for a missing binding, a thrown fetch, a
// non-ok status, a stalled operation, and an unparseable body. This suite
// pins the missing case: an HTTP 200 whose JSON payload parses but is the
// wrong shape must take the same local fallback in both spike and health
// observation. The fallback feeds the existing thresholds only — no new
// paging behavior.
//
// The only well-formed payloads are exactly what the real aggregator
// returns:
//   - spike observe: `null` (no alert due), or a spike alert object
//     (`event: "error.spike"` with a string `script`).
//   - health observe: `null` (no page due), or an object with a numeric
//     `downMs`.
// Anything else on a 200 is malformed. Well-formed responses must keep
// today's behavior byte-for-byte: the aggregator stays authoritative and
// the local trackers are not incremented.
//
// Local fallback is asserted on the real local state (tracker buckets and
// health downSince via the injected instances), not only on pages, so a
// fallback that pages without counting — or counts without ever paging —
// still fails. Hermetic stubs only: no live webhook, Worker, or network.
import { describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  DeliveryMute,
  HealthTracker,
  SPIKE_MIN_ERRORS,
  createTailWorker,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";

const fetchTrace = (status: number, at = t0) => ({
  scriptName: "two-web-next",
  outcome: "ok",
  exceptions: [],
  eventTimestamp: at,
  event: {
    request: { method: "GET", url: "https://example.test/private?token=never-send" },
    response: { status },
  },
  logs: [],
});

const alertLine = JSON.stringify({
  level: "critical",
  event: "error.alert",
  fingerprint: "TypeError@/join",
  route: "/join",
});

// One ordinary 200 fetch trace carrying an error.alert log line.
const alertTrace = () => ({
  ...fetchTrace(200),
  logs: [{ message: [alertLine], timestamp: t0, level: "error" }],
});

const burst = (count: number, at = t0) => Array.from({ length: count }, () => fetchTrace(500, at));

const wellFormedSpike = {
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

type StubFetch = (url: string, init?: RequestInit) => Promise<Response>;

function makeWorker(nowStart = t0, upStatus = 503) {
  let now = nowStart;
  // Outbound fetch double: POST is the ops webhook delivery; anything
  // else is the /up probe, answered with the configured status. A 200
  // probe only counts as healthy with the origin marker header.
  const send = vi.fn(async (...args: [string, RequestInit?]) => {
    const [, init] = args;
    if (init?.method === "POST") return new Response(null, { status: 200 });
    return new Response(null, {
      status: upStatus,
      headers: upStatus === 200 ? { "x-two-origin": "two-web-next" } : undefined,
    });
  });
  const sink = vi.fn();
  const tracker = new AggregateTracker(() => now);
  const health = new HealthTracker(() => now);
  const worker = createTailWorker({
    fetch: send as unknown as typeof fetch,
    sink,
    mute: new DeliveryMute(() => now),
    tracker,
    health,
    now: () => now,
    sleep: async () => {},
  });
  const posts = () =>
    (send.mock.calls as unknown as [string, RequestInit][]).filter(
      ([url]) => url === `${secret}?wait=true`,
    );
  const contents = () =>
    posts().map(([, init]) => JSON.parse(JSON.parse(init.body as string).content));
  const receipts = () => sink.mock.calls.map(([line]) => JSON.parse(line as string));
  const localCounts = () => {
    const totals = { requests: 0, errors: 0, crashes: 0 };
    for (const state of Object.values(tracker.snapshot())) {
      for (const bucket of state.buckets) {
        totals.requests += bucket.requests;
        totals.errors += bucket.errors;
        totals.crashes += bucket.crashes;
      }
    }
    return totals;
  };
  return {
    worker,
    tracker,
    health,
    contents,
    receipts,
    localCounts,
    setNow: (at: number) => {
      now = at;
    },
  };
}

// Builds the env with a scripted aggregator stub and records every path
// the worker calls on it, in order. `respond` answers each call and must
// return a fresh Response per call (bodies are single-use).
function aggregatorEnv(respond: (path: string) => Promise<Response> | Response) {
  const paths: string[] = [];
  const stubFetch: StubFetch = async (url: string) => {
    const path = new URL(url).pathname;
    paths.push(path);
    return respond(path);
  };
  const env = {
    OPS_ALERT_WEBHOOK_URL: secret,
    UPTIME_URL: "https://next.togetherweown.com/up",
    ALERT_AGGREGATOR: {
      idFromName: () => ({}),
      get: () => ({ fetch: stubFetch }),
    },
  } as never;
  return { env, paths };
}

// Malformed spike payloads: parseable JSON on a 200, never emitted by the
// real aggregator. Each factory returns a fresh payload value.
const malformedSpikePayloads: [string, () => unknown][] = [
  ["a JSON string", () => "error.spike"],
  ["a JSON number", () => 42],
  ["a JSON boolean", () => true],
  ["a JSON array", () => []],
  ["an empty object", () => ({})],
  ["a spike event without a script", () => ({ event: "error.spike" })],
  ["a spike event with a numeric script", () => ({ event: "error.spike", script: 123 })],
  ["a different event with a script", () => ({ event: "uptime.down", script: "two-web-next" })],
];

// Malformed health payloads: parseable JSON on a 200, never emitted by
// the real aggregator (which answers `null` or `{ downMs: <number> }`).
const malformedHealthPayloads: [string, () => unknown][] = [
  ["a JSON string", () => "down"],
  ["a JSON number", () => 42],
  ["a JSON boolean", () => false],
  ["a JSON array", () => []],
  ["an empty object", () => ({})],
  ["an object without downMs", () => ({ attemptId: "health-attempt-1" })],
  ["a string downMs", () => ({ downMs: "121000" })],
];

describe("acceptance: malformed aggregator spike payloads fall back to local counts", () => {
  it.each(malformedSpikePayloads)(
    "200 with %s increments the local tracker and the local threshold pages",
    async (_name, payload) => {
      const { worker, contents, receipts, localCounts } = makeWorker();
      const { env } = aggregatorEnv((path) =>
        path === "/observe" ? Response.json(payload()) : Response.json(null),
      );
      await worker.tail(burst(SPIKE_MIN_ERRORS), env);
      // The whole burst was counted locally, not dropped.
      expect(localCounts()).toEqual({
        requests: SPIKE_MIN_ERRORS,
        errors: SPIKE_MIN_ERRORS,
        crashes: 0,
      });
      // The existing local threshold pages exactly once from those counts.
      expect(contents()).toHaveLength(1);
      expect(contents()[0]).toMatchObject({
        event: "error.spike",
        script: "two-web-next",
        requests: SPIKE_MIN_ERRORS,
        errors: SPIKE_MIN_ERRORS,
        crashes: 0,
        error_rate: 1,
      });
      expect(receipts()).toMatchObject([{ event: "error.spike", delivery: "ops.alert.delivered" }]);
      expect(JSON.stringify(contents())).not.toMatch(/never-send|example\.test/);
    },
  );

  it("sub-threshold malformed batches accumulate locally across calls until the threshold pages", async () => {
    const { worker, contents, localCounts, setNow } = makeWorker();
    const { env } = aggregatorEnv((path) =>
      path === "/observe" ? Response.json({}) : Response.json(null),
    );
    await worker.tail(burst(3, t0), env);
    expect(localCounts()).toEqual({ requests: 3, errors: 3, crashes: 0 });
    expect(contents()).toHaveLength(0); // Below the existing minimum: no page.
    setNow(t0 + 60_000);
    await worker.tail(burst(3, t0 + 60_000), env);
    expect(localCounts()).toEqual({ requests: 6, errors: 6, crashes: 0 });
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.spike", requests: 6, errors: 6 });
  });

  it("a malformed spike payload still lets the per-fingerprint pager deliver, and the request is counted locally", async () => {
    const { worker, contents, localCounts } = makeWorker();
    const { env } = aggregatorEnv((path) =>
      path === "/observe" ? Response.json("garbage") : Response.json(null),
    );
    await worker.tail([alertTrace()], env);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.alert", route: "/join" });
    expect(localCounts()).toEqual({ requests: 1, errors: 0, crashes: 0 });
  });
});

describe("acceptance: malformed aggregator health payloads fall back to local health", () => {
  it.each(malformedHealthPayloads)(
    "200 with %s records a local health observation and pages after two minutes red",
    async (_name, payload) => {
      // Slots at :01 and :03 keep the five-minute synthetics out; only
      // the /up health path runs, and /up is red (503) throughout.
      const start = t0 + 60_000;
      const { worker, health, contents, receipts, setNow } = makeWorker(start);
      const { env } = aggregatorEnv((path) =>
        path === "/health" ? Response.json(payload()) : Response.json(null),
      );
      const first = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
      await worker.scheduled(first, env);
      // The red probe was observed locally, not swallowed.
      expect(health.snapshot().downSince).toBe(start);
      expect(contents()).toHaveLength(0); // First red run: no page yet.

      const later = start + 121_000;
      setNow(later);
      const second = { cron: "* * * * *", scheduledTime: later, noRetry() {} };
      await worker.scheduled(second, env);
      // The existing two-minute local threshold pages exactly once.
      expect(contents()).toHaveLength(1);
      expect(contents()[0]).toMatchObject({ event: "uptime.down", down_seconds: 121 });
      expect(receipts()).toMatchObject([
        { event: "uptime.down", down_seconds: 121, delivery: "ops.alert.delivered" },
      ]);
    },
  );

  it("a malformed health payload on a healthy probe locally observes the recovery and clears downSince", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents } = makeWorker(start, 200);
    health.restore({ downSince: t0, cooldownUntil: 0, pendingAt: null });
    const { env } = aggregatorEnv((path) =>
      path === "/health" ? Response.json({}) : Response.json(null),
    );
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(health.snapshot().downSince).toBeNull();
    expect(contents()).toHaveLength(0);
  });
});

describe("acceptance: existing fallback paths keep falling back (controls)", () => {
  it("control: an unparseable 200 spike body already increments the local tracker and pages", async () => {
    const { worker, contents, localCounts } = makeWorker();
    const { env } = aggregatorEnv((path) =>
      path === "/observe"
        ? new Response("{nope", { status: 200, headers: { "content-type": "application/json" } })
        : Response.json(null),
    );
    await worker.tail(burst(SPIKE_MIN_ERRORS), env);
    expect(localCounts()).toEqual({
      requests: SPIKE_MIN_ERRORS,
      errors: SPIKE_MIN_ERRORS,
      crashes: 0,
    });
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.spike" });
  });

  it("control: a non-ok spike response already increments the local tracker and pages", async () => {
    const { worker, contents, localCounts } = makeWorker();
    const { env } = aggregatorEnv((path) =>
      path === "/observe" ? new Response(null, { status: 503 }) : Response.json(null),
    );
    await worker.tail(burst(SPIKE_MIN_ERRORS), env);
    expect(localCounts().errors).toBe(SPIKE_MIN_ERRORS);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "error.spike" });
  });

  it("control: an unparseable 200 health body already records a local health observation", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents } = makeWorker(start);
    const { env } = aggregatorEnv((path) =>
      path === "/health"
        ? new Response("{nope", { status: 200, headers: { "content-type": "application/json" } })
        : Response.json(null),
    );
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(health.snapshot().downSince).toBe(start);
    expect(contents()).toHaveLength(0);
  });

  it("control: a non-ok health response already records a local health observation", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents } = makeWorker(start);
    const { env } = aggregatorEnv((path) =>
      path === "/health" ? new Response(null, { status: 503 }) : Response.json(null),
    );
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(health.snapshot().downSince).toBe(start);
    expect(contents()).toHaveLength(0);
  });
});

describe("acceptance: well-formed aggregator responses are unchanged (controls)", () => {
  it("control: a well-formed spike null keeps the aggregator authoritative — no local increment, no page", async () => {
    const { worker, tracker, contents, receipts, localCounts } = makeWorker();
    const { env, paths } = aggregatorEnv(() => Response.json(null));
    await worker.tail(burst(SPIKE_MIN_ERRORS), env);
    expect(paths).toEqual(["/observe"]);
    expect(tracker.snapshot()).toEqual({});
    expect(localCounts()).toEqual({ requests: 0, errors: 0, crashes: 0 });
    expect(contents()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
  });

  it("control: a well-formed spike alert is delivered byte-for-byte from the aggregator, with no local increment", async () => {
    const { worker, tracker, contents, receipts } = makeWorker();
    const { env, paths } = aggregatorEnv((path) =>
      path === "/observe" ? Response.json(wellFormedSpike) : Response.json(null),
    );
    await worker.tail([fetchTrace(500)], env);
    expect(paths).toEqual(["/observe", "/spike-result"]);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toEqual(wellFormedSpike);
    expect(receipts()).toEqual([{ ...wellFormedSpike, delivery: "ops.alert.delivered" }]);
    expect(tracker.snapshot()).toEqual({});
  });

  it("control: a well-formed health null keeps the aggregator authoritative — no local observation, no page even past two minutes red", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents, receipts, setNow } = makeWorker(start);
    const { env, paths } = aggregatorEnv(() => Response.json(null));
    const first = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(first, env);
    expect(health.snapshot().downSince).toBeNull();
    const later = start + 121_000;
    setNow(later);
    const second = { cron: "* * * * *", scheduledTime: later, noRetry() {} };
    await worker.scheduled(second, env);
    expect(paths).toEqual(["/health", "/health"]);
    expect(health.snapshot().downSince).toBeNull();
    expect(contents()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
  });

  it("control: a well-formed health downMs pages from the aggregator value, with no local observation", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents, receipts } = makeWorker(start);
    const { env, paths } = aggregatorEnv((path) =>
      path === "/health"
        ? Response.json({ downMs: 121_000, attemptId: "health-attempt-1" })
        : Response.json(null),
    );
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(paths).toEqual(["/health", "/health-result"]);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toMatchObject({ event: "uptime.down", down_seconds: 121 });
    expect(receipts()).toMatchObject([
      { event: "uptime.down", down_seconds: 121, delivery: "ops.alert.delivered" },
    ]);
    expect(health.snapshot().downSince).toBeNull();
  });

  it("control: a healthy probe with a well-formed health null sends no page and no receipt", async () => {
    const start = t0 + 60_000;
    const { worker, contents, receipts } = makeWorker(start, 200);
    const { env } = aggregatorEnv(() => Response.json(null));
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(contents()).toHaveLength(0);
    expect(receipts()).toHaveLength(0);
  });
});
