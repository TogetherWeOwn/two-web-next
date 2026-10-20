import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { markdown, summarize } from "../ci/zap-gate.mjs";

// Acceptance-owned: exercise the public summarizer and CLI, not implementation text.
// Substring matching, URI coercion, trusting partial instance lists, or widening the
// committed exception must fail these tests. All reports are synthetic and offline.
const origin = "https://scan.example.invalid";
const edge = `${origin}/cdn-cgi/challenge-platform/scripts/jsd/main.js`;
const worker = `${origin}/events`;
const budget = JSON.parse(readFileSync(new URL("../ci/zap-budget.json", import.meta.url), "utf8"));
const instance = (uri: unknown) => ({ uri, method: "GET", evidence: "private-evidence-canary" });
const finding = (
  instances: unknown[],
  count: unknown = String(instances.length),
  riskcode = "1",
) => ({
  pluginid: "10096",
  riskcode,
  name: "Timestamp Disclosure",
  count,
  instances,
});
const site = (alerts: object[]) => ({
  "@name": origin,
  "@host": "scan.example.invalid",
  "@port": "443",
  "@ssl": "true",
  alerts,
});
const report = (alerts: object[]) => ({ site: [site(alerts)] });
type Summary = ReturnType<typeof summarize>;

// Malformed evidence may be rejected outright or retained conservatively. If an
// alert is retained, it cannot silently lose known Worker hits or unseen residuals.
function expectBlocked(result: Summary, minimumCount = 1) {
  expect(result.failures.length).toBeGreaterThan(0);
  if (result.alerts.length > 0) {
    expect(result.alerts).toHaveLength(1);
    expect(Number.isSafeInteger(result.alerts[0].count)).toBe(true);
    expect(result.alerts[0].count).toBeGreaterThanOrEqual(minimumCount);
  }
}

