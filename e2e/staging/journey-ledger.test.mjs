import assert from "node:assert/strict";
import { test } from "node:test";
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
