import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
// @ts-expect-error Standalone tooling has no declaration file.
import * as rumModule from "../ci/rum-check.mjs";

// Test Author-owned: the Builder consumes this file unchanged. Tests use only
// injected Response fixtures and controlled clocks, never Analytics or credentials.
// Contract: one completed HTTP 429 may earn ONE retry, after a bounded cooldown,
// without moving the sampled window or weakening transport/metric admission.
// Existing rum-check and transport-bounds suites remain the detailed admission,
// cancellation, UTF-8 byte-counting and late-completion regression contracts.

type Result = { code: number; kind: string; summary: string };
type Options = {
  env?: Record<string, string>;
  budget?: typeof budget;
  fetchImpl?: unknown;
  onSummary?: (summary: string) => void;
  timeoutMs?: number;
  maxResponseBytes?: number;
};
type Runner = (options?: Options) => Promise<Result>;
const rum = rumModule as unknown as Record<string, unknown>;
const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };
const env = {
  CF_ANALYTICS_READ_TOKEN: "token-marker-abc123",
  CF_RUM_ACCOUNT_ID: "account-marker-abc123",
  CF_RUM_SITE_TAG: "site-marker-abc123",
};
const now = new Date("2026-10-23T12:00:00.000Z");
const healthy = (lcp = 1_800_000, count = 500) => ({
  data: {
    viewer: {
      accounts: [
        {
          rumWebVitalsEventsAdaptiveGroups: [
            {
              count,
              quantiles: {
                largestContentfulPaintP75: lcp,
                cumulativeLayoutShiftP75: 0.05,
                interactionToNextPaintP75: 150_000,
              },
            },
          ],
        },
      ],
    },
  },
});
const response = (body: unknown, status = 200, retryAfter?: string) =>
  new Response(JSON.stringify(body), {
    status,
    headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
  });
const limited = (retryAfter?: string) =>
  response({ errors: [{ message: "provider-payload-marker" }] }, 429, retryAfter);

