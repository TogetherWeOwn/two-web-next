// Builder-owned boundary checks; the independent acceptance file is unchanged.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGate } from "../../ci/check-staging-journeys.mjs";
import { formatLedgerMarkdown, REPORT_LIMITS, summarizeJourneys } from "./journey-ledger.mjs";

const spec = (title = "fixture journey") => ({
  file: "e2e/staging/auth.spec.ts",
  title,
  tests: [{ projectName: "chromium", status: "expected", results: [], annotations: [] }],
});
const report = (specs = [spec()]) => ({ suites: [{ specs }], errors: [] });
const code = (summary, value) => summary.diagnostics.find((entry) => entry.code === value);

function scratch(t) {
  const dir = mkdtempSync(
    join(
      process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
      "journey-receipt-bounds-",
    ),
  );
  t.after(() => rmSync(dir, { force: true, recursive: true }));
  let output = "";
  return {
    dir,
    reportPath: join(dir, "report.json"),
    ledgerJsonPath: join(dir, "ledger.json"),
    ledgerMdPath: join(dir, "ledger.md"),
    stepSummaryPath: join(dir, "summary.md"),
    stdout: {
      write: (text) => {
        output += text;
      },
    },
    stderr: {
      write: (text) => {
        output += text;
      },
    },
    output: () => output,
  };
}

test("row cap retains bounded real rows and never gives a partial clean pass", () => {
  const summary = summarizeJourneys(
    report(
      Array.from({ length: REPORT_LIMITS.journeys + 1 }, (_, index) => spec(`journey ${index}`)),
    ),
  );
  assert.equal(summary.verdict, "fail");
  assert.equal(summary.counts.total, REPORT_LIMITS.journeys);
  assert.equal(summary.counts.passed, REPORT_LIMITS.journeys);
  assert.ok(code(summary, "report_too_large"));
});

test("node, string-volume and cycle bounds reject before collection without recursion", () => {
  const cyclic = report();
  cyclic.metadata = cyclic;
  for (const [value, expected] of [
    [
      { ...report(), metadata: Array.from({ length: REPORT_LIMITS.nodes + 1 }, () => 0) },
      "report_too_large",
    ],
    [{ ...report(), metadata: "x".repeat(REPORT_LIMITS.bytes + 1) }, "report_too_large"],
    [cyclic, "report_invalid_shape"],
  ]) {
    const summary = summarizeJourneys(value);
    assert.notEqual(summary.verdict, "pass");
    assert.equal(summary.counts.total, 0);
    assert.ok(code(summary, expected));
  }
});

test("runner errors fail even an empty or all-skipped run without invented failed tests", () => {
  const skipped = spec();
  skipped.tests[0].status = "skipped";
  for (const specs of [[], [skipped]]) {
    const summary = summarizeJourneys({ ...report(specs), errors: [{}] });
    assert.equal(summary.verdict, "fail");
    assert.equal(summary.counts.failed, 0);
    assert.ok(code(summary, "runner_error"));
  }
});

test("diagnostic counts saturate at the documented ceiling", () => {
  const summary = summarizeJourneys({
    ...report(),
    errors: Array.from({ length: 10001 }, () => ({})),
  });
  assert.equal(summary.verdict, "fail");
  assert.equal(code(summary, "runner_error").count, 10000);
  assert.equal(summary.counts.total, 1);
});

test("malformed report exit takes precedence over a real failed journey and runner error", (t) => {
  const paths = scratch(t);
  const failed = spec();
  failed.tests[0].status = "unexpected";
  writeFileSync(
    paths.reportPath,
    JSON.stringify({ suites: [{ specs: [failed, null] }], errors: [{}] }),
  );
  assert.equal(runGate(paths), 2);
  const summary = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.verdict, "fail");
  assert.ok(code(summary, "runner_error"));
  assert.ok(code(summary, "report_invalid_shape"));
});

test("untrusted provenance is withheld instead of copied into either format", () => {
  const summary = summarizeJourneys(report(), {
    provenance: {
      sha: "https://example.com/private",
      runId: "member@example.com",
      runAttempt: "Cookie: fixture-canary",
    },
  });
  assert.deepEqual(summary.provenance, { sha: "unknown", runId: "unknown", runAttempt: "unknown" });
  assert.doesNotMatch(
    JSON.stringify(summary) + formatLedgerMarkdown(summary),
    /fixture-canary|member@example|https:\/\//,
  );
});

test("display metadata uses existing token, URL, member and control-character redaction", () => {
  const value = spec("fixture-canary\nprivate second line");
  value.file = "https://example.com/private";
  value.tests[0].projectName = "memberId=123456789012345678";
  const summary = summarizeJourneys(report([value]), { qaAuthToken: "fixture-canary" });
  const emitted = JSON.stringify(summary) + formatLedgerMarkdown(summary);
  assert.doesNotMatch(
    emitted,
    /fixture-canary|private second line|example\.com|123456789012345678/,
  );
  assert.match(summary.journeys[0].name, /redacted token/);
});

