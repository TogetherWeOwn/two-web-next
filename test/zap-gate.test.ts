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

function runCli(
  reportJson: unknown,
  budgetJson: unknown,
  flags: string[] = [],
  summaryPath?: string,
): { exit: number; out: string } {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zap-gate-"));
  const reportPath = join(dir, "report.json");
  const budgetPath = join(dir, "budget.json");
  writeFileSync(reportPath, JSON.stringify(reportJson));
  writeFileSync(budgetPath, JSON.stringify(budgetJson));
  try {
    const out = execFileSync(
      process.execPath,
      ["ci/zap-gate.mjs", reportPath, budgetPath, ...flags],
      {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          ...(summaryPath === undefined ? {} : { GITHUB_STEP_SUMMARY: summaryPath }),
        },
      },
    );
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

  it.each([
    { maxMedium: 9007199254740992, maxLow: 0 },
    { ...nullBudget, ignore: [{ pluginId: [10096], why: "fixture" }] },
    { ...nullBudget, ignore: [{ pluginId: { id: 10096 }, why: "fixture" }] },
    { ...nullBudget, ignore: [{ pluginId: "010096", why: "fixture" }] },
  ])("rejects malformed policy scalars before any exemption: %j", (budget) => {
    const result = summarize(report([alert(10062, "3")]), budget);
    expect(result.error_code).toBe("invalid_evidence");
    expect(result.retryable).toBe(false);
  });

  it("accepts canonical alertRef fallback but never repairs an explicit bad identity", () => {
    const fallback = { alertRef: "10062", riskcode: "3", count: "1" };
    expect(summarize(report([fallback]), nullBudget).retryable).toBe(true);
    for (const pluginid of [null, [], "not-an-id"]) {
      const result = summarize(report([{ ...fallback, pluginid }]), nullBudget);
      expect(result.error_code).toBe("invalid_evidence");
      expect(result.retryable).toBe(false);
    }
  });

  it("keeps complete machine rows while bounding the human presentation", () => {
    const input = report(Array.from({ length: 1000 }, (_, i) => alert(i + 1, "0")));
    const result = summarize(input, nullBudget);
    expect(result.verdict).toBe("PASS");
    expect(result.alerts).toHaveLength(1000);
    expect(result.counts[0]).toBe(1000);
    const md = markdown(result);
    expect(Buffer.byteLength(md)).toBeLessThan(8192);
    expect(md).toContain("Additional alert rows omitted");
    expect(result.alerts).toHaveLength(1000);
  });

  it.each([
    { site: Array.from({ length: 1001 }, () => ({ alerts: [] })) },
    report(Array.from({ length: 1001 }, () => alert(10062, "3"))),
  ])("fails closed rather than evaluating partial oversized evidence", (input) => {
    const result = summarize(input, nullBudget);
    expect(result.verdict).toBe("FAIL");
    expect(result.error_code).toBe("invalid_evidence");
    expect(result.retryable).toBe(false);
    expect(Buffer.byteLength(markdown(result))).toBeLessThan(8192);
  });

  it("bounds structural diagnostics even for many malformed rows", () => {
    const result = summarize(report(Array.from({ length: 1000 }, () => ({}))), nullBudget);
    expect(result.errors).toHaveLength(20);
    expect(result.errors_truncated).toBe(true);
    expect(result.evidence_complete).toBe(false);
    expect(result.error_code).toBe("invalid_evidence");
    expect(result.retryable).toBe(false);
    expect(markdown(result)).toContain("Additional fixed diagnostics omitted");
    expect(Buffer.byteLength(markdown(result))).toBeLessThan(8192);
  });

  it("keeps JSON complete and bounded for the maximum admitted scan", () => {
    const input = report(
      Array.from({ length: 1000 }, () => ({
        pluginid: "9007199254740991",
        riskcode: "0",
        count: "9007199254740991",
      })),
    );
    const result = runCli(input, nullBudget, ["--format", "json"]);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.out).alerts).toHaveLength(1000);
    expect(Buffer.byteLength(result.out)).toBeLessThan(256 * 1024);
  });

  it.each([
    ["--format", "json", "--format", "markdown"],
    ["--format", "markdown", "--format", "json"],
  ])("denies duplicate formats with deterministic JSON usage evidence: %j", (...flags) => {
    const result = runCli({ site: [] }, nullBudget, flags);
    expect(result.exit).toBe(2);
    expect(JSON.parse(result.out)).toMatchObject({
      verdict: "FAIL",
      retryable: false,
      error_code: "invalid_arguments",
      next_action: "check_usage",
    });
  });

  it.each([report([]), report([alert(10062, "3")])])(
    "never reports PASS or rescan authority when summary publication fails",
    (input) => {
      const parent = mkdtempSync(
        join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zap-summary-"),
      );
      const result = runCli(
        input,
        nullBudget,
        ["--format", "json"],
        join(parent, "absent", "summary.md"),
      );
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.out)).toMatchObject({
        verdict: "FAIL",
        retryable: false,
        error_code: "invalid_evidence",
        next_action: "repair_evidence",
        errors: expect.arrayContaining([{ code: "summary_unavailable" }]),
      });
    },
  );

  it("rejects an oversized file without echoing report content", () => {
    const result = runCli({ site: [], private: "private-canary".repeat(700000) }, nullBudget);
    expect(result.exit).toBe(1);
    expect(result.out).not.toContain("private-canary");
    expect(Buffer.byteLength(result.out)).toBeLessThan(8192);
  });
});
