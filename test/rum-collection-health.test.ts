import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";
// @ts-expect-error Standalone tooling has no declaration file.
import { runRumCheck, runRumCheckWithRateLimitRetry } from "../ci/rum-check.mjs";

const root = resolve(__dirname, "..");

const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };
const env = {
  CF_ANALYTICS_READ_TOKEN: "token-marker-abc123",
  CF_RUM_ACCOUNT_ID: "account-marker-abc123",
  CF_RUM_SITE_TAG: "site-marker-abc123",
};

type Quantiles = Record<string, number>;
const goodQuantiles: Quantiles = {
  largestContentfulPaintP75: 1_800_000,
  cumulativeLayoutShiftP75: 0.05,
  interactionToNextPaintP75: 150_000,
};
const bodyFor = (count: number, quantiles: Quantiles | null = goodQuantiles) => ({
  data: {
    viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{ count, quantiles }] }] },
  },
});
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, ...init });

const run = (
  response: unknown,
  opts: { requireCollection?: boolean; env?: Record<string, string>; extra?: object } = {},
) => {
  const fetchImpl = typeof response === "function" ? response : async () => response;
  return runRumCheck({
    ...(opts.requireCollection === undefined ? {} : { requireCollection: opts.requireCollection }),
    env: opts.env ?? env,
    fetchImpl: fetchImpl as never,
    budget,
    onSummary: vi.fn(),
    ...opts.extra,
  });
};

afterEach(() => {
  vi.useRealTimers();
});

