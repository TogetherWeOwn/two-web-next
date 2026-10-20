import { describe, expect, it, vi } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { admitRumResponse, evaluate, runRumCheck } from "../ci/rum-check.mjs";

const budget = { lcpMs: 2500, cls: 0.1, inpMs: 200, minSamples: 50 };
type Row = { name: string; value: number | null };

describe("ci/rum-check.mjs", () => {
  it("passes within budget", () => {
    // Fixtures are in API units: LCP/INP p75 in microseconds, CLS unitless.
    const r = evaluate(
      {
        largestContentfulPaintP75: 1_800_000,
        cumulativeLayoutShiftP75: 0.05,
        interactionToNextPaintP75: 150_000,
      },
      budget,
      500,
    );
    expect(r.failed).toHaveLength(0);
    expect(r.rows.map((x: Row) => x.value)).toEqual([1800, 0.05, 150]);
  });

  it("fails when any p75 is over budget", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: 3_100_000,
        cumulativeLayoutShiftP75: 0.05,
        interactionToNextPaintP75: 150_000,
      },
      budget,
      500,
    );
    expect(r.failed.map((x: Row) => x.name)).toEqual(["LCP p75 (ms)"]);
  });

  it("never fails with too few samples", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: 9_000_000,
        cumulativeLayoutShiftP75: 1,
        interactionToNextPaintP75: 900_000,
      },
      budget,
      10,
    );
    expect(r.enoughData).toBe(false);
    expect(r.failed).toHaveLength(0);
  });

  it("reports missing metrics as n/a, not failures", () => {
    const r = evaluate({}, budget, 500);
    expect(r.failed).toHaveLength(0);
    expect(r.rows.every((x: Row) => x.value === null)).toBe(true);
  });

  it("reports the API negative N/A value as n/a, not a pass", () => {
    const r = evaluate(
      {
        largestContentfulPaintP75: -1,
        cumulativeLayoutShiftP75: -1,
        interactionToNextPaintP75: -1,
      },
      budget,
      500,
    );
    expect(r.failed).toHaveLength(0);
    expect(r.rows.every((x: Row) => x.value === null)).toBe(true);
  });
});

