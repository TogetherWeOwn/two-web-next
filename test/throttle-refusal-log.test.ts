import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogBudget } from "../src/log-budget";

afterEach(() => vi.restoreAllMocks());

describe("log budget instances", () => {
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
