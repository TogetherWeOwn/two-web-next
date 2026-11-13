import { afterEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { runRumCheck } from "../ci/rum-check.mjs";

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

const run = (response: unknown, opts: { env?: Record<string, string>; extra?: object } = {}) => {
  const fetchImpl = typeof response === "function" ? response : async () => response;
  return runRumCheck({
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

describe("diagnostic collection health", () => {
  it("treats missing configuration as code 0 without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await run(fetchImpl, { env: {} });
    expect(r).toMatchObject({
      code: 0,
      kind: "skipped",
      collectionHealth: "not-configured",
      metricVerdict: "not-evaluated",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(r.summary).toContain("Collection health: **not-configured**");
    expect(r.summary).toContain("Metric verdict: **not-evaluated**");
  });

  it.each([0, 19, 49])("treats %i samples as code 0 insufficient", async (count) => {
    const r = await run(json(bodyFor(count, count === 0 ? null : goodQuantiles)));
    expect(r).toMatchObject({
      code: 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("Collection health: **insufficient**");
    expect(r.summary).toContain("Metric verdict: **not-evaluated**");
    expect(r.summary).not.toContain("| ok |");
  });

  it("reports the observed 19-sample production window as missing evidence", async () => {
    const r = await run(
      json(
        bodyFor(19, {
          largestContentfulPaintP75: 1_288_000,
          cumulativeLayoutShiftP75: 0,
          interactionToNextPaintP75: -1,
        }),
      ),
    );
    expect(r).toMatchObject({
      code: 0,
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
    const r = await run(
      json(bodyFor(50, { ...goodQuantiles, largestContentfulPaintP75: 3_100_000 })),
      { extra: { budget: { ...budget, minSamples: 100 }, onSummary } },
    );
    expect(r).toMatchObject({
      code: 0,
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
    const r = await run(
      json({ data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [] }] } } }),
    );
    expect(r).toMatchObject({
      code: 0,
      kind: "insufficient",
      collectionHealth: "insufficient",
      metricVerdict: "not-evaluated",
    });
    expect(r.summary).toContain("0 sample(s)");
  });

  it("passes 50 healthy in-budget samples", async () => {
    const r = await run(json(bodyFor(50)));
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
    const r = await run(
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
    const r = await run(
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
    const r = await run(json(bodyFor(500, all)));
    expect(r).toMatchObject({ code: 0, collectionHealth: "healthy", metricVerdict: "unavailable" });
    expect(r.summary).toContain("Metric verdict: **unavailable**");
    expect(r.summary).toContain("n/a");
    expect(r.summary).not.toContain("| ok |");
  });

  it("keeps negative API quantiles as n/a: some unavailable", async () => {
    const r = await run(json(bodyFor(500, { ...goodQuantiles, cumulativeLayoutShiftP75: -1 })));
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
      const r = await run(response);
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
      const r = await run(response, { extra });
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
