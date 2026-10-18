// Acceptance contract: a malfunctioning-aggregator fallback is visible.
//
// The local fallback itself is already pinned by
// tail-malformed-aggregator-acceptance.test.ts: when the aggregator
// Durable Object answers non-OK, unparseable, or wrong-shape 200, the
// per-isolate tracker / health tracker observes instead. Today that
// fallback is silent, so a persistently malfunctioning aggregator looks
// like healthy local traffic. This suite pins the visibility layer only:
//
//   - Per malfunction fallback invocation — non-OK, unparseable body, and
//     wrong-shape 200, on BOTH the spike (/observe) and health (/health)
//     paths — exactly one diagnostic line is emitted. A diagnostic line
//     is any line on the injected sink that is not a delivery receipt
//     (receipts carry a `delivery` field), plus any console.warn/error/
//     log call. Emitting on exactly one of those channels passes;
//     emitting on both, or twice, fails.
//   - The line identifies the aggregator fallback, the path, and the
//     failure class. Vocabulary bands (case-insensitive):
//       common:  /aggregator/ and /fallback/
//       spike:   /spike|observe/        health: /health/
//       non-OK:  /non[-_ ]?ok|http|status/
//       unparseable: /unparseable|parse|json/
//       wrong-shape: /shape|malformed|unexpected|schema|invalid/
//     One generic line for every class cannot satisfy all three class
//     bands positionally (see the cross-class sequence test).
//   - The line — and every other captured line — carries no payload
//     bytes and no secrets: canaries embedded in the malfunctioning
//     responses, the webhook credential, the trace request token, and
//     the internal aggregator URL must never appear.
//   - Fallback verdicts are unchanged: local counts / local health still
//     arrive and page exactly as the existing thresholds dictate.
//     Verdict assertions run before diagnostic assertions in every test,
//     so a RED run today fails on the missing line, not the verdict.
//   - Well-formed aggregator answers emit no diagnostic at all.
//
// Deliberately unpinned: thrown-fetch / stalled-operation fallbacks are
// outside this card's three failure classes; this suite neither requires
// nor forbids a diagnostic there. Hermetic stubs only: no live webhook,
// Worker, or network. Production change that must fail here: removing,
// duplicating, declassifying, or payload-logging the per-fallback line.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AggregateTracker,
  DeliveryMute,
  HealthTracker,
  SPIKE_MIN_ERRORS,
  createTailWorker,
} from "../tail/worker";

const t0 = Date.parse("2026-10-01T00:00:00Z");
const secret = "https://discord.com/api/webhooks/123456789/test-only-token";

const CANARY = {
  spikeNonOk: "canary-spike-nonok-body-7f3a",
  spikeUnparseable: "canary-spike-unparseable-2b9c",
  spikeShape: "canary-spike-wrongshape-4d1e",
  healthNonOk: "canary-health-nonok-body-8a6f",
  healthUnparseable: "canary-health-unparseable-1c5d",
  healthShape: "canary-health-wrongshape-9e2b",
} as const;

// Nothing the worker emits may carry any of these: aggregator payload
// bytes (canaries), the webhook credential, the trace URL token, or the
// internal aggregator origin.
const FORBIDDEN = [...Object.values(CANARY), "test-only-token", "never-send", "aggregator.invalid"];

const CLASS_PATTERN = {
  nonOk: /non[-_ ]?ok|http|status/i,
  unparseable: /unparseable|parse|json/i,
  wrongShape: /shape|malformed|unexpected|schema|invalid/i,
} as const;
type FailureClass = keyof typeof CLASS_PATTERN;

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

// Console capture: a diagnostic may ride the injected sink or a direct
// console call, but the total across channels must be exactly one.
let consoleLines: string[] = [];
beforeEach(() => {
  consoleLines = [];
  for (const level of ["warn", "error", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      consoleLines.push(
        args
          .map((arg) => (typeof arg === "string" ? arg : (JSON.stringify(arg) ?? String(arg))))
          .join(" "),
      );
    });
  }
});
afterEach(() => {
  vi.restoreAllMocks();
});

type StubFetch = (url: string, init?: RequestInit) => Promise<Response>;