function start(fetchImpl: unknown, options: Options = {}) {
  expect(rum.runRumCheckWithRateLimitRetry, "export the locked retry wrapper").toBeTypeOf(
    "function",
  );
  const onSummary = vi.fn();
  const state: { settled: boolean; result?: Result; error?: unknown } = { settled: false };
  const done = (rum.runRumCheckWithRateLimitRetry as Runner)({
    env,
    budget,
    fetchImpl,
    onSummary,
    ...options,
  }).then(
    (result) => {
      state.settled = true;
      state.result = result;
    },
    (error: unknown) => {
      state.settled = true;
      state.error = error;
    },
  );
  return { state, done, onSummary };
}
function resultOf(run: ReturnType<typeof start>) {
  expect(run.state.error, "classified outcomes must resolve, not reject").toBeUndefined();
  expect(run.state.settled, "run must settle within its controlled-clock bound").toBe(true);
  return run.state.result as Result;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  vi.stubGlobal("fetch", () => {
    throw new Error("Live network is forbidden in this acceptance suite");
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe("bounded RUM HTTP 429 recovery", () => {
  it("exports five-minute cooldown/maximum and preserves the existing transport bounds", () => {
    expect(rum.RUM_RATE_LIMIT_COOLDOWN_MS).toBe(300_000);
    expect(rum.RUM_MAX_RATE_LIMIT_WAIT_MS).toBe(300_000);
    expect(rum.RUM_TRANSPORT_TIMEOUT_MS).toBe(10_000);
    expect(rum.RUM_MAX_RESPONSE_BYTES).toBe(65_536);
  });

  it.each([
    ["absent", undefined, 300_000],
    ["zero seconds (minimum delay)", "0", 1_000],
    ["integer seconds", "7", 7_000],
    ["maximum seconds", "300", 300_000],
    ["future HTTP-date", "Fri, 23 Oct 2026 12:00:07 GMT", 7_000],
    ["maximum HTTP-date", "Fri, 23 Oct 2026 12:05:00 GMT", 300_000],
    ["malformed", "provider-header-marker", 300_000],
    ["negative", "-1", 300_000],
    ["past HTTP-date", "Fri, 23 Oct 2026 11:59:59 GMT", 300_000],
    ["current HTTP-date", "Fri, 23 Oct 2026 12:00:00 GMT", 300_000],
    ["fractional seconds", "1.5", 300_000],
    ["numeric fragment", "7seconds", 300_000],
    ["exponent", "1e2", 300_000],
    ["non-HTTP ISO date", "2026-10-23T12:00:07Z", 300_000],
  ] as const)(
    "waits exactly the safe delay for %s before evaluating the retry",
    async (_label, header, wait) => {
      const fetchImpl = vi
        .fn()
        .mockImplementationOnce(async () => limited(header))
        .mockImplementation(async () => response(healthy()));
      const run = start(fetchImpl);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(run.state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(fetchImpl, "never retry before the advertised/default cooldown").toHaveBeenCalledTimes(
        1,
      );
      expect(run.state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resultOf(run)).toMatchObject({ code: 0, kind: "pass" });
      expect(resultOf(run).summary).toContain("500 sample(s)");
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(["301", "2026", "9007199254740993", "9".repeat(400), "Fri, 23 Oct 2026 12:05:01 GMT"])(
    "refuses an excessive/overflow delay without clamping or retrying: %s",
    async (header) => {
      const fetchImpl = vi.fn(async () => limited(header));
      const run = start(fetchImpl);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultOf(run)).toMatchObject({ code: 1, kind: "query-failed" });
      expect(resultOf(run).summary).toContain("HTTP 429");
      expect(resultOf(run).summary).toContain("Budgets not evaluated.");
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("stops at two completed 429s, nonzero, with no third cooldown", async () => {
    const fetchImpl = vi.fn(async () => limited());
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(resultOf(run)).toMatchObject({ code: 1, kind: "query-failed" });
    expect(resultOf(run).summary).toContain("HTTP 429");
    expect(resultOf(run).summary).toContain("Budgets not evaluated.");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a second-attempt metric breach red instead of accepting recovery as success", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => limited("1"))
      .mockImplementation(async () => response(healthy(3_100_000)));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resultOf(run)).toMatchObject({ code: 1, kind: "over-budget" });
    expect(resultOf(run).summary).toContain("3100");
    expect(resultOf(run).summary).toContain("**over**");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reuses the exact 24-hour query, identity and credentials across cooldown", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => limited())
      .mockImplementation(async () => response(healthy()));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(300_000);
    expect(resultOf(run)).toMatchObject({ code: 0, kind: "pass" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const [url1, init1] = fetchImpl.mock.calls[0] ?? [];
    const [url2, init2] = fetchImpl.mock.calls[1] ?? [];
    expect(url1).toBe("https://api.cloudflare.com/client/v4/graphql");
    expect(url2).toBe(url1);
    expect(init1.method).toBe("POST");
    expect(init2.method).toBe("POST");
    expect(init1.headers).toEqual({
      authorization: "Bearer token-marker-abc123",
      "content-type": "application/json",
    });
    expect(init2.headers).toEqual(init1.headers);
    expect(init2.body).toBe(init1.body);
    const sent = JSON.parse(init1.body);
    expect(sent.query).toContain("rumWebVitalsEventsAdaptiveGroups");
    expect(sent.variables).toEqual({
      account: "account-marker-abc123",
      site: "site-marker-abc123",
      since: "2026-10-22T12:00:00.000Z",
      until: "2026-10-23T12:00:00.000Z",
    });
  });

  it("retries a completed non-JSON 429 gateway page, not just GraphQL JSON errors", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response("<html>provider-payload-marker</html>", { status: 429 }),
      )
      .mockImplementation(async () => response(healthy()));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resultOf(run)).toMatchObject({ code: 0, kind: "pass" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("starts the cooldown only after the HTTP429 body completes", async () => {
    let body!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        body = controller;
      },
    });
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(
        async () => new Response(stream, { status: 429, headers: { "Retry-After": "1" } }),
      )
      .mockImplementation(async () => response(healthy()));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(run.state.settled).toBe(false);
    body.enqueue(new TextEncoder().encode("{}"));
    body.close();
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(resultOf(run)).toMatchObject({ code: 0, kind: "pass" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a bounded safe cooldown and final failure without provider/header/identity text", async () => {
    const hostile = `provider-header-marker-${"x".repeat(4_000)}`;
    const fetchImpl = vi.fn(async () =>
      response(
        {
          errors: [{ message: `provider-payload-marker-${"y".repeat(4_000)}` }],
        },
        429,
        hostile,
      ),
    );
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(0);
    const beforeRetry = run.onSummary.mock.calls.map(([text]) => text).join("\n");
    expect(beforeRetry).toMatch(/rate.limit|cooldown|retry/i);
    expect(beforeRetry).toMatch(/300000\s*ms|300\s*s(?:ec(?:ond)?s?)?|5\s*min(?:ute)?s?/i);
    await vi.advanceTimersByTimeAsync(300_000);
    const result = resultOf(run);
    expect(result).toMatchObject({ code: 1, kind: "query-failed" });
    expect(result.summary).toContain("Budgets not evaluated.");
    expect(run.onSummary.mock.calls.length).toBeLessThanOrEqual(4);
    for (const text of [result.summary, ...run.onSummary.mock.calls.map(([text]) => text)]) {
      expect(text.length).toBeLessThan(2_000);
      expect(text).not.toMatch(/provider-(?:payload|header)-marker|marker-abc123|x{100}|y{100}/);
    }
  });
});

describe("non-rate-limit controls and incomplete-429 refusal", () => {
  it.each([
    ["401", () => response({}, 401, "1"), "query-failed"],
    ["403", () => response({}, 403, "1"), "query-failed"],
    ["500", () => response({}, 500, "1"), "query-failed"],
    ["502", () => response({}, 502, "1"), "query-failed"],
    ["503", () => response({}, 503, "1"), "query-failed"],
    [
      "HTTP200 GraphQL error",
      () => response({ ...healthy(), errors: [{ message: "HTTP 429" }] }, 200, "1"),
      "query-failed",
    ],
    [
      "malformed JSON",
      () => new Response("HTTP 429", { headers: { "Retry-After": "1" } }),
      "invalid-response",
    ],
    ["malformed data", () => response({ data: null }, 200, "1"), "invalid-response"],
    ["oversize HTTP200", () => new Response("x".repeat(65_537)), "response-too-large"],
    [
      "oversize HTTP429",
      () => new Response("x".repeat(65_537), { status: 429 }),
      "response-too-large",
    ],
    ["over budget", () => response(healthy(3_100_000)), "over-budget"],
    [
      "rejected network",
      () => Promise.reject(new Error("HTTP 429 provider-payload-marker")),
      "query-failed",
    ],
    [
      "synchronous network",
      () => {
        throw new Error("HTTP 429 provider-payload-marker");
      },
      "query-failed",
    ],
    [
      "failed HTTP429 body read",
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.error(new Error("provider-payload-marker"));
            },
          }),
          { status: 429 },
        ),
      "query-failed",
    ],
  ] as const)(
    "does not retry %s, even with rate-limit-looking text or headers",
    async (_name, fixture, kind) => {
      const fetchImpl = vi.fn(fixture);
      const run = start(fetchImpl);
      await vi.advanceTimersByTimeAsync(0);
      expect(resultOf(run)).toMatchObject({ code: 1, kind });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([200, 429])(
    "never retries a stalled HTTP%s body whose headers arrived",
    async (status) => {
      const fetchImpl = vi.fn(async () => new Response(new ReadableStream(), { status }));
      const run = start(fetchImpl);
      await vi.advanceTimersByTimeAsync(9_999);
      expect(run.state.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(resultOf(run)).toMatchObject({ code: 1, kind: "timeout" });
      expect(resultOf(run).summary).toContain("Budgets not evaluated.");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("does not retry an abort-ignoring fetch with no completed headers", async () => {
    const fetchImpl = vi.fn(() => new Promise(() => {}));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(resultOf(run)).toMatchObject({ code: 1, kind: "timeout" });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["pass", 500],
    ["insufficient", 10],
  ] as const)("keeps a healthy %s at one request", async (kind, count) => {
    const fetchImpl = vi.fn(async () => response(healthy(1_800_000, count)));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(run)).toMatchObject({ code: 0, kind });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("keeps an unconfigured skip at zero requests", async () => {
    const fetchImpl = vi.fn();
    const run = start(fetchImpl, { env: {} });
    await vi.advanceTimersByTimeAsync(0);
    expect(resultOf(run)).toMatchObject({ code: 0, kind: "skipped" });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("preserves runRumCheck as one attempt, including its HTTP429 failure", async () => {
    const fetchImpl = vi.fn(async () => limited("1"));
    const onSummary = vi.fn();
    const result = await (rum.runRumCheck as Runner)({ env, budget, fetchImpl, onSummary });
    expect(result).toMatchObject({ code: 1, kind: "query-failed" });
    expect(result.summary).toContain("HTTP 429");
    expect(result.summary).toContain("Budgets not evaluated.");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledExactlyOnceWith(result.summary);
  });
});

describe("per-attempt and whole-job bounds", () => {
  it("gives the retry its own 10s deadline after a slow first attempt plus five-minute cooldown", async () => {
    const signals: AbortSignal[] = [];
    const fetchImpl = vi.fn((_url: unknown, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      if (signals.length === 1)
        return new Promise<Response>((resolve) => setTimeout(() => resolve(limited()), 9_999));
      return new Promise<Response>(() => {});
    });
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(309_998);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(run.state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(resultOf(run)).toMatchObject({ code: 1, kind: "timeout" });
    expect(signals[1]?.aborted).toBe(true);
    expect(resultOf(run).summary).toContain("Budgets not evaluated.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("enforces the 64KiB cap on the retry, not only on the initial request", async () => {
    const fetchImpl = vi
      .fn()
      .mockImplementationOnce(async () => limited("1"))
      .mockImplementation(async () => new Response("x".repeat(65_537), { status: 429 }));
    const run = start(fetchImpl);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(resultOf(run)).toMatchObject({ code: 1, kind: "response-too-large" });
    expect(resultOf(run).summary).toContain("Budgets not evaluated.");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps the scheduled read-only job at eight minutes without changing budgets", () => {
    const workflow = parse(readFileSync(".github/workflows/rum-web-vitals.yml", "utf8"));
    expect(workflow.jobs["web-vitals"]["timeout-minutes"]).toBe(8);
    expect(workflow.on.schedule).toEqual([{ cron: "23 4 * * *" }]);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(JSON.parse(readFileSync("ci/rum-budget.json", "utf8"))).toEqual(budget);
  });
});

describe("real CLI entry point with fixture-only fetch and accelerated cooldown", () => {
  it.each([
    ["pass", 0],
    ["repeat429", 1],
    ["over-budget", 1],
  ] as const)("runs the wrapper and exits correctly for 429 -> %s", (outcome, code) => {
    // Run the actual entry point, not a source-text match. The preload replaces
    // fetch entirely and accelerates ONLY the cooldown; transport deadlines stay
    // real. The child inherits only synthetic environment, no host credentials.
    const preload = `
      import { setTimeout as realTimeout } from 'node:timers';
      let calls = 0;
      const waits = [];
      globalThis.setTimeout = (fn, ms, ...args) => {
        if (ms >= 1000 && ms !== 10000) {
          waits.push(ms);
          return realTimeout(fn, 1, ...args);
        }
        return realTimeout(fn, ms, ...args);
      };
      globalThis.fetch = async () => {
        calls++;
        if (calls > 2) throw new Error('unexpected third request');
        if (calls === 1 || ${JSON.stringify(outcome)} === 'repeat429')
          return new Response('{}', { status: 429 });
        return new Response(${JSON.stringify(JSON.stringify(healthy(outcome === "over-budget" ? 3_100_000 : 1_800_000)))});
      };
      process.on('exit', () => console.error('RUM_FIXTURE:' + JSON.stringify({ calls, waits })));
    `;
    const child = spawnSync(
      process.execPath,
      ["--import", `data:text/javascript,${encodeURIComponent(preload)}`, "ci/rum-check.mjs"],
      { env: { ...env }, encoding: "utf8", timeout: 5_000 },
    );
    expect(child.error).toBeUndefined();
    expect(child.signal).toBeNull();
    expect(child.status).toBe(code);
    expect(child.stderr).toContain('RUM_FIXTURE:{"calls":2,"waits":[300000]}');
    expect(child.stdout).not.toMatch(/marker-abc123/);
    if (outcome === "pass") expect(child.stdout).toContain("500 sample(s)");
    if (outcome === "repeat429") expect(child.stdout).toContain("Budgets not evaluated.");
    if (outcome === "over-budget") expect(child.stdout).toContain("**over**");
  });
});
