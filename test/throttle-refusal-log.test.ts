import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogBudget, createRateLimitedWarn } from "../src/log-budget";

afterEach(() => vi.restoreAllMocks());

describe("log budget instances", () => {
  it("preserves custom warn budgets, fractional refill and pending shed counts", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = createRateLimitedWarn({ shedLine: "custom.shed", burst: 2, refillMs: 100 });
    const fields = { outcome: "refused", status: 429, sampled: false, detail: null };
    log.warn("custom.refused", fields);
    log.warn("custom.refused", fields);
    log.warn("custom.refused", fields);
    now = 10_050;
    log.warn("custom.refused", fields);
    now = 10_099;
    log.warn("custom.refused", fields);
    now = 10_100;
    log.warn("custom.refused", fields);
    log.warn("custom.refused", fields);
    expect(warn.mock.calls).toEqual([
      ["custom.refused", fields],
      ["custom.refused", fields],
      ["custom.shed", { dropped: 1 }],
      ["custom.refused", fields],
      ["custom.shed", { dropped: 3 }],
    ]);
  });

  it("keeps the token API and each warn API instance independent", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const take = createLogBudget("token.shed");
    const first = createRateLimitedWarn({ shedLine: "first.shed" });
    const second = createRateLimitedWarn({ shedLine: "second.shed" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) expect(take()).toBe(true);
    expect(take()).toBe(false);
    for (let i = 0; i < 21; i++) first.warn("first.refused", { outcome: "refused" });
    second.warn("second.refused", { outcome: "refused" });
    expect(warn.mock.calls).toEqual([
      ["token.shed", { dropped: 1 }],
      ...Array.from({ length: 20 }, () => ["first.refused", { outcome: "refused" }]),
      ["first.shed", { dropped: 1 }],
      ["second.refused", { outcome: "refused" }],
    ]);
  });

  it("keeps token and shed budgets independent and resolves console.warn at call time", () => {
    vi.spyOn(Date, "now").mockReturnValue(10_000);
    const codes = ["throttle.refused.shed", "agent-events.shield.refused.shed", "csp.report.shed"];
    const budgets = codes.map(createLogBudget);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (const take of budgets) {
      for (let i = 0; i < 20; i++) expect(take()).toBe(true);
      expect(take()).toBe(false);
    }
    expect(warn.mock.calls).toEqual(codes.map((code) => [code, { dropped: 1 }]));
  });

  it("does not mint refill credit when the clock moves backward and recovers", () => {
    let now = 10_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const take = createLogBudget("throttle.refused.shed");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    for (let i = 0; i < 20; i++) expect(take()).toBe(true);
    now = 7_000;
    expect(take()).toBe(false);
    now = 10_000;
    expect(take()).toBe(false);
    now = 12_999;
    expect(take()).toBe(false);
    now = 13_000;
    expect(take()).toBe(true);
    expect(take()).toBe(false);
    expect(warn.mock.calls).toEqual([
      ["throttle.refused.shed", { dropped: 1 }],
      ["throttle.refused.shed", { dropped: 1 }],
      ["throttle.refused.shed", { dropped: 2 }],
    ]);
  });
});