function makeWorker(nowStart = t0, upStatus = 503) {
  let now = nowStart;
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
  const sinkLines = () => sink.mock.calls.map(([line]) => line as string);
  // Diagnostics: every sink line that is not a delivery receipt, plus
  // every captured console call.
  const diagnostics = () => {
    const fromSink = sinkLines().filter((line) => {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        return !("delivery" in parsed);
      } catch {
        return true;
      }
    });
    return [...fromSink, ...consoleLines];
  };
  const allLines = () => [
    ...sinkLines(),
    ...consoleLines,
    ...contents().map((c) => JSON.stringify(c)),
  ];
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
    diagnostics,
    allLines,
    localCounts,
    setNow: (at: number) => {
      now = at;
    },
  };
}

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

// One fresh malfunctioning response per class, each carrying its canary
// in the bytes a payload-logging implementation would leak.
function malfunction(kind: FailureClass, canary: string, shapePayload: unknown): Response {
  if (kind === "nonOk") return new Response(`upstream broke ${canary}`, { status: 503 });
  if (kind === "unparseable")
    return new Response(`{${canary}`, {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  return Response.json(shapePayload);
}

function expectClean(lines: string[]) {
  const joined = lines.join("\n");
  for (const token of FORBIDDEN) expect(joined).not.toContain(token);
}

function expectDiagnostic(line: string | undefined, path: "spike" | "health", kind: FailureClass) {
  expect(line, "a diagnostic line must exist").toBeTypeOf("string");
  expect(line).toMatch(/aggregator/i);
  expect(line).toMatch(/fallback/i);
  expect(line).toMatch(path === "spike" ? /spike|observe/i : /health/i);
  expect(line).toMatch(CLASS_PATTERN[kind]);
}

describe("acceptance: spike-path malfunction fallbacks emit exactly one diagnostic", () => {
  const spikeCases: [string, FailureClass, string][] = [
    ["non-OK", "nonOk", CANARY.spikeNonOk],
    ["unparseable 200", "unparseable", CANARY.spikeUnparseable],
    ["wrong-shape 200", "wrongShape", CANARY.spikeShape],
  ];
  it.each(spikeCases)(
    "%s: the local verdict pages once, plus exactly one spike diagnostic naming the class",
    async (_name, kind, canary) => {
      const { worker, contents, diagnostics, allLines, localCounts } = makeWorker();
      const shape = { event: "error.spike", script: 123, note: canary };
      const { env } = aggregatorEnv((path) =>
        path === "/observe" ? malfunction(kind, canary, shape) : Response.json(null),
      );
      await worker.tail(burst(SPIKE_MIN_ERRORS), env);
      // Fallback verdict unchanged (already true today).
      expect(localCounts()).toEqual({
        requests: SPIKE_MIN_ERRORS,
        errors: SPIKE_MIN_ERRORS,
        crashes: 0,
      });
      expect(contents()).toHaveLength(1);
      expect(contents()[0]).toMatchObject({ event: "error.spike", errors: SPIKE_MIN_ERRORS });
      // Visibility (RED today): exactly one clean, classified line.
      expect(diagnostics()).toHaveLength(1);
      expectDiagnostic(diagnostics()[0], "spike", kind);
      expectClean(allLines());
    },
  );

  it("the three spike failure classes are distinguishable in sequence, one line each", async () => {
    const { worker, contents, diagnostics, allLines, localCounts } = makeWorker();
    const queue: [FailureClass, string][] = [
      ["nonOk", CANARY.spikeNonOk],
      ["unparseable", CANARY.spikeUnparseable],
      ["wrongShape", CANARY.spikeShape],
    ];
    let observeCalls = 0;
    const { env } = aggregatorEnv((path) => {
      if (path !== "/observe") return Response.json(null);
      const [kind, canary] = queue[Math.min(observeCalls, queue.length - 1)] ?? [
        "nonOk",
        CANARY.spikeNonOk,
      ];
      observeCalls += 1;
      return malfunction(kind, canary, { event: "error.spike", script: 123, note: canary });
    });
    // Sub-threshold batches: counting proves each fallback ran; no page.
    for (let i = 0; i < queue.length; i += 1) {
      await worker.tail(burst(1, t0), env);
      expect(localCounts().errors).toBe(i + 1);
    }
    expect(contents()).toHaveLength(0);
    expect(diagnostics()).toHaveLength(3);
    queue.forEach(([kind], i) => expectDiagnostic(diagnostics()[i], "spike", kind));
    // Not one repeated generic line: the class identity differs per line.
    expect(new Set(diagnostics()).size).toBe(3);
    expectClean(allLines());
  });
});

describe("acceptance: health-path malfunction fallbacks emit exactly one diagnostic per run", () => {
  const healthCases: [string, FailureClass, string][] = [
    ["non-OK", "nonOk", CANARY.healthNonOk],
    ["unparseable 200", "unparseable", CANARY.healthUnparseable],
    ["wrong-shape 200", "wrongShape", CANARY.healthShape],
  ];
  it.each(healthCases)(
    "%s: local health observes, pages past two minutes red, one health diagnostic per run",
    async (_name, kind, canary) => {
      const start = t0 + 60_000; // :01 slot keeps five-minute synthetics out.
      const { worker, health, contents, diagnostics, allLines, setNow } = makeWorker(start);
      const { env } = aggregatorEnv((path) =>
        path === "/health" ? malfunction(kind, canary, { downMs: canary }) : Response.json(null),
      );
      const first = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
      await worker.scheduled(first, env);
      // Fallback verdict unchanged (already true today).
      expect(health.snapshot().downSince).toBe(start);
      expect(contents()).toHaveLength(0);
      // Visibility (RED today): exactly one clean, classified line.
      expect(diagnostics()).toHaveLength(1);
      expectDiagnostic(diagnostics()[0], "health", kind);
      expectClean(allLines());

      const later = start + 121_000;
      setNow(later);
      const second = { cron: "* * * * *", scheduledTime: later, noRetry() {} };
      await worker.scheduled(second, env);
      expect(contents()).toHaveLength(1);
      expect(contents()[0]).toMatchObject({ event: "uptime.down", down_seconds: 121 });
      // Second fallback run: exactly one more line, same class.
      expect(diagnostics()).toHaveLength(2);
      expectDiagnostic(diagnostics()[1], "health", kind);
      expectClean(allLines());
    },
  );

  it("wrong-shape 200 on a healthy probe: local recovery is observed, plus one health diagnostic", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents, diagnostics, allLines } = makeWorker(start, 200);
    health.restore({ downSince: t0, cooldownUntil: 0, pendingAt: null });
    const { env } = aggregatorEnv((path) =>
      path === "/health"
        ? malfunction("wrongShape", CANARY.healthShape, { downMs: CANARY.healthShape })
        : Response.json(null),
    );
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(health.snapshot().downSince).toBeNull();
    expect(contents()).toHaveLength(0);
    expect(diagnostics()).toHaveLength(1);
    expectDiagnostic(diagnostics()[0], "health", "wrongShape");
    expectClean(allLines());
  });
});