function runCli(input: unknown) {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zap-scope-"));
  try {
    const path = join(dir, "report.json");
    writeFileSync(path, JSON.stringify(input));
    const env = { ...process.env };
    delete env.GITHUB_STEP_SUMMARY;
    const result = spawnSync(process.execPath, ["ci/zap-gate.mjs", path, "ci/zap-budget.json"], {
      encoding: "utf8",
      env,
      maxBuffer: 64 * 1024,
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("ZAP scoped exemption requires complete target-path evidence", () => {
  it.each(["/cdn-cgi/", "/cdn-cgi/challenge-platform/scripts/jsd/main.js?cache=1#part"])(
    "allows a complete same-origin edge pathname: %s",
    (path) => {
      const result = summarize(report([finding([instance(origin + path)])]), budget);
      expect(result.alerts).toEqual([]);
      expect(result.failures).toEqual([]);
      expect(result.counts[1]).toBe(0);
    },
  );

  it("accepts complete numeric counts and multiple same-origin Medium edge hits", () => {
    const result = summarize(
      report([finding([instance(edge), instance(`${origin}/cdn-cgi/another.js`)], 2, "2")]),
      budget,
    );
    expect(result.alerts).toEqual([]);
    expect(result.failures).toEqual([]);
    expect(result.counts[2]).toBe(0);
  });

  it.each([
    ["query only", `${worker}?next=/cdn-cgi/`],
    ["fragment only", `${worker}#/cdn-cgi/`],
    ["embedded segment", `${origin}/assets/cdn-cgi/main.js`],
    ["lookalike segment", `${origin}/cdn-cgi-extra/main.js?next=/cdn-cgi/`],
    ["missing prefix slash", `${origin}/cdn-cgi`],
    ["case lookalike", `${origin}/CDN-CGI/main.js`],
    ["normalized parent path", `${origin}/cdn-cgi/../events?next=/cdn-cgi/`],
    ["foreign host", "https://foreign.example.invalid/cdn-cgi/main.js"],
    [
      "host suffix lookalike",
      "https://scan.example.invalid.foreign.example.invalid/cdn-cgi/main.js",
    ],
    [
      "userinfo host lookalike",
      "https://scan.example.invalid@foreign.example.invalid/cdn-cgi/main.js",
    ],
    ["different scheme", "http://scan.example.invalid/cdn-cgi/main.js"],
    ["different port", "https://scan.example.invalid:8443/cdn-cgi/main.js"],
  ])("retains non-exempt evidence: %s", (_label, uri) => {
    const result = summarize(report([finding([instance(uri)])]), budget);
    expectBlocked(result);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].count).toBe(1);
    expect(result.counts[1]).toBe(1);
  });

  it.each([
    ["missing", undefined],
    ["null", null],
    ["number", 42],
    ["boolean", true],
    ["array coercion", [edge]],
    ["object", { uri: edge }],
    ["invalid URL with prefix", "not a URL /cdn-cgi/main.js"],
    ["relative path without origin", "/cdn-cgi/main.js"],
    ["network path without scheme", "//scan.example.invalid/cdn-cgi/main.js"],
    ["invalid port", "https://scan.example.invalid:wrong/cdn-cgi/main.js"],
  ])("does not establish a URI by coercion or guessing: %s", (_label, uri) => {
    expectBlocked(summarize(report([finding([instance(uri)])]), budget));
  });

  it.each([
    ["no origin fields", {}],
    ["null name", { "@name": null }],
    ["array name", { "@name": [origin] }],
    ["object name", { "@name": { origin } }],
    ["relative name", { "@name": "/cdn-cgi/" }],
    ["invalid name", { "@name": "not a site origin" }],
    ["non-HTTP name", { "@name": "file:///cdn-cgi/" }],
  ])("requires positive containing-site origin proof: %s", (_label, metadata) => {
    const input = { site: [{ ...metadata, alerts: [finding([instance(edge)])] }] };
    expectBlocked(summarize(input, budget));
  });

  it.each([
    ["declared residual", "3", [instance(edge)], 2],
    ["numeric declared residual", 3, [instance(edge)], 2],
    ["mixed residual", "5", [instance(edge), instance(worker)], 4],
    ["more supplied than declared", "1", [instance(edge), instance(edge)], 1],
    ["zero declared with evidence", "0", [instance(edge)], 1],
    ["null count", null, [instance(edge)], 1],
    ["fractional count", "1.5", [instance(edge)], 1],
    ["negative count", "-1", [instance(edge)], 1],
    ["nonnumeric count", "count-canary", [instance(edge)], 1],
    ["array count", ["1"], [instance(edge)], 1],
    ["object count", { count: 1 }, [instance(edge)], 1],
    ["no supplied evidence", "2", [], 2],
  ])("does not erase unproved counts: %s", (_label, count, instances, minimum) => {
    expectBlocked(summarize(report([finding(instances, count)]), budget), minimum);
  });

  it("does not infer complete evidence when the declared count is missing", () => {
    const { count: _count, ...noCount } = finding([instance(edge)]);
    expectBlocked(summarize(report([noCount]), budget));
  });

  it("keeps an alert with no instances rather than inventing edge evidence", () => {
    const { instances: _instances, ...noInstances } = finding([instance(edge)], "2");
    expectBlocked(summarize(report([noInstances]), budget), 2);
  });

  it.each([null, {}, { uri: null }, { uri: [edge] }])(
    "does not erase malformed evidence beside a valid edge hit: %j",
    (unproved) => {
      expectBlocked(summarize(report([finding([instance(edge), unproved])]), budget));
    },
  );

  it("subtracts only proven edge hits from a complete mixed report", () => {
    const input = report([
      finding([
        instance(edge),
        instance(worker),
        instance(`${worker}?q=/cdn-cgi/`),
        instance("https://foreign.example.invalid/cdn-cgi/main.js"),
        instance(`${origin}/cdn-cgi/another.js`),
      ]),
    ]);
    const result = summarize(input, budget);
    expect(result.alerts).toHaveLength(1);
    expect(result.alerts[0].count).toBe(3);
    expect(result.counts[1]).toBe(1);
    expect(result.failures.length).toBeGreaterThan(0);
  });

  it("binds evidence to its own site, not another site's origin", () => {
    const input = {
      site: [
        site([]),
        {
          "@name": "https://foreign.example.invalid",
          alerts: [finding([instance(edge)])],
        },
      ],
    };
    expectBlocked(summarize(input, budget));
  });

  it.each(["1", "2"])("enforces the committed zero budget for non-edge risk %s", (risk) => {
    const result = summarize(report([finding([instance(worker)], "1", risk)]), budget);
    expectBlocked(result);
    expect(result.counts[Number(risk)]).toBe(1);
  });

  it("keeps High non-exemptible even with complete edge evidence and report-only budgets", () => {
    const result = summarize(report([finding([instance(edge)], "1", "3")]), {
      ...budget,
      maxMedium: null,
      maxLow: null,
    });
    expectBlocked(result);
    expect(result.counts[3]).toBe(1);
    expect(result.alerts[0].count).toBe(1);
  });

  it("does not exempt another plugin on a proven edge path", () => {
    const other = { ...finding([instance(edge)]), pluginid: "10020" };
    expectBlocked(summarize(report([other]), budget));
  });

  it("keeps the exception inventory and zero budgets unchanged", () => {
    expect(budget.maxMedium).toBe(0);
    expect(budget.maxLow).toBe(0);
    expect(budget.ignore).toHaveLength(1);
    expect(budget.ignore[0]).toMatchObject({ pluginId: "10096", uriPrefix: "/cdn-cgi/" });
    expect(budget.ignore[0].why.length).toBeGreaterThan(0);
  });

  it.each([{ site: [] }, { site: [{ alerts: [] }] }, report([])])(
    "preserves the established structurally valid empty scan: %j",
    (input) => {
      const result = summarize(input, budget);
      expect(result.failures).toEqual([]);
      expect(result.alerts).toEqual([]);
      expect(runCli(input).status).toBe(0);
    },
  );

  it.each([
    ["URI mismatch", report([finding([instance(`${worker}?private-query-canary=/cdn-cgi/`)])])],
    ["count mismatch", report([finding([instance(edge)], "3")])],
    ["malformed URI", report([finding([instance([edge])])])],
    ["missing site origin", { site: [{ alerts: [finding([instance(edge)])] }] }],
  ])(
    "CLI rejects unproved exemptions and emits bounded, public-safe output: %s",
    (_label, input) => {
      const result = runCli(input);
      expect(result.status).toBe(1);
      expect(result.output.length).toBeLessThan(8192);
      for (const canary of [
        "scan.example.invalid",
        "private-query-canary",
        "private-evidence-canary",
        edge,
      ]) {
        expect(result.output).not.toContain(canary);
      }
    },
  );

  it("CLI allows a complete edge-only report without revealing scan evidence", () => {
    const result = runCli(report([finding([instance(edge)])]));
    expect(result.status).toBe(0);
    expect(result.output).not.toContain("scan.example.invalid");
    expect(result.output).not.toContain("private-evidence-canary");
  });

  it("keeps malformed-evidence diagnostics bounded and free of raw site, count, URI and evidence", () => {
    const canary = "private-diagnostic-canary";
    const input = {
      site: [
        {
          "@name": { value: `${canary}${"x".repeat(100_000)}` },
          alerts: [finding([instance([`${edge}?${canary}`])], `${canary}${"x".repeat(100_000)}`)],
        },
      ],
    };
    const result = summarize(input, budget);
    expectBlocked(result);
    const publicText = markdown(result) + JSON.stringify(result.failures);
    expect(publicText.length).toBeLessThan(8192);
    expect(publicText).not.toContain(canary);
    expect(publicText).not.toContain("scan.example.invalid");
    expect(publicText).not.toContain("private-evidence-canary");
  });
});