test("oversized reasons are withheld whole rather than split or scanned unboundedly", () => {
  const value = spec();
  value.tests[0].status = "flaky";
  value.tests[0].results = [
    { status: "failed", error: { message: `${"x".repeat(16384)} fixture-canary` } },
  ];
  const summary = summarizeJourneys(report([value]));
  assert.equal(summary.journeys[0].reason, "[redacted oversized diagnostic]");
  assert.equal(summary.verdict, "fail");
  assert.doesNotMatch(JSON.stringify(summary), /fixture-canary/);
});

for (const destination of ["ledgerJsonPath", "ledgerMdPath", "stepSummaryPath"]) {
  test(`unwritable ${destination} fails safely and any writable companion is non-pass`, (t) => {
    const paths = scratch(t);
    writeFileSync(paths.reportPath, JSON.stringify(report()));
    mkdirSync(paths[destination]);
    assert.equal(runGate(paths), 2);
    assert.match(paths.output(), /output_unwritable/);
    assert.doesNotMatch(paths.output(), /\n\s+at |verdict: pass/);
    const companion = destination === "ledgerJsonPath" ? paths.ledgerMdPath : paths.ledgerJsonPath;
    const content = readFileSync(companion, "utf8");
    assert.match(content, /output_unwritable/);
    if (destination !== "ledgerJsonPath") {
      const ledger = JSON.parse(content);
      assert.equal(ledger.verdict, "fail");
      assert.equal(ledger.counts.passed, 1, "output failure preserves observed rows");
    }
    if (destination !== "stepSummaryPath")
      assert.doesNotMatch(readFileSync(paths.stepSummaryPath, "utf8"), /Verdict: \*\*pass\*\*/);
  });
}

test("colliding paths are refused before overwriting the report", (t) => {
  const paths = scratch(t);
  const raw = JSON.stringify(report());
  writeFileSync(paths.reportPath, raw);
  assert.equal(runGate({ ...paths, ledgerJsonPath: paths.reportPath }), 2);
  assert.equal(readFileSync(paths.reportPath, "utf8"), raw);
  assert.match(paths.output(), /output_unwritable/);
});

const pathRoles = ["reportPath", "ledgerJsonPath", "ledgerMdPath", "stepSummaryPath"];
for (const [kind, makeLink] of [
  ["symlink", symlinkSync],
  ["hard link", linkSync],
]) {
  for (let first = 0; first < pathRoles.length; first++) {
    for (const secondRole of pathRoles.slice(first + 1)) {
      const firstRole = pathRoles[first];
      test(`${kind} between ${firstRole} and ${secondRole} refuses all writes`, (t) => {
        const paths = scratch(t);
        const raw = JSON.stringify(report());
        for (const role of pathRoles) {
          if (role !== secondRole) writeFileSync(paths[role], raw);
        }
        makeLink(paths[firstRole], paths[secondRole]);
        assert.equal(runGate(paths), 2);
        for (const role of pathRoles) assert.equal(readFileSync(paths[role], "utf8"), raw);
        assert.equal(
          paths.output(),
          "output_unwritable: choose distinct local input, receipt and summary paths.\n",
        );
      });
    }
  }
}

test("distinct existing report, receipts and summary remain writable", (t) => {
  const paths = scratch(t);
  writeFileSync(paths.reportPath, JSON.stringify(report()));
  for (const role of pathRoles.slice(1)) writeFileSync(paths[role], "prior fixture output\n");
  assert.equal(runGate(paths), 0);
  assert.equal(JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8")).verdict, "pass");
  assert.match(readFileSync(paths.ledgerMdPath, "utf8"), /Verdict: \*\*pass\*\*/);
  assert.match(readFileSync(paths.stepSummaryPath, "utf8"), /^prior fixture output\n/);
  assert.deepEqual(JSON.parse(readFileSync(paths.reportPath, "utf8")), report());
});

test("CLI invalid flags fail with fixed usage diagnostics, not arguments or stacks", (t) => {
  const paths = scratch(t);
  for (const args of [["--fixture-canary"], ["--report"], ["--report", "a", "--report", "b"]]) {
    const child = spawnSync(
      process.execPath,
      [new URL("../../ci/check-staging-journeys.mjs", import.meta.url).pathname, ...args],
      { cwd: paths.dir, encoding: "utf8", timeout: 5000, env: { PATH: process.env.PATH } },
    );
    assert.equal(child.status, 2);
    assert.equal(child.stdout, "");
    assert.match(child.stderr, /^invalid_arguments:/);
    assert.doesNotMatch(child.stderr, /fixture-canary|\n\s+at /);
  }
});
