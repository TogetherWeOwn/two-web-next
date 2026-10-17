import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { runGate } from "../../ci/check-staging-journeys.mjs";
import { formatLedgerMarkdown, summarizeJourneys } from "./journey-ledger.mjs";

function reportWith(specs) {
  return {
    suites: [{ title: "e2e/staging/auth.spec.ts", file: "e2e/staging/auth.spec.ts", specs }],
  };
}

function passingSpec() {
  return {
    title: "staging QA member session opens the member profile",
    file: "e2e/staging/auth.spec.ts",
    tests: [{ projectName: "chromium", status: "expected", annotations: [], results: [] }],
  };
}

function skippedSpec(title, reason) {
  return {
    title,
    file: "e2e/staging/event-rsvp.spec.ts",
    tests: [
      {
        projectName: "chromium",
        status: "skipped",
        annotations: reason ? [{ type: "skip", description: reason }] : [],
        results: [],
      },
    ],
  };
}

test("all-skipped run names every journey with its reason and fails loud", () => {
  const summary = summarizeJourneys(
    reportWith([
      skippedSpec(
        "staging member RSVPs going on a fixture, then withdraws",
        "no events on staging",
      ),
      skippedSpec("staging moderator creates a draft then cancels it without publishing", ""),
    ]),
  );
  assert.equal(summary.verdict, "all-skipped");
  assert.deepEqual(summary.counts, { total: 2, passed: 0, failed: 0, skipped: 2, flaky: 0 });
  assert.equal(summary.journeys[0].status, "skipped");
  assert.equal(summary.journeys[0].reason, "no events on staging");
  assert.equal(summary.journeys[1].reason, "no reason recorded");
  const markdown = formatLedgerMarkdown(summary);
  assert.match(markdown, /LOUD ALL-SKIPPED/);
  assert.match(markdown, /no events on staging/);
  assert.match(markdown, /no reason recorded/);
});

test("mixed pass and skip stays green while the skip stays visible", () => {
  const summary = summarizeJourneys(reportWith([passingSpec(), skippedSpec("journey b", "empty")]));
  assert.equal(summary.verdict, "pass");
  assert.deepEqual(summary.counts, { total: 2, passed: 1, failed: 0, skipped: 1, flaky: 0 });
  const markdown = formatLedgerMarkdown(summary);
  assert.doesNotMatch(markdown, /LOUD ALL-SKIPPED/);
  assert.match(markdown, /journey b/);
});

test("any failure is a fail verdict with the first-line reason", () => {
  const summary = summarizeJourneys(
    reportWith([
      passingSpec(),
      {
        title: "staging events list searches, clears and steps the calendar month",
        file: "e2e/staging/events-list.spec.ts",
        tests: [
          {
            projectName: "mobile-375",
            status: "unexpected",
            annotations: [],
            results: [
              { status: "failed", error: { message: "Timeout 30000ms exceeded\nCall log:\n..." } },
            ],
          },
        ],
      },
    ]),
  );
  assert.equal(summary.verdict, "fail");
  assert.equal(summary.counts.failed, 1);
  assert.equal(summary.journeys[1].reason, "Timeout 30000ms exceeded");
  assert.equal(summary.journeys[1].project, "mobile-375");
});

test("empty report fails closed instead of reporting green", () => {
  for (const report of [undefined, null, {}, { suites: [] }, { suites: [{ specs: [] }] }]) {
    const summary = summarizeJourneys(report);
    assert.equal(summary.verdict, "empty");
    assert.equal(summary.counts.total, 0);
    assert.match(formatLedgerMarkdown(summary), /LOUD EMPTY/);
  }
});

test("flaky counts as passed and nested suites are collected", () => {
  const summary = summarizeJourneys({
    suites: [
      {
        title: "outer",
        specs: [],
        suites: [
          {
            title: "inner",
            specs: [
              {
                title: "nested journey",
                file: "e2e/staging/profile.spec.ts",
                tests: [{ projectName: "chromium", status: "flaky", annotations: [], results: [] }],
              },
            ],
          },
        ],
      },
    ],
  });
  assert.equal(summary.verdict, "pass");
  assert.equal(summary.counts.flaky, 1);
  assert.equal(summary.counts.passed, 1);
  assert.equal(summary.journeys[0].name, "nested journey [chromium]");
});

test("pipe characters in names do not break the markdown table", () => {
  const summary = summarizeJourneys(reportWith([skippedSpec("a | b", "x | y")]));
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| a"));
  assert.match(row ?? "", /a \\| b/);
  assert.match(row ?? "", /x \\| y/);
});

test("a backslash before a pipe stays one escaped cell", () => {
  const summary = summarizeJourneys(reportWith([skippedSpec("a\\|b", "x\\|y")]));
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| a"));
  // Backslash escaped first, then the pipe: `a\\\|b` renders as one cell, so
  // the row still splits into exactly 6 segments on unescaped pipes (a live
  // pipe inside the cell would make 7).
  assert.match(row ?? "", /a\\\\\\\|b/);
  assert.equal((row ?? "").split(/(?<!\\)\|/).length, 6);
});

