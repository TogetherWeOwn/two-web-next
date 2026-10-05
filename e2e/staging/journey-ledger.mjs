// Per-journey pass/skip/fail ledger for the staging browser run.
//
// Playwright exits 0 when every test skips, so a run with all journeys
// skipped (for example empty-staging preconditions) looks green unless
// something counts outcomes per journey. This module turns a Playwright JSON
// report into a small ledger: one row per journey with its status and reason,
// plus a verdict. The `ci/check-staging-journeys.mjs` gate runs it in CI and
// fails loud when nothing passed.

export const LEDGER_VERSION = 1;

const MAX_REASON_LENGTH = 200;

function cleanReason(value) {
  if (typeof value !== "string") return "";
  const line = value
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim()
    .slice(0, MAX_REASON_LENGTH);
  return line;
}

function skipReason(test) {
  const annotations = Array.isArray(test.annotations) ? test.annotations : [];
  for (const note of annotations) {
    if (note && (note.type === "skip" || note.type === "fixme")) {
      const reason = cleanReason(note.description);
      if (reason) return reason;
    }
  }
  const results = Array.isArray(test.results) ? test.results : [];
  for (const result of results) {
    const reason = cleanReason(result?.error?.message);
    if (reason) return reason;
  }
  return "no reason recorded";
}

function failureReason(test) {
  const results = Array.isArray(test.results) ? test.results : [];
  for (const result of results) {
    if (result?.status === "failed" || result?.status === "timedOut") {
      const reason = cleanReason(result?.error?.message);
      if (reason) return reason;
    }
  }
  return "failed with no error message";
}

function collectTests(suites, out) {
  for (const suite of suites ?? []) {
    if (!suite || typeof suite !== "object") continue;
    for (const spec of suite.specs ?? []) {
      const file = typeof spec?.file === "string" ? spec.file : "";
      const title = typeof spec?.title === "string" ? spec.title : "";
      for (const test of spec?.tests ?? []) {
        out.push({ file, title, test });
      }
    }
    collectTests(suite.suites, out);
  }
}

/**
 * Summarize a Playwright JSON report into a journey ledger.
 *
 * @param {unknown} report parsed `playwright/test --reporter=json` output
 * @returns {{ version: number, counts: { total: number, passed: number, failed: number, skipped: number, flaky: number }, journeys: Array<{ name: string, file: string, project: string, status: string, reason: string | null }>, verdict: "pass" | "fail" | "all-skipped" | "empty" }}
 */
export function summarizeJourneys(report) {
  const suites = Array.isArray(report?.suites) ? report.suites : [];
  const flat = [];
  collectTests(suites, flat);

  const journeys = flat.map(({ file, title, test }) => {
    const project =
      typeof test?.projectName === "string" && test.projectName ? test.projectName : "default";
    const name = project === "default" ? title : `${title} [${project}]`;
    const status = test?.status;
    if (status === "skipped") {
      return { name, file, project, status: "skipped", reason: skipReason(test) };
    }
    if (status === "flaky") {
      return { name, file, project, status: "flaky", reason: null };
    }
    if (status === "unexpected") {
      return { name, file, project, status: "failed", reason: failureReason(test) };
    }
    return { name, file, project, status: "passed", reason: null };
  });

  const counts = {
    total: journeys.length,
    passed: journeys.filter((j) => j.status === "passed" || j.status === "flaky").length,
    failed: journeys.filter((j) => j.status === "failed").length,
    skipped: journeys.filter((j) => j.status === "skipped").length,
    flaky: journeys.filter((j) => j.status === "flaky").length,
  };

  let verdict = "pass";
  if (counts.total === 0) {
    verdict = "empty";
  } else if (counts.failed > 0) {
    verdict = "fail";
  } else if (counts.passed === 0) {
    verdict = "all-skipped";
  }

  return { version: LEDGER_VERSION, counts, journeys, verdict };
}

/**
 * Render the ledger as Markdown for the GitHub step summary.
 *
 * @param {{ counts: { total: number, passed: number, failed: number, skipped: number, flaky: number }, journeys: Array<{ name: string, file: string, project: string, status: string, reason: string | null }>, verdict: string }} summary
 */
export function formatLedgerMarkdown(summary) {
  const { counts, journeys, verdict } = summary;
  const lines = [
    "## Staging journey ledger",
    "",
    `Verdict: **${verdict}** — ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.total} total.`,
    "",
  ];
  if (verdict === "all-skipped") {
    lines.push(
      "> LOUD ALL-SKIPPED: every staging journey skipped, so this run FAILS instead of",
      "> reporting a quiet green. Each skipped journey and its reason is listed below.",
      "",
    );
  }
  if (verdict === "empty") {
    lines.push(
      "> LOUD EMPTY: the Playwright JSON report recorded no journeys. This run FAILS",
      "> instead of reporting a quiet green.",
      "",
    );
  }
  lines.push("| Journey | Project | Status | Reason |", "| --- | --- | --- | --- |");
  for (const journey of journeys) {
    const cells = [journey.name, journey.project, journey.status, journey.reason ?? "—"].map(
      (cell) => cell.replace(/\|/g, "\\|"),
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (journeys.length === 0) lines.push("| (no journeys recorded) | — | — | — |");
  lines.push("");
  return lines.join("\n");
}