describe("acceptance: well-formed aggregator answers stay silent (positive controls)", () => {
  it("control: a genuine spike from the aggregator pages exactly once with no diagnostic", async () => {
    const { worker, tracker, contents, diagnostics, allLines } = makeWorker();
    const { env, paths } = aggregatorEnv((path) =>
      path === "/observe" ? Response.json(wellFormedSpike) : Response.json(null),
    );
    await worker.tail([fetchTrace(500)], env);
    expect(paths).toEqual(["/observe", "/spike-result"]);
    expect(contents()).toHaveLength(1);
    expect(contents()[0]).toEqual(wellFormedSpike);
    expect(tracker.snapshot()).toEqual({});
    expect(diagnostics()).toEqual([]);
    expectClean(allLines());
  });

  it("control: a well-formed spike null neither pages nor diagnoses", async () => {
    const { worker, contents, diagnostics, localCounts } = makeWorker();
    const { env } = aggregatorEnv(() => Response.json(null));
    await worker.tail(burst(SPIKE_MIN_ERRORS), env);
    expect(localCounts()).toEqual({ requests: 0, errors: 0, crashes: 0 });
    expect(contents()).toHaveLength(0);
    expect(diagnostics()).toEqual([]);
  });

  it("control: a well-formed health downMs pages exactly once with no diagnostic", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents, diagnostics, allLines } = makeWorker(start);
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
    expect(health.snapshot().downSince).toBeNull();
    expect(diagnostics()).toEqual([]);
    expectClean(allLines());
  });

  it("control: a well-formed health null on a red probe neither observes locally nor diagnoses", async () => {
    const start = t0 + 60_000;
    const { worker, health, contents, diagnostics } = makeWorker(start);
    const { env } = aggregatorEnv(() => Response.json(null));
    const event = { cron: "* * * * *", scheduledTime: start, noRetry() {} };
    await worker.scheduled(event, env);
    expect(health.snapshot().downSince).toBeNull();
    expect(contents()).toHaveLength(0);
    expect(diagnostics()).toEqual([]);
  });
});