describe("ci/rum-check.mjs response admission", () => {
  const validGroup = (overrides = {}) => ({
    count: 500,
    quantiles: {
      largestContentfulPaintP75: 1_800_000,
      cumulativeLayoutShiftP75: 0.05,
      interactionToNextPaintP75: 150_000,
    },
    ...overrides,
  });
  const validBody = (group = validGroup()) => ({
    data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [group] }] } },
  });

  it("rejects missing/null GraphQL data instead of counting zero", () => {
    for (const body of [{}, { data: null }, { data: {} }, { data: { viewer: null } }]) {
      expect(() => admitRumResponse(body), JSON.stringify(body)).toThrow(/Response invalid/);
    }
  });

  it("rejects malformed account/group structure", () => {
    const broken = [
      { data: { viewer: { accounts: null } } },
      { data: { viewer: { accounts: [] } } },
      { data: { viewer: { accounts: [null] } } },
      {
        data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: null }] } },
      },
      {
        data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [null] }] } },
      },
      {
        data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{}] }] } },
      },
    ];
    for (const body of broken) {
      expect(() => admitRumResponse(body), JSON.stringify(body)).toThrow(/Response invalid/);
    }
  });

  it("rejects invalid sample counts", () => {
    for (const count of [undefined, null, "500", 12.5, -1, Number.NaN, Infinity]) {
      const body = validBody(validGroup({ count }));
      expect(() => admitRumResponse(body), `count=${String(count)}`).toThrow(/Response invalid/);
    }
  });

  it("accepts a structurally valid empty result as zero samples", () => {
    const emptyGroups = {
      data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [] }] } },
    };
    expect(admitRumResponse(emptyGroups)).toEqual({ count: 0, quantiles: undefined });
  });

  it("accepts N/A quantiles as legitimate data", () => {
    const admitted = admitRumResponse(
      validBody(
        validGroup({
          quantiles: {
            largestContentfulPaintP75: -1,
            cumulativeLayoutShiftP75: -1,
            interactionToNextPaintP75: -1,
          },
        }),
      ),
    );
    expect(admitted.count).toBe(500);
  });

  it("rejects samples without numeric p75 quantiles instead of passing all-n/a", () => {
    const full = {
      largestContentfulPaintP75: 1_800_000,
      cumulativeLayoutShiftP75: 0.05,
      interactionToNextPaintP75: 150_000,
    };
    const broken = [
      undefined,
      null,
      {},
      { ...full, largestContentfulPaintP75: undefined },
      { ...full, cumulativeLayoutShiftP75: null },
      { ...full, interactionToNextPaintP75: "150000" },
      { ...full, largestContentfulPaintP75: Number.NaN },
    ];
    for (const quantiles of broken) {
      expect(
        () => admitRumResponse(validBody(validGroup({ quantiles }))),
        String(quantiles),
      ).toThrow(/Response invalid/);
    }
  });

  it("requires numeric quantiles only once a group reaches minSamples", () => {
    expect(admitRumResponse(validBody(validGroup({ count: 49, quantiles: null })), 50)).toEqual({
      count: 49,
      quantiles: null,
    });
    expect(() =>
      admitRumResponse(validBody(validGroup({ count: 50, quantiles: null })), 50),
    ).toThrow(/Response invalid/);
  });

  it("rejects non-object quantiles at any sample count", () => {
    for (const quantiles of [5, "quantiles", []]) {
      expect(() => admitRumResponse(validBody(validGroup({ count: 10, quantiles })), 50)).toThrow(
        /Response invalid/,
      );
    }
  });

  it("accepts a zero-sample group without quantiles", () => {
    expect(admitRumResponse(validBody(validGroup({ count: 0, quantiles: undefined })))).toEqual({
      count: 0,
      quantiles: undefined,
    });
  });
});

