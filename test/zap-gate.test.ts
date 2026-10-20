import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { markdown, summarize } from "../ci/zap-gate.mjs";

const report = (alerts: object[]) => ({
  site: [{ "@name": "https://next.togetherweown.com", alerts }],
});
const alert = (pluginid: number, riskcode: string, name = `alert ${pluginid}`) => ({
  pluginid,
  riskcode,
  name,
  count: "2",
});
const nullBudget = { maxMedium: null, maxLow: null };

function runCli(reportJson: unknown, budgetJson: unknown): { exit: number; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "zap-gate-"));
  const reportPath = join(dir, "report.json");
  const budgetPath = join(dir, "budget.json");
  writeFileSync(reportPath, JSON.stringify(reportJson));
  writeFileSync(budgetPath, JSON.stringify(budgetJson));
  try {
    const out = execFileSync("node", ["ci/zap-gate.mjs", reportPath, budgetPath], {
      encoding: "utf8",
    });
    return { exit: 0, out };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { exit: e.status ?? 1, out: String(e.stdout ?? e.stderr ?? "") };
  }
}

describe("ci/zap-gate.mjs", () => {
  it("fails on any High alert, even with no budgets set", () => {
    const r = summarize(report([alert(10062, "3")]), { maxMedium: null, maxLow: null });
    expect(r.counts[3]).toBe(1);
    expect(r.failures).toHaveLength(1);
  });

  it("reports Medium/Low without failing while budgets are null", () => {
    const r = summarize(report([alert(10020, "2"), alert(10021, "1")]), {
      maxMedium: null,
      maxLow: null,
    });
    expect(r.failures).toEqual([]);
  });

  it("fails above a set budget and passes at or below it", () => {
    const alerts = [alert(1, "2"), alert(2, "2"), alert(3, "1")];
    expect(summarize(report(alerts), { maxMedium: 1, maxLow: 1 }).failures).toHaveLength(1);
    expect(summarize(report(alerts), { maxMedium: 2, maxLow: 1 }).failures).toEqual([]);
  });

  it("never ignores a High, scoped or unscoped", () => {
    const high = alert(10062, "3");
    const unscoped = { maxMedium: null, maxLow: null, ignore: [{ pluginId: 10062, why: "test" }] };
    const scopedHigh = {
      ...alert(10062, "3", "High alert"),
      count: "1",
      instances: [{ uri: "https://next.togetherweown.com/cdn-cgi/x" }],
    };
    const scoped = {
      maxMedium: null,
      maxLow: null,
      ignore: [{ pluginId: "10062", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const rUnscoped = summarize(report([high]), unscoped);
    expect(rUnscoped.alerts).toHaveLength(1);
    expect(rUnscoped.failures.join("; ")).toMatch(/High is never allowed/);
    const rScoped = summarize(report([scopedHigh]), scoped);
    expect(rScoped.alerts).toHaveLength(1);
    expect(rScoped.failures.join("; ")).toMatch(/High is never allowed/);
  });

  it("accepts a structurally valid zero-alert scan", () => {
    expect(summarize({ site: [] }, nullBudget).failures).toEqual([]);
    expect(summarize({ site: [{ alerts: [] }] }, nullBudget).failures).toEqual([]);
  });

  it("fails closed on missing or malformed scan structures", () => {
    expect(summarize({}, nullBudget).failures.length).toBeGreaterThan(0);
    expect(summarize(null, nullBudget).failures.length).toBeGreaterThan(0);
    expect(summarize({ site: null }, nullBudget).failures.length).toBeGreaterThan(0);
    expect(summarize({ site: [{}] }, nullBudget).failures.length).toBeGreaterThan(0);
    expect(summarize({ site: [{ alerts: null }] }, nullBudget).failures.length).toBeGreaterThan(0);
    expect(summarize({ site: [{ alerts: [null] }] }, nullBudget).failures.length).toBeGreaterThan(
      0,
    );
    expect(
      summarize(
        { site: [{ alerts: [{ pluginid: 1, riskcode: "1", instances: "x" }] }] },
        nullBudget,
      ).failures.length,
    ).toBeGreaterThan(0);
    expect(
      summarize({ site: [{ alerts: [{ riskcode: "1", name: "no-id" }] }] }, nullBudget).failures
        .length,
    ).toBeGreaterThan(0);
  });

  it("fails closed on absent or unknown risk codes", () => {
    const cases = [
      { pluginid: 1, name: "missing" },
      { pluginid: 1, riskcode: "9", name: "out-of-range" },
      { pluginid: 1, riskcode: 9, name: "numeric-out-of-range" },
      { pluginid: 1, riskcode: "", name: "empty" },
      { pluginid: 1, riskcode: "high", name: "word" },
      { pluginid: 1, riskcode: "2.5", name: "float-string" },
      { pluginid: 1, riskcode: true, name: "bool" },
    ];
    for (const c of cases) {
      expect(summarize(report([c]), nullBudget).failures.length).toBeGreaterThan(0);
    }
  });

  it("keeps explicit null report-only budgets valid and rejects bad budgets", () => {
    expect(summarize({ site: [] }, nullBudget).failures).toEqual([]);
    const bad = [
      {},
      { maxMedium: "lots", maxLow: 2 },
      { maxMedium: -1, maxLow: 2 },
      { maxMedium: 1.5, maxLow: 2 },
      { maxMedium: 4 },
      { maxMedium: null, maxLow: null, ignore: "x" },
      { maxMedium: null, maxLow: null, ignore: [{ pluginId: 1 }] },
      { maxMedium: null, maxLow: null, ignore: [{ why: "x" }] },
    ];
    for (const b of bad) {
      expect(summarize({ site: [] }, b).failures.length).toBeGreaterThan(0);
    }
  });

  it("keeps legitimate Medium/Low ignores without adding exceptions", () => {
    const low = {
      ...alert(10096, "1", "Timestamp Disclosure"),
      count: "1",
      instances: [{ uri: "https://next.togetherweown.com/cdn-cgi/x" }],
    };
    const budget = {
      maxMedium: 4,
      maxLow: 2,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    expect(summarize(report([low]), budget).failures).toEqual([]);
    const unscopedLow = {
      maxMedium: null,
      maxLow: null,
      ignore: [{ pluginId: 10096, why: "test" }],
    };
    expect(summarize(report([alert(10096, "1")]), unscopedLow).failures).toEqual([]);
  });

  it("scopes an ignore with uriPrefix to matching instances only", () => {
    const scoped = {
      ...alert(10096, "1", "Timestamp Disclosure"),
      instances: [
        {
          uri: "https://next.togetherweown.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js",
        },
        { uri: "https://next.togetherweown.com/" },
      ],
    };
    const budget = {
      maxMedium: 4,
      maxLow: 2,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([scoped]), budget);
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].count).toBe(1);
    // The surviving Worker-served hit still counts against the Low budget.
    expect(summarize(report([scoped]), { ...budget, maxLow: 0 }).failures).toHaveLength(1);
  });

  it("drops a scoped ignore only when every instance matches", () => {
    const edgeOnly = {
      ...alert(10096, "1", "Timestamp Disclosure"),
      count: "1",
      instances: [
        {
          uri: "https://next.togetherweown.com/cdn-cgi/challenge-platform/h/g/scripts/jsd/main.js",
        },
      ],
    };
    const budget = {
      maxMedium: 4,
      maxLow: 2,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([edgeOnly]), budget);
    expect(r.alerts).toHaveLength(0);
    expect(r.failures).toEqual([]);
  });

  it("keeps a scoped alert without instances, since scope cannot be proven", () => {
    const budget = {
      maxMedium: 4,
      maxLow: 0,
      ignore: [{ pluginId: "10096", uriPrefix: "/cdn-cgi/", why: "test" }],
    };
    const r = summarize(report([alert(10096, "1")]), budget);
    expect(r.alerts).toHaveLength(1);
    expect(r.failures).toHaveLength(1);
  });

  it("never prints URLs or evidence in the summary", () => {
    const withInstances = {
      ...alert(10020, "2"),
      instances: [{ uri: "https://example.invalid/secret?token=x", evidence: "leak" }],
    };
    const md = markdown(summarize(report([withInstances]), nullBudget));
    expect(md).not.toContain("example.invalid");
    expect(md).not.toContain("leak");
    expect(md).toMatch(/Medium/);
  });

  it("keeps failure diagnostics public-safe", () => {
    const evil = {
      pluginid: 1,
      riskcode: "9",
      name: "x",
      instances: [{ uri: "https://example.invalid/s?token=secret", evidence: "cred=abc" }],
    };
    const r = summarize(report([evil]), nullBudget);
    expect(r.failures.length).toBeGreaterThan(0);
    const md = markdown(r);
    expect(md).not.toContain("example.invalid");
    expect(md).not.toContain("cred=abc");
    expect(md).not.toContain("token=secret");
  });

  it("CLI agrees with the summarizer on pass and fail exits", () => {
    expect(runCli({ site: [] }, nullBudget).exit).toBe(0);
    expect(runCli({}, nullBudget).exit).not.toBe(0);
    expect(
      runCli(report([alert(10062, "3")]), {
        maxMedium: null,
        maxLow: null,
        ignore: [{ pluginId: 10062, why: "test" }],
      }).exit,
    ).not.toBe(0);
    expect(runCli(report([alert(10020, "2")]), nullBudget).exit).toBe(0);
  });

  it("reports the scanned site count without URLs or evidence", () => {
    const md = markdown(summarize({ site: [{ alerts: [] }, { alerts: [] }] }, nullBudget));
    expect(md).toMatch(/Scanned 2 site\(s\)/);
    expect(md).not.toContain("example.invalid");
  });
});
