import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, URL } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error Standalone tooling has no declaration file.
import { markdown, summarize } from "../ci/zap-gate.mjs";

/*
 * Acceptance-owned files: this file and fixtures/zap-verdict-offline.cjs.
 * Run: npm test -- test/zap-scalar-verdict-acceptance.test.ts
 * Automatically discovered by Vitest and test:inventory; no browser/DB opt-in.
 *
 * Proposed public v1 boundary (not an implementation prescription):
 *   gate: node ci/zap-gate.mjs REPORT BUDGET [--format json|markdown]
 *   retry: node ci/zap-retry-decision.mjs VERDICT_JSON
 * JSON required fields: schema_version:1, gate_id:"zap-baseline", verdict:PASS|FAIL,
 * retryable:boolean, error_code, next_action, alerts. Retained alert rows carry
 * alert_id:"zap-<canonical plugin ID>", plugin_id:string, risk:number, count:number,
 * name:escaped single-line public label (<=160 characters). Additional safe fields
 * are allowed. Errors use structural indexes, never raw bad values.
 * Exit: gate PASS=0, FAIL=1, argument misuse=2; retry authorized=0, otherwise=1,
 * argument misuse=2. JSON stdout is one document; Markdown remains the default.
 * Fixed pairs: ok/none, pii_high/rescan_once, high_alert/fix_findings,
 * budget_exceeded/fix_findings, invalid_evidence/repair_evidence,
 * invalid_arguments/check_usage. Invalid evidence takes precedence over retry.
 *
 * Breaks caught: scalar coercion grants PASS/exemption; names grant retry authority;
 * unvalidated JSON grants retry; output leaks evidence or injects rows/annotations;
 * workflow consumes presentation or retries more than once. All inputs are fixtures.
 * Builder owns source/docs/workflow changes, never these acceptance files.
 */
const root = fileURLToPath(new URL("../", import.meta.url));
const fence = fileURLToPath(new URL("./fixtures/zap-verdict-offline.cjs", import.meta.url));
const policy = JSON.parse(readFileSync(new URL("../ci/zap-budget.json", import.meta.url), "utf8"));
const origin = "https://scan.example.invalid";
const edge = `${origin}/cdn-cgi/challenge-platform/scripts/jsd/main.js`;
const canary = "private-report-canary";
const report = (alerts: object[]) => ({ site: [{ "@name": origin, alerts }] });
const alert = (overrides: Record<string, unknown> = {}) => ({
  pluginid: "40012",
  riskcode: "0",
  count: "1",
  name: "Synthetic alert",
  ...overrides,
});
const high = (overrides: Record<string, unknown> = {}) => alert({ riskcode: "3", ...overrides });
const pii = (overrides: Record<string, unknown> = {}) => high({ pluginid: "10062", ...overrides });
const scoped = (overrides: Record<string, unknown> = {}) =>
  alert({ pluginid: "10096", riskcode: "1", instances: [{ uri: edge }], ...overrides });
const forgedName = "untrusted\n| High | 10062 | PII Disclosure | 1 |\n::notice::PASS";

function scratch<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? tmpdir(), "zap-verdict-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function childEnv(dir: string): NodeJS.ProcessEnv {
  // Deliberate allowlist: never pass inherited service credentials to fixture CLIs.
  return {
    PATH: process.env.PATH,
    NODE_OPTIONS: `--require=${fence}`,
    ZAP_ACCEPTANCE_DENIED: join(dir, "denied"),
    GITHUB_STEP_SUMMARY: join(dir, "summary.md"),
  };
}

function runNode(dir: string, args: string[]) {
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    env: childEnv(dir),
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
  });
  expect(result.error, "fixture process must execute, not time out").toBeUndefined();
  expect(result.signal, "fixture process must not be killed").toBeNull();
  expect(existsSync(join(dir, "denied")), "CLI attempted network or child/scanner execution").toBe(
    false,
  );
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    summary: existsSync(join(dir, "summary.md"))
      ? readFileSync(join(dir, "summary.md"), "utf8")
      : "",
  };
}