describe("ci/rum-check.mjs injected fetch", () => {
  const env = {
    CF_ANALYTICS_READ_TOKEN: "token-marker-abc123",
    CF_RUM_ACCOUNT_ID: "account-marker-abc123",
    CF_RUM_SITE_TAG: "site-marker-abc123",
  };
  const jsonResponse = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status });
  const run = (
    responseOrFetch: unknown,
    runEnv: Record<string, string> = env,
    runBudget = budget,
  ) => {
    const fetchFn =
      typeof responseOrFetch === "function" ? responseOrFetch : async () => responseOrFetch;
    return runRumCheck({
      env: runEnv,
      fetchImpl: fetchFn as never,
      budget: runBudget,
      onSummary: vi.fn(),
    });
  };

  it("fails invalid JSON instead of reporting insufficient data", async () => {
    const r = await run(new Response("not json"));
    expect(r.code).toBe(1);
    expect(r.kind).toBe("invalid-response");
    expect(r.summary).toMatch(/Response invalid/);
    expect(r.summary).not.toMatch(/below minSamples/);
  });

  it("reports non-2xx non-JSON gateway pages as query failures with the HTTP status", async () => {
    for (const status of [502, 429]) {
      const r = await run(new Response("<html>gateway</html>", { status }));
      expect(r.code, String(status)).toBe(1);
      expect(r.kind, String(status)).toBe("query-failed");
      expect(r.summary, String(status)).toContain(`HTTP ${status}`);
      expect(r.summary, String(status)).not.toMatch(/Response invalid/);
    }
  });

  it("fails {} and data:null instead of reporting insufficient data", async () => {
    for (const body of [{}, { data: null }]) {
      const r = await run(jsonResponse(body));
      expect(r.code, JSON.stringify(body)).toBe(1);
      expect(r.kind, JSON.stringify(body)).toBe("invalid-response");
      expect(r.summary).toMatch(/Response invalid/);
    }
  });

  it("fails malformed groups and invalid counts", async () => {
    const broken = [
      { data: { viewer: { accounts: [] } } },
      { data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{}] }] } } },
      {
        data: {
          viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{ count: "500" }] }] },
        },
      },
    ];
    for (const body of broken) {
      const r = await run(jsonResponse(body));
      expect(r.code, JSON.stringify(body)).toBe(1);
      expect(r.kind).toBe("invalid-response");
    }
  });

  it("keeps structurally valid empty/low-sample results as insufficient data", async () => {
    const empty = {
      data: { viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [] }] } },
    };
    const emptyResult = await run(jsonResponse(empty));
    expect(emptyResult.code).toBe(0);
    expect(emptyResult.kind).toBe("insufficient");
    expect(emptyResult.summary).toMatch(/below minSamples/);

    const lowSample = {
      data: {
        viewer: {
          accounts: [
            {
              rumWebVitalsEventsAdaptiveGroups: [
                {
                  count: 10,
                  quantiles: {
                    largestContentfulPaintP75: 9_000_000,
                    cumulativeLayoutShiftP75: 1,
                    interactionToNextPaintP75: 900_000,
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const lowResult = await run(jsonResponse(lowSample));
    expect(lowResult.code).toBe(0);
    expect(lowResult.kind).toBe("insufficient");
  });

  it("distinguishes admission failures from over-budget failures", async () => {
    const overBudget = {
      data: {
        viewer: {
          accounts: [
            {
              rumWebVitalsEventsAdaptiveGroups: [
                {
                  count: 500,
                  quantiles: {
                    largestContentfulPaintP75: 3_100_000,
                    cumulativeLayoutShiftP75: 0.05,
                    interactionToNextPaintP75: 150_000,
                  },
                },
              ],
            },
          ],
        },
      },
    };
    const r = await run(jsonResponse(overBudget));
    expect(r.code).toBe(1);
    expect(r.kind).toBe("over-budget");
    expect(r.summary).toMatch(/over/);
    expect(r.summary).not.toMatch(/Response invalid/);
  });

  it("keeps a low-sample day with missing quantiles as insufficient data", async () => {
    const lowSampleNoQuantiles = {
      data: {
        viewer: {
          accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{ count: 10, quantiles: null }] }],
        },
      },
    };
    const r = await run(jsonResponse(lowSampleNoQuantiles));
    expect(r.code).toBe(0);
    expect(r.kind).toBe("insufficient");
  });

  it("applies the configured minSamples when admitting the response", async () => {
    const countAt = (count: number) => ({
      data: {
        viewer: { accounts: [{ rumWebVitalsEventsAdaptiveGroups: [{ count, quantiles: null }] }] },
      },
    });
    const raisedThreshold = await run(jsonResponse(countAt(100)), env, {
      ...budget,
      minSamples: 200,
    });
    expect(raisedThreshold.kind).toBe("insufficient");
    expect(raisedThreshold.code).toBe(0);

    const loweredThreshold = await run(jsonResponse(countAt(30)), env, {
      ...budget,
      minSamples: 20,
    });
    expect(loweredThreshold.kind).toBe("invalid-response");
    expect(loweredThreshold.code).toBe(1);
  });

  it("keeps the unconfigured skip without calling fetch", async () => {
    const fetchImpl = vi.fn();
    const r = await run(fetchImpl, {});
    expect(r.code).toBe(0);
    expect(r.kind).toBe("skipped");
    expect(r.summary).toMatch(/Not configured/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fails GraphQL errors even with valid in-budget data", async () => {
    const validWithErrors = {
      data: {
        viewer: {
          accounts: [
            {
              rumWebVitalsEventsAdaptiveGroups: [
                {
                  count: 500,
                  quantiles: {
                    largestContentfulPaintP75: 1_800_000,
                    cumulativeLayoutShiftP75: 0.05,
                    interactionToNextPaintP75: 150_000,
                  },
                },
              ],
            },
          ],
        },
      },
      errors: [{ message: "partial-failure-marker" }],
    };
    const r = await run(jsonResponse(validWithErrors));
    expect(r.code).toBe(1);
    expect(r.kind).toBe("query-failed");
    expect(r.summary).toContain("HTTP 200");
    expect(r.summary).toContain("1 GraphQL error(s)");
    expect(r.summary).not.toContain("partial-failure-marker");
  });

  it("keeps synchronous and rejected network failures classified and payload-free", async () => {
    for (const fetchImpl of [
      () => {
        throw new Error("token-marker-abc123");
      },
      () => Promise.reject(new Error("account-marker-abc123")),
    ]) {
      const r = await run(fetchImpl);
      expect(r.kind).toBe("query-failed");
      expect(r.code).toBe(1);
      expect(r.summary).toContain("Budgets not evaluated.");
      expect(r.summary).not.toMatch(/marker-abc123/);
    }
  });

  it("disposes a response arriving after timeout without starting its reader", async () => {
    vi.useFakeTimers();
    let resolveFetch!: (value: unknown) => void;
    const cancel = vi.fn(() => Promise.reject(new Error("late disposal")));
    const getReader = vi.fn();
    const onSummary = vi.fn();
    try {
      const pending = runRumCheck({
        env,
        budget,
        timeoutMs: 100,
        fetchImpl: () => new Promise((resolve) => (resolveFetch = resolve)),
        onSummary,
      });
      await vi.advanceTimersByTimeAsync(100);
      expect(await pending).toMatchObject({ code: 1, kind: "timeout" });
      resolveFetch({ body: { cancel, getReader } });
      await vi.advanceTimersByTimeAsync(0);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(getReader).not.toHaveBeenCalled();
      expect(onSummary).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["resolve", "reject"])(
    "ignores a late read %s even when read and cancellation both ignore abort",
    async (outcome) => {
      vi.useFakeTimers();
      let resolveRead!: (value: unknown) => void;
      let rejectRead!: (err: Error) => void;
      const reader = {
        read: vi.fn(
          () =>
            new Promise((resolve, reject) => {
              resolveRead = resolve;
              rejectRead = reject;
            }),
        ),
        cancel: vi.fn(() => new Promise(() => {})),
        releaseLock: vi.fn(),
      };
      const onSummary = vi.fn();
      try {
        const pending = runRumCheck({
          env,
          budget,
          timeoutMs: 100,
          fetchImpl: async () => ({ ok: true, status: 200, body: { getReader: () => reader } }),
          onSummary,
        });
        await vi.advanceTimersByTimeAsync(100);
        expect(await pending).toMatchObject({ code: 1, kind: "timeout" });
        expect(reader.cancel).toHaveBeenCalledTimes(1);
        expect(reader.releaseLock).toHaveBeenCalledTimes(1);
        if (outcome === "resolve") {
          resolveRead({ done: false, value: new TextEncoder().encode("late payload") });
        } else {
          rejectRead(new Error("late read failed"));
        }
        await vi.advanceTimersByTimeAsync(0);
        expect(reader.read).toHaveBeenCalledTimes(1);
        expect(onSummary).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("bounds failure summaries and omits payloads, credentials and identity", async () => {
    const hostile = {
      data: { viewer: { accounts: [] } },
      errors: [{ message: `x`.repeat(5000) + " token-marker-abc123" }],
      secret: "token-marker-abc123",
    };
    const r = await run(jsonResponse(hostile));
    expect(r.code).toBe(1);
    expect(r.summary.length).toBeLessThan(2000);
    expect(r.summary).not.toContain("token-marker-abc123");
    expect(r.summary).not.toContain("account-marker-abc123");
    expect(r.summary).not.toContain("site-marker-abc123");
    expect(r.summary).not.toContain(`x`.repeat(100));
  });
});