test("the always-run ledger upload ships only derived files, never the raw report", () => {
  const workflow = readFileSync(
    new URL("../../.github/workflows/e2e-staging.yml", import.meta.url),
    "utf8",
  );
  const step = workflow
    .split(/\n {6}- name: /)
    .find((s) => s.startsWith("Journey ledger artifact"));
  assert.ok(step, "Journey ledger artifact step exists");
  // The step runs on green runs too, where the token scrub never ran, so it
  // must not upload the raw Playwright JSON report.
  // The ledger quotes failure error text, so on a failed run it must wait for
  // the scrub sweep like the failure upload does, and a scrub crash (swept
  // unset) must upload nothing. A green run (scrub skipped) still uploads.
  assert.doesNotMatch(step, /if: always\(\)/);
  assert.match(
    step,
    /if: \$\{\{ !cancelled\(\) && \(steps\.scrub\.outcome == 'skipped' \|\| steps\.scrub\.outputs\.swept == 'true'\) \}\}/,
  );
  assert.doesNotMatch(step, /staging-journeys\.json/);
  assert.match(step, /staging-journey-ledger\.json/);
  assert.match(step, /staging-journey-ledger\.md/);
});

function statusSpec(title, status) {
  return {
    title,
    file: "e2e/staging/auth.spec.ts",
    tests: [{ projectName: "chromium", status, annotations: [], results: [] }],
  };
}

test("unknown, missing or non-string statuses fail closed with bounded diagnostics", () => {
  for (const status of ["interrupted", "passed", "timedOut", "", 123, null, undefined, {}]) {
    const summary = summarizeJourneys(
      reportWith([statusSpec(`journey with ${String(status)}`, status)]),
    );
    assert.equal(summary.verdict, "fail", `status ${String(status)} must fail`);
    assert.deepEqual(summary.counts, { total: 1, passed: 0, failed: 1, skipped: 0, flaky: 0 });
    assert.equal(summary.journeys[0].status, "failed");
    assert.match(summary.journeys[0].reason ?? "", /^unknown test status: /);
    assert.ok(
      (summary.journeys[0].reason ?? "").length <= 200,
      "unknown-status reason stays bounded",
    );
    assert.doesNotMatch(summary.journeys[0].reason ?? "", /[\u0000-\u001f\u007f\n]/);
  }
});

test("unknown-status reason stays bounded and single-line for long input", () => {
  const summary = summarizeJourneys(
    reportWith([statusSpec("long status", `x${"y".repeat(500)}|pipe`)]),
  );
  assert.equal(summary.verdict, "fail");
  assert.ok(summary.journeys[0].reason.length <= 200);
  assert.doesNotMatch(summary.journeys[0].reason, /\n/);
  const row = formatLedgerMarkdown(summary)
    .split("\n")
    .find((line) => line.startsWith("| long status"));
  assert.ok(row, "unknown-status row renders in markdown");
  assert.match(row ?? "", /unknown test status/);
});

test("expected still passes and an unknown beside it still fails the run", () => {
  const summary = summarizeJourneys(
    reportWith([passingSpec(), statusSpec("interrupted journey", "interrupted")]),
  );
  assert.equal(summary.verdict, "fail");
  assert.deepEqual(summary.counts, { total: 2, passed: 1, failed: 1, skipped: 0, flaky: 0 });
});

function gateScratch(prefix) {
  const base =
    process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir();
  const dir = mkdtempSync(join(base, prefix));
  return {
    dir,
    reportPath: join(dir, "staging-journeys.json"),
    ledgerJsonPath: join(dir, "staging-journey-ledger.json"),
    ledgerMdPath: join(dir, "staging-journey-ledger.md"),
    stepSummaryPath: join(dir, "step-summary.md"),
  };
}

function gateStreams() {
  let out = "";
  let err = "";
  return {
    get out() {
      return out;
    },
    get err() {
      return err;
    },
    stdout: {
      write: (chunk) => {
        out += String(chunk);
        return true;
      },
    },
    stderr: {
      write: (chunk) => {
        err += String(chunk);
        return true;
      },
    },
  };
}

function writeReport(path, value) {
  writeFileSync(path, `${JSON.stringify(value)}\n`);
}