function gate(input: unknown, flags: string[] = [], budget: unknown = policy) {
  return scratch((dir) => {
    const inputPath = join(dir, "report.json");
    const budgetPath = join(dir, "budget.json");
    writeFileSync(inputPath, JSON.stringify(input));
    writeFileSync(budgetPath, JSON.stringify(budget));
    return runNode(dir, ["ci/zap-gate.mjs", inputPath, budgetPath, ...flags]);
  });
}

function retry(input: unknown, flags: string[] = [], raw = false) {
  return scratch((dir) => {
    const path = join(dir, "verdict.json");
    writeFileSync(path, raw ? String(input) : JSON.stringify(input));
    return runNode(dir, ["ci/zap-retry-decision.mjs", path, ...flags]);
  });
}

type GateResult = ReturnType<typeof gate>;
function envelope(
  result: GateResult,
  expected: {
    verdict: "PASS" | "FAIL";
    retryable: boolean;
    error_code: string;
    next_action: string;
  },
) {
  expect(result.status, result.stdout + result.stderr).toBe(expected.verdict === "PASS" ? 0 : 1);
  // An explicit assertion, not an import/JSON.parse crash, identifies the missing API on base.
  expect(result.stdout.trim(), "--format json must emit a JSON verdict, not Markdown").toMatch(
    /^\{/,
  );
  const value = JSON.parse(result.stdout);
  expect(value).toEqual(
    expect.objectContaining({ schema_version: 1, gate_id: "zap-baseline", ...expected }),
  );
  expect(Array.isArray(value.alerts)).toBe(true);
  return value;
}
const pass = { verdict: "PASS", retryable: false, error_code: "ok", next_action: "none" } as const;
const malformed = {
  verdict: "FAIL",
  retryable: false,
  error_code: "invalid_evidence",
  next_action: "repair_evidence",
} as const;
const retryable = {
  verdict: "FAIL",
  retryable: true,
  error_code: "pii_high",
  next_action: "rescan_once",
} as const;
const blockedHigh = {
  verdict: "FAIL",
  retryable: false,
  error_code: "high_alert",
  next_action: "fix_findings",
} as const;
const blockedBudget = {
  verdict: "FAIL",
  retryable: false,
  error_code: "budget_exceeded",
  next_action: "fix_findings",
} as const;
const jsonFlags = ["--format", "json"];

const invalidScalars: [string, unknown][] = [
  ["empty-array", []],
  ["singleton-array", [1]],
  ["object", { value: canary }],
  ["null", null],
  ["true", true],
  ["false", false],
  ["empty", ""],
  ["whitespace", " 1 "],
  ["leading-zero", "01"],
  ["plus", "+1"],
  ["decimal-string", "1.0"],
  ["exponent", "1e0"],
  ["hex", "0x1"],
  ["fraction", 1.5],
  ["negative", -1],
  ["unsafe-number", 9007199254740992],
  ["unsafe-string", "9007199254740992"],
  ["missing", undefined],
];

describe("ZSV-1 scalar evidence admission", () => {
  for (const field of ["riskcode", "count", "pluginid"] as const) {
    it.each(invalidScalars)(`ZSV-1-${field} rejects %s before coercion`, (_case, value) => {
      // Report-only budgets isolate admission: an accidentally coerced Low/Medium
      // must not make this test pass merely because the committed budget is zero.
      const result = summarize(report([alert({ [field]: value })]), {
        maxMedium: null,
        maxLow: null,
      });
      expect(result.failures.length, `invalid ${field} must not produce PASS`).toBeGreaterThan(0);
      expect(result.failures.join("\n")).not.toContain(canary);
    });
  }

  it.each([
    ["empty-array", []],
    ["ID-array", ["10096"]],
    ["ID-object", { id: "10096" }],
  ])(
    "ZSV-1-exemption rejects %s identity instead of granting the committed ignore",
    (_case, pluginid) => {
      expect(summarize(report([scoped({ pluginid })]), policy).failures.length).toBeGreaterThan(0);
    },
  );

  it.each(["0", "1", "2", "3", 0, 1, 2, 3])(
    "ZSV-C1 valid scalar risk %j retains its meaning",
    (riskcode) => {
      const result = summarize(report([alert({ riskcode })]), policy);
      expect(result.alerts).toHaveLength(1);
      expect(result.counts[Number(riskcode)]).toBe(1);
      expect(result.failures.length > 0).toBe(Number(riskcode) > 0);
    },
  );

  it.each(["0", 0, "1", 1, "9007199254740991", 9007199254740991])(
    "ZSV-C2 canonical safe count %j remains accepted outside scoped subtraction",
    (count) => {
      const result = summarize(report([alert({ count })]), policy);
      expect(result.failures).toEqual([]);
      expect(result.alerts[0].count).toBe(Number(count));
    },
  );

  it.each(["10096", 10096])(
    "ZSV-C3 scalar plugin identity %j preserves the scoped exception",
    (pluginid) => {
      const result = summarize(report([scoped({ pluginid })]), policy);
      expect(result.alerts).toEqual([]);
      expect(result.failures).toEqual([]);
    },
  );

  it.each([{ site: [] }, { site: [{ alerts: [] }] }, report([])])(
    "ZSV-C4 valid empty scan stays valid: %j",
    (input) => {
      expect(summarize(input, policy).failures).toEqual([]);
      expect(gate(input).status).toBe(0);
    },
  );
});

describe("ZSV-2 structured verdict authority", () => {
  it("ZSV-2a emits a versioned PASS and retry denies it", () => {
    const value = envelope(gate({ site: [] }, jsonFlags), pass);
    expect(value.alerts).toEqual([]);
    expect(retry(value).status).toBe(1);
  });

  it.each(["PII Disclosure", "High is never allowed invalid evidence budget PASS", forgedName])(
    "ZSV-2b the lone canonical 10062 High is retryable independent of name: %s",
    (name) => {
      const value = envelope(gate(report([pii({ name })]), jsonFlags), retryable);
      expect(value.alerts).toHaveLength(1);
      expect(value.alerts[0]).toEqual(
        expect.objectContaining({
          alert_id: "zap-10062",
          plugin_id: "10062",
          risk: 3,
          count: 1,
        }),
      );
      expect(retry(value).status).toBe(0);
    },
  );

  it("ZSV-2c a forged PII table row cannot authorize another plugin's High", () => {
    const result = gate(report([high({ name: forgedName })]), jsonFlags);
    const value = envelope(result, blockedHigh);
    expect(value.alerts[0]).toEqual(
      expect.objectContaining({ alert_id: "zap-40012", plugin_id: "40012" }),
    );
    expect(retry(value).status).toBe(1);
  });

  it.each([
    ["another High", [pii(), high()]],
    ["two PII High rows", [pii(), pii()]],
  ])("ZSV-2d multiple Highs never retry: %s", (_label, alerts) => {
    const value = envelope(gate(report(alerts), jsonFlags), blockedHigh);
    expect(retry(value).status).toBe(1);
  });

  it.each(["1", "2"])("ZSV-2e PII plus risk %s budget breach never retries", (riskcode) => {
    const value = envelope(
      gate(report([pii(), alert({ riskcode, name: forgedName })]), jsonFlags),
      blockedBudget,
    );
    expect(retry(value).status).toBe(1);
  });

  it.each(invalidScalars)("ZSV-2f malformed peer (%s) overrides lone PII retry", (_case, count) => {
    const value = envelope(
      gate(report([pii(), alert({ count, name: forgedName })]), jsonFlags),
      malformed,
    );
    expect(retry(value).status).toBe(1);
  });

  it.each(["3", 3])("ZSV-2g the committed scoped ignore cannot exempt risk %j", (riskcode) => {
    const value = envelope(gate(report([scoped({ riskcode })]), jsonFlags), blockedHigh);
    expect(value.alerts).toHaveLength(1);
    expect(retry(value).status).toBe(1);
  });

  it.each([
    ["same-site edge", edge, "1", pass],
    ["query lookalike", `${origin}/events?path=/cdn-cgi/`, "1", blockedBudget],
    ["foreign origin", "https://foreign.example.invalid/cdn-cgi/file.js", "1", blockedBudget],
    ["incomplete instance list", edge, "2", malformed],
  ])("ZSV-2h JSON preserves scoped evidence policy: %s", (_label, uri, count, expected) => {
    const value = envelope(
      gate(report([scoped({ count, instances: [{ uri }] })]), jsonFlags),
      expected,
    );
    expect(retry(value).status).toBe(1);
  });

  it("ZSV-2i JSON and Markdown report the same gate outcome and retained count", () => {
    const input = report([high({ count: "7" })]);
    const machine = envelope(gate(input, jsonFlags), blockedHigh);
    const human = gate(input);
    expect(human.status).toBe(1);
    expect(human.stdout).toContain("FAIL");
    expect(machine.alerts).toHaveLength(1);
    expect(machine.alerts[0].count).toBe(7);
    expect(human.stdout).toMatch(/\|\s*40012\s*\|[^\n]*\|\s*7\s*\|/);
    expect(retry(human.stdout, [], true).status).toBe(1);
  });

  it("ZSV-2j Markdown from a legitimate PII High is not a retry capability", () => {
    const human = gate(report([pii({ name: "PII Disclosure" })]));
    expect(human.status).toBe(1);
    expect(retry(human.stdout, [], true).status).toBe(1);
  });

  it("ZSV-C5 scoped controls remain executable without a new JSON interface", () => {
    expect(gate(report([scoped()])).status).toBe(0);
    expect(gate(report([scoped({ riskcode: "3" })])).status).toBe(1);
    expect(gate(report([scoped({ count: "2" })])).status).toBe(1);
  });
});

describe("ZSV-3 public-safe output", () => {
  it.each(["pluginid", "riskcode", "count", "name"])(
    "ZSV-3a malformed %s is not stringified into public errors or labels",
    (field) => {
      const input = report([alert({ [field]: { private: canary } })]);
      const value = summarize(input, policy);
      const human = markdown(value);
      expect(human).not.toContain(canary);
      expect(human).not.toContain("[object Object]");
      expect(human.length).toBeLessThanOrEqual(8192);
      if (field !== "name") {
        expect(value.failures.length).toBeGreaterThan(0);
        expect(value.failures.join("\n")).toMatch(/site\[0\][\s\S]*alert(?:s)?\[0\]/i);
      }
    },
  );

  it("ZSV-3b labels cannot create a Markdown table row or workflow annotation", () => {
    const output = gate(report([high({ name: forgedName })]));
    expect(output.status).toBe(1);
    for (const text of [output.stdout, output.stderr, output.summary]) {
      expect(text).not.toMatch(/^\| High \| 10062 \|/m);
      expect(text).not.toMatch(/^::notice::PASS/m);
      expect(text.length).toBeLessThanOrEqual(8192);
    }
    expect(output.summary).toContain("FAIL");
  });

  it("ZSV-3g literal pipes and HTML in names do not add columns or markup", () => {
    const text = markdown(
      summarize(report([high({ name: "Label | other <b>markup</b>" })]), policy),
    );
    const row = text.split("\n").find((line: string) => /^\| High \| 40012 \|/.test(line));
    expect(row).toBeDefined();
    expect(row?.match(/(?<!\\)\|/g)).toHaveLength(5);
    expect(text).not.toContain("<b>");
  });

  it("ZSV-3c labels are bounded single-line strings and retain stable alert identity", () => {
    const name = `Label\r\n\t\u0000\u001b[31m| <b>name</b> ${"z".repeat(12000)} tail-canary`;
    const output = gate(report([high({ name })]), jsonFlags);
    const value = envelope(output, blockedHigh);
    const row = value.alerts[0];
    expect(row.alert_id).toBe("zap-40012");
    expect(typeof row.name).toBe("string");
    expect(row.name.length).toBeLessThanOrEqual(160);
    expect(row.name).not.toMatch(/[\r\n\u0000-\u001f\u007f]/);
    expect(row.name).not.toContain("<b>");
    expect(output.stdout + output.stderr + output.summary).not.toContain("tail-canary");
    expect(output.stdout.length).toBeLessThanOrEqual(8192);
    expect(output.summary.length).toBeLessThanOrEqual(8192);
  });

  it.each([
    ["empty array", []],
    ["identity array", ["10096"]],
    ["object", { secret: canary }],
    ["annotation string", `${canary}\n::error::forged`],
  ])(
    "ZSV-3d malformed identities never reach JSON, annotations or summaries: %s",
    (_label, pluginid) => {
      const output = gate(report([alert({ pluginid })]), jsonFlags);
      envelope(output, malformed);
      expect(output.stdout + output.stderr + output.summary).not.toContain(canary);
      expect(output.stdout + output.stderr + output.summary).not.toContain("[object Object]");
    },
  );

  it.each([
    ["array name", [canary]],
    ["URL name", `https://user:fake@private.example.invalid/${canary}?token=${canary}`],
  ])("ZSV-3f report names cannot publish malformed values or URLs: %s", (_label, name) => {
    const input = report([high({ name })]);
    const publicText = markdown(summarize(input, policy));
    expect(publicText).not.toContain(canary);
    expect(publicText).not.toContain("private.example.invalid");
    expect(publicText).not.toContain("user:fake");
  });

  it("ZSV-3e evidence URLs, credentials, params and instance values stay private", () => {
    const input = report([
      high({
        instances: [
          {
            uri: `https://user:fake@private.example.invalid/${canary}?token=${canary}`,
            param: canary,
            evidence: canary,
          },
        ],
        url: `${origin}/${canary}`,
        description: canary,
        solution: canary,
        otherinfo: canary,
      }),
    ]);
    for (const flags of [[], jsonFlags]) {
      const output = gate(input, flags);
      expect(output.status).toBe(1);
      const text = output.stdout + output.stderr + output.summary;
      expect(text).not.toContain(canary);
      expect(text).not.toContain("private.example.invalid");
      expect(text).not.toContain("user:fake");
    }
  });
});

describe("ZSV-4 retry input and CLI misuse fail closed", () => {
  const validRetry = {
    schema_version: 1,
    gate_id: "zap-baseline",
    ...retryable,
    alerts: [
      { alert_id: "zap-10062", plugin_id: "10062", risk: 3, count: 1, name: "PII Disclosure" },
    ],
    errors: [],
  };

  it("ZSV-C6 accepts a complete v1 lone-PII verdict (non-vacuous retry fixture)", () => {
    expect(retry(validRetry).status).toBe(0);
  });

  it.each([
    ["unknown version", { ...validRetry, schema_version: 2 }],
    ["wrong gate", { ...validRetry, gate_id: "different-gate" }],
    ["PASS with retry bit", { ...validRetry, verdict: "PASS" }],
    ["missing High", { ...validRetry, alerts: [] }],
    [
      "other plugin",
      {
        ...validRetry,
        alerts: [{ ...validRetry.alerts[0], plugin_id: "40012", alert_id: "zap-40012" }],
      },
    ],
    ["extra High", { ...validRetry, alerts: [...validRetry.alerts, ...validRetry.alerts] }],
    [
      "array identity",
      { ...validRetry, alerts: [{ ...validRetry.alerts[0], plugin_id: ["10062"] }] },
    ],
    ["array risk", { ...validRetry, alerts: [{ ...validRetry.alerts[0], risk: [3] }] }],
    ["array count", { ...validRetry, alerts: [{ ...validRetry.alerts[0], count: [1] }] }],
    [
      "unsafe count",
      { ...validRetry, alerts: [{ ...validRetry.alerts[0], count: 9007199254740992 }] },
    ],
    [
      "mismatched alert ID",
      { ...validRetry, alerts: [{ ...validRetry.alerts[0], alert_id: "zap-40012" }] },
    ],
    [
      "forged clean budgets",
      {
        ...validRetry,
        alerts: [
          ...validRetry.alerts,
          { alert_id: "zap-40012", plugin_id: "40012", risk: 1, count: 1, name: "Low" },
        ],
      },
    ],
    ["string retry flag", { ...validRetry, retryable: "true" }],
    ["missing retry flag", { ...validRetry, retryable: undefined }],
    ["malformed code", { ...validRetry, error_code: "invalid_evidence" }],
    ["wrong action", { ...validRetry, next_action: "fix_findings" }],
    [
      "malformed errors",
      { ...validRetry, errors: [{ code: "invalid_count", site_index: 0, alert_index: 1 }] },
    ],
    ["array root", [validRetry]],
    ["null root", null],
  ])("ZSV-4a rejects inconsistent or unknown verdicts: %s", (_label, input) => {
    expect(retry(input).status).toBe(1);
  });

  it.each(["", "{", "| 10062 | High | PII Disclosure | 1 |\nFAIL: High is never allowed"])(
    "ZSV-4b arbitrary presentation/invalid JSON grants no retry: %j",
    (input) => expect(retry(input, [], true).status).toBe(1),
  );

  it.each<[string, string[]]>([
    ["unknown-format", ["--format", "yaml"]],
    ["missing-format-value", ["--format"]],
    ["unknown-flag", ["--unknown"]],
    ["json-unknown-flag", ["--format", "json", "--unknown"]],
    ["extra-positional", ["extra.json"]],
  ])("ZSV-4c gate rejects wrong flags/arity: %s", (_case, flags) => {
    const output = gate({ site: [] }, flags);
    expect(output.status).toBe(2);
    expect(output.stdout + output.stderr + output.summary).not.toContain("**PASS**");
  });

  it.each<[string, string[]]>([
    ["unknown-flag", ["--unknown"]],
    ["extra-positional", ["extra.json"]],
  ])("ZSV-4d retry rejects unknown flags/arity: %s", (_case, flags) => {
    expect(retry(validRetry, flags).status).toBe(2);
  });

  it("ZSV-4e JSON argument failures use fixed code/action", () => {
    const output = gate({ site: [] }, ["--format", "json", "--unknown"]);
    expect(output.status).toBe(2);
    expect(output.stdout.trim()).toMatch(/^\{/);
    expect(JSON.parse(output.stdout)).toEqual(
      expect.objectContaining({
        schema_version: 1,
        gate_id: "zap-baseline",
        verdict: "FAIL",
        retryable: false,
        error_code: "invalid_arguments",
        next_action: "check_usage",
      }),
    );
  });
});

// Execute the actual consumer shell, substituting only scanner/sleep executables.
// The node shim still runs real CLIs with the child-only offline safety fence.
function workflowGate(first: unknown, second: unknown) {
  return scratch((dir) => {
    const workflow = readFileSync(resolve(root, ".github/workflows/zap-staging.yml"), "utf8");
    const block = workflow.match(
      /      - name: Gate[^\n]*\n        run: \|\n([\s\S]*?)(?=      - (?:name|uses):|$)/,
    );
    expect(block, "fixture must find the existing Gate run block").not.toBeNull();
    const script = (block?.[1] ?? "")
      .split("\n")
      .map((line) => line.replace(/^          /, ""))
      .join("\n");
    // Containment prerequisite, not a source-text feature assertion: this fixture
    // executes only the simple consumer block, never shell expansions or raw sockets.
    expect(script.replaceAll("/dev/null", "")).not.toMatch(/\/dev\/|`|\$\(|<\(|>\(/);
    expect(script).not.toMatch(/(?:^|[;|&\n])\s*(?:\"|')?\/(?:bin|usr|opt|tmp|paperclip)\//m);
    mkdirSync(join(dir, "bin"));
    mkdirSync(join(dir, "zap"));
    // Do not inherit a PATH containing curl/wget/scanner executables.
    for (const tool of ["cp", "mkdir", "chmod", "tee"]) {
      writeFileSync(join(dir, "bin", tool), `#!/bin/sh\nexec /usr/bin/${tool} "$@"\n`, {
        mode: 0o755,
      });
    }
    writeFileSync(join(dir, "zap", "zap-report.json"), JSON.stringify(first));
    writeFileSync(join(dir, "second.json"), JSON.stringify(second));
    const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    writeFileSync(
      join(dir, "bin", "node"),
      `#!/bin/sh\nif [ "$1" = "ci/zap-retry-decision.mjs" ]; then\n  cp "$2" "$RUNNER_TEMP/retry-input" || exit 97\nfi\nexec ${quoted(process.execPath)} "$@"\n`,
      {
        mode: 0o755,
      },
    );
    writeFileSync(join(dir, "bin", "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(
      join(dir, "bin", "docker"),
      `#!/bin/sh\nprintf 'fixture-rescan\\n' >> "$RUNNER_TEMP/scans"\ncp "$RUNNER_TEMP/second.json" "$RUNNER_TEMP/zap/zap-report.json"\n`,
      { mode: 0o755 },
    );
    const result = spawnSync("/bin/bash", ["-c", script], {
      cwd: root,
      env: {
        ...childEnv(dir),
        PATH: join(dir, "bin"),
        RUNNER_TEMP: dir,
        TARGET: origin,
        ZAP_IMAGE: "fixture-scanner-never-executed",
        HOME: dir,
        BASH_ENV: "/dev/null",
      },
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    });
    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect(existsSync(join(dir, "denied")), "consumer attempted external I/O through node").toBe(
      false,
    );
    const scans = existsSync(join(dir, "scans"))
      ? readFileSync(join(dir, "scans"), "utf8").trim().split("\n").length
      : 0;
    const retryInput = existsSync(join(dir, "retry-input"))
      ? readFileSync(join(dir, "retry-input"), "utf8")
      : "";
    return { status: result.status, scans, retryInput, output: result.stdout + result.stderr };
  });
}

describe("ZSV-5 real workflow consumer, fixture scanner only", () => {
  it("ZSV-5a forged non-PII High is denied without a rescan", () => {
    const result = workflowGate(report([high({ name: forgedName })]), report([]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(0);
  });

  it("ZSV-5c the real retry consumer receives the structured verdict, never presentation", () => {
    const result = workflowGate(report([pii()]), report([]));
    expect(
      result.retryInput.trim(),
      "retry input must be JSON, not the human gate summary",
    ).toMatch(/^\{/);
    expect(JSON.parse(result.retryInput)).toEqual(
      expect.objectContaining({
        schema_version: 1,
        gate_id: "zap-baseline",
        ...retryable,
      }),
    );
  });

  it("ZSV-C7 lone PII permits exactly one rescan and a clean second scan passes", () => {
    const result = workflowGate(report([pii({ name: "PII Disclosure" })]), report([]));
    expect(result.status, result.output).toBe(0);
    expect(result.scans).toBe(1);
  });

  it("ZSV-C8 repeated lone PII fails after one rescan, never a third scan", () => {
    const result = workflowGate(report([pii()]), report([pii()]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(1);
  });

  it("ZSV-5b malformed evidence beside PII cannot authorize a rescan", () => {
    const result = workflowGate(report([pii(), alert({ riskcode: [] })]), report([]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(0);
  });

  it("ZSV-C9 a PII High with a real Low budget failure never rescans", () => {
    const result = workflowGate(report([pii(), alert({ riskcode: "1" })]), report([]));
    expect(result.status, result.output).toBe(1);
    expect(result.scans).toBe(0);
  });
});

describe("ZSV-C10 offline fixture fence self-check", () => {
  it.each([
    "require('node:http').get('https://example.invalid')",
    "fetch('https://example.invalid')",
    "require('node:child_process').spawnSync('docker', ['version'])",
  ])("denies an external operation before execution: %s", (operation) =>
    scratch((dir) => {
      const result = spawnSync(process.execPath, ["--eval", operation], {
        env: childEnv(dir),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(1);
      expect(readFileSync(join(dir, "denied"), "utf8")).toBe("denied\n");
      expect(result.stderr).toContain("offline acceptance fence");
    }),
  );
});