describe.each([false, true])("collection health (required: %s)", (requireCollection) => {
  const check = (response: unknown, opts: { env?: Record<string, string>; extra?: object } = {}) =>
    run(response, { ...opts, requireCollection });
  it("reports missing configuration without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await check(fetchImpl, { env: {} });
    expect(r).toMatchObject({
      code: requireCollection ? 2 : 0,
      kind: "skipped",
      collectionHealth: "not-configured",
      metricVerdict: "not-evaluated",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.summary).toContain("Collection health: **not-configured**");
    expect(r.summary).toContain("Metric verdict: **not-evaluated**");
  });

  it.each([0, 19, 49])("reports %i samples as insufficient", async (count) => {
    const r = await check(json(bodyFor(count, count === 0 ? null : goodQuantiles)));
    expect(r).toMatchObject({
      code: requireCollection ? 2 : 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("Collection health: **insufficient**");
    expect(r.summary).toContain("Metric verdict: **not-evaluated**");
    expect(r.summary).not.toContain("| ok |");
  });

  it("reports the observed 19-sample production window as missing evidence", async () => {
    const r = await check(
      json(
        bodyFor(19, {
          largestContentfulPaintP75: 1_288_000,
          cumulativeLayoutShiftP75: 0,
          interactionToNextPaintP75: -1,
        }),
      ),
    );
    expect(r).toMatchObject({
      code: requireCollection ? 2 : 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("| LCP p75 (ms) | 1288 | 2500 | not evaluated |");
    expect(r.summary).toContain("| INP p75 (ms) | n/a | 200 | unavailable |");
    expect(r.summary).not.toContain("| ok |");
  });

  it("does not evaluate an over-budget value below the configured sample floor", async () => {
    const onSummary = vi.fn();
    const r = await check(
      json(bodyFor(50, { ...goodQuantiles, largestContentfulPaintP75: 3_100_000 })),
      { extra: { budget: { ...budget, minSamples: 100 }, onSummary } },
    );
    expect(r).toMatchObject({
      code: requireCollection ? 2 : 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("| LCP p75 (ms) | 3100 | 2500 | not evaluated |");
    expect(r.summary).not.toContain("**over**");
    expect(onSummary).toHaveBeenCalledTimes(1);
    expect(onSummary).toHaveBeenCalledWith(r.summary);
  });

  it("reports an admitted empty group list as insufficient", async () => {
    const r = await check(
      json({ data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [] }] } } }),
    );
    expect(r).toMatchObject({
      code: requireCollection ? 2 : 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("0 sample(s)");
  });

  it("passes 50 healthy in-budget samples", async () => {
    const r = await check(json(bodyFor(50)));
    expect(r).toMatchObject({
      code: 0,
      kind: "pass",
      collectionHealth: "healthy",
      metricVerdict: "pass",
    });
    expect(r.summary).toContain("Collection health: **healthy**");
    expect(r.summary).toContain("Metric verdict: **pass**");
  });

  it("fails a threshold breach with healthy collection", async () => {
    const r = await check(
      json(bodyFor(500, { ...goodQuantiles, largestContentfulPaintP75: 3_100_000 })),
    );
    expect(r).toMatchObject({
      code: 1,
      kind: "over-budget",
      collectionHealth: "healthy",
      metricVerdict: "over-budget",
    });
    expect(r.summary).toContain("Collection health: **healthy**");
    expect(r.summary).toContain("Metric verdict: **over-budget**");
  });

  it("reports partial metric coverage alongside an over-budget verdict", async () => {
    const r = await check(
      json(
        bodyFor(500, {
          ...goodQuantiles,
          largestContentfulPaintP75: 3_100_000,
          cumulativeLayoutShiftP75: -1,
        }),
      ),
    );
    expect(r).toMatchObject({
      code: 1,
      kind: "over-budget",
      metricVerdict: "over-budget (partial)",
    });
    expect(r.summary).toContain("Metric verdict: **over-budget (partial)**");
    expect(r.summary).toContain("| CLS p75 | n/a | 0.1 | unavailable |");
  });

  it("keeps negative API quantiles as n/a: all unavailable", async () => {
    const all = {
      largestContentfulPaintP75: -1,
      cumulativeLayoutShiftP75: -1,
      interactionToNextPaintP75: -1,
    };
    const r = await check(json(bodyFor(500, all)));
    expect(r).toMatchObject({ code: 0, collectionHealth: "healthy", metricVerdict: "unavailable" });
    expect(r.summary).toContain("Metric verdict: **unavailable**");
    expect(r.summary).toContain("n/a");
    expect(r.summary).not.toContain("| ok |");
  });

  it("keeps negative API quantiles as n/a: some unavailable", async () => {
    const r = await check(json(bodyFor(500, { ...goodQuantiles, cumulativeLayoutShiftP75: -1 })));
    expect(r).toMatchObject({ code: 0, collectionHealth: "healthy", metricVerdict: "partial" });
    expect(r.summary).toContain("Metric verdict: **partial**");
    expect(r.summary).toMatch(/\| CLS p75 \| n\/a \| [\d.]+ \| (?!ok)/);
  });

  it("fails malformed JSON and shapes as invalid-response", async () => {
    const responses = [
      new Response("not json"),
      json({}),
      json({ data: null }),
      json({ data: { viewer: { accounts: [] } } }),
      json(bodyFor(500, null)),
    ];
    for (const response of responses) {
      const r = await check(response);
      expect(r).toMatchObject({
        code: 1,
        kind: "invalid-response",
        collectionHealth: "invalid-response",
        metricVerdict: "not-evaluated",
      });
      expect(r.summary).toContain("Collection health: **invalid-response**");
      expect(r.summary).toContain("Metric verdict: **not-evaluated**");
    }
  });

  it("marks transport failures unavailable without leaking provider data", async () => {
    const cases: Array<[string, unknown, object?]> = [
      ["query-failed", new Response("<html>provider-secret-marker</html>", { status: 502 })],
      ["query-failed", new Response("{}", { status: 401 })],
      ["query-failed", () => Promise.reject(new Error("token-marker-abc123"))],
      ["query-failed", json({ ...bodyFor(500), errors: [{ message: "provider-secret-marker" }] })],
      ["response-too-large", json(bodyFor(500)), { maxResponseBytes: 16 }],
      ["timeout", () => new Promise(() => {}), { timeoutMs: 20 }],
    ];
    for (const [kind, response, extra] of cases) {
      const r = await check(response, { extra });
      expect(r, kind).toMatchObject({
        code: 1,
        kind,
        collectionHealth: "unavailable",
        metricVerdict: "not-evaluated",
      });
      expect(r.summary).toContain("Collection health: **unavailable**");
      expect(r.summary).toContain("Metric verdict: **not-evaluated**");
      expect(r.summary).not.toMatch(/marker/);
    }
  });
});

describe("optional collection mode", () => {
  it.each([undefined, false])("keeps code 0 skipped with explicit fields (%s)", async (flag) => {
    const fetchImpl = vi.fn();
    const r = await run(fetchImpl, { requireCollection: flag, env: {} });
    expect(r).toMatchObject({
      code: 0,
      kind: "skipped",
      collectionHealth: "not-configured",
      metricVerdict: "not-evaluated",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([undefined, false])(
    "keeps code 0 insufficient with explicit fields (%s)",
    async (flag) => {
      const r = await run(json(bodyFor(10)), { requireCollection: flag });
      expect(r).toMatchObject({
        code: 0,
        kind: "insufficient",
        collectionHealth: "insufficient",
        metricVerdict: "not-evaluated",
      });
      expect(r.summary).toContain("Collection health: **insufficient**");
      expect(r.summary).toContain("Metric verdict: **not-evaluated**");
      expect(r.summary).not.toContain("| ok |");
    },
  );
});

describe("required mode through the rate-limit retry wrapper", () => {
  it("preserves the requirement across 429 then low samples", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(new Response("{}", { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(json(bodyFor(10)));
    const pending = runRumCheckWithRateLimitRetry({
      requireCollection: true,
      env,
      fetchImpl,
      budget,
      onSummary: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(1000);
    const r = await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(r).toMatchObject({
      code: 2,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
  });

  it.each([401, 403])("does not retry HTTP %i", async (status) => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status }));
    const r = await runRumCheckWithRateLimitRetry({
      requireCollection: true,
      env,
      fetchImpl,
      budget,
      onSummary: vi.fn(),
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(r).toMatchObject({
      code: 1,
      kind: "query-failed",
      collectionHealth: "unavailable",
      metricVerdict: "not-evaluated",
    });
  });
});

describe("CLI --require-collection", () => {
  it("exits 2 with no configuration", () => {
    const r = spawnSync(process.execPath, ["ci/rum-check.mjs", "--require-collection"], {
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toContain("Collection health: **not-configured**");
  });
});

describe("rum-web-vitals workflow", () => {
  const workflow = parse(
    readFileSync(resolve(root, ".github/workflows/rum-web-vitals.yml"), "utf8"),
  );
  const job = workflow.jobs["web-vitals"];

  it("runs the exact required-collection command without continue-on-error", () => {
    const runSteps = job.steps.filter((s: { run?: string }) => s.run?.includes("rum-check"));
    expect(runSteps).toHaveLength(1);
    expect(runSteps[0].run.trim()).toBe("node ci/rum-check.mjs --require-collection");
    for (const step of job.steps) expect(step["continue-on-error"]).toBeUndefined();
    expect(job["continue-on-error"]).toBeUndefined();
  });

  it("keeps the schedule, timeout and read-only permissions", () => {
    expect(workflow.on.schedule).toEqual([{ cron: "23 4 * * *" }]);
    expect(job["timeout-minutes"]).toBe(8);
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(job.permissions).toBeUndefined();
  });
});