test("gate exit 0 on mixed expected and skipped with ledger and step-summary output", () => {
  const paths = gateScratch("journey-gate-pass-");
  writeReport(paths.reportPath, reportWith([passingSpec(), skippedSpec("journey b", "empty")]));
  const streams = gateStreams();
  const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
  assert.equal(code, 0);
  const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
  assert.equal(ledger.verdict, "pass");
  assert.deepEqual(ledger.counts, { total: 2, passed: 1, failed: 0, skipped: 1, flaky: 0 });
  const markdown = readFileSync(paths.ledgerMdPath, "utf8");
  assert.match(markdown, /## Staging journey ledger/);
  assert.match(markdown, /journey b/);
  const summary = readFileSync(paths.stepSummaryPath, "utf8");
  assert.match(summary, /## Staging journey ledger/);
  assert.match(streams.out, /1 passed, 0 failed, 1 skipped/);
});

test("gate exit 1 on unexpected failure and on unknown or missing status", () => {
  for (const [label, specs] of [
    ["unexpected", reportWith([passingSpec(), statusSpec("bad journey", "unexpected")])],
    ["interrupted", reportWith([passingSpec(), statusSpec("cut short", "interrupted")])],
    ["missing", reportWith([passingSpec(), statusSpec("no status", undefined)])],
    ["non-string", reportWith([passingSpec(), statusSpec("weird status", 123)])],
  ]) {
    const paths = gateScratch(`journey-gate-fail-${label}-`);
    writeReport(paths.reportPath, specs);
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 1, `${label} must exit 1`);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "fail");
    assert.equal(ledger.counts.failed, 1);
    assert.match(streams.err, /Staging journeys failed/);
  }
});

test("gate exit 2 on unreadable, empty and all-skipped reports", () => {
  const unreadable = gateScratch("journey-gate-unreadable-");
  {
    const streams = gateStreams();
    const code = runGate({ ...unreadable, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2);
    assert.match(streams.err, /LOUD ALL-SKIPPED: no readable Playwright JSON report/);
  }
  for (const [label, report] of [
    ["empty-object", {}],
    ["empty-suites", { suites: [] }],
  ]) {
    const paths = gateScratch(`journey-gate-empty-${label}-`);
    writeReport(paths.reportPath, report);
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2, `${label} must exit 2`);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "empty");
    assert.match(readFileSync(paths.ledgerMdPath, "utf8"), /LOUD EMPTY/);
    assert.match(streams.err, /LOUD ALL-SKIPPED/);
  }
  {
    const paths = gateScratch("journey-gate-all-skipped-");
    writeReport(
      paths.reportPath,
      reportWith([skippedSpec("journey a", "no events on staging"), skippedSpec("journey b", "")]),
    );
    const streams = gateStreams();
    const code = runGate({ ...paths, stdout: streams.stdout, stderr: streams.stderr });
    assert.equal(code, 2);
    const ledger = JSON.parse(readFileSync(paths.ledgerJsonPath, "utf8"));
    assert.equal(ledger.verdict, "all-skipped");
    assert.match(readFileSync(paths.stepSummaryPath, "utf8"), /LOUD ALL-SKIPPED/);
    assert.match(streams.err, /LOUD ALL-SKIPPED/);
  }
});

test("critical-journeys guide explains flaky accounting with zero retries and no rerun-until-green", () => {
  const guide = readFileSync(new URL("../../docs/critical-journeys.md", import.meta.url), "utf8");
  const stagingConfig = readFileSync(
    new URL("../../playwright.staging.config.ts", import.meta.url),
    "utf8",
  );
  const normalizedGuide = guide.replace(/\s+/g, " ");
  assert.match(stagingConfig, /retries:\s*0/);
  for (const status of ["`expected`", "`flaky`", "`unexpected`", "`skipped`"]) {
    assert.ok(guide.includes(status), `guide must name ${status}`);
  }
  assert.match(guide, /unknown test status/);
  assert.match(
    normalizedGuide,
    /counts toward `passed` in the headline and CLI line; the separate `flaky` count appears only in `counts\.flaky` in the ledger JSON, while the Markdown table marks the row `flaky`\./,
  );
  assert.ok(
    normalizedGuide.includes(
      "The staging config sets `retries: 0` (`playwright.staging.config.ts`), so a report from this config cannot legitimately contain `flaky`. If a ledger row shows `flaky`, check for a `--retries` override or a report produced by another config before trusting the pass.",
    ),
  );
  assert.match(
    normalizedGuide,
    /flaky row has no reason and does not trigger the failure-only artifact upload/,
  );
  assert.match(normalizedGuide, /`e2e-staging-failure-\*` artifact, retained for seven days/);
  assert.match(normalizedGuide, /documented host-flake loop/);
  assert.match(guide, /[Nn]ever rerun-until-green/);
});

test("gate without a step summary still writes ledger files and exits by verdict", () => {
  const paths = gateScratch("journey-gate-no-summary-");
  writeReport(paths.reportPath, reportWith([passingSpec()]));
  const streams = gateStreams();
  const code = runGate({
    reportPath: paths.reportPath,
    ledgerJsonPath: paths.ledgerJsonPath,
    ledgerMdPath: paths.ledgerMdPath,
    stepSummaryPath: "",
    stdout: streams.stdout,
    stderr: streams.stderr,
  });
  assert.equal(code, 0);
  assert.match(readFileSync(paths.ledgerMdPath, "utf8"), /## Staging journey ledger/);
});
