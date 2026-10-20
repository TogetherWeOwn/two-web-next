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
  return value
    .split(/\r?\n/, 1)[0]
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .trim();
}

function skipReason(test, qaAuthToken) {
  const annotations = Array.isArray(test.annotations) ? test.annotations : [];
  for (const note of annotations) {
    if (note && (note.type === "skip" || note.type === "fixme")) {
      const reason = scrubDiagnosticReason(note.description, qaAuthToken);
      if (reason) return reason;
    }
  }
  const results = Array.isArray(test.results) ? test.results : [];
  for (const result of results) {
    const reason = scrubDiagnosticReason(result?.error?.message, qaAuthToken);
    if (reason) return reason;
  }
  return "no reason recorded";
}

function scrubDiagnosticReason(value, qaAuthToken) {
  if (typeof value !== "string") return "";
  // Find URL/token spans in the original text: replacing either first can split
  // the other and leave a tail. Merge overlaps before inserting any markers.
  const spans = Array.from(value.matchAll(/https?:\/\/\S+/gi), (match) => ({
    start: match.index,
    end: match.index + match[0].length,
    marker: "[redacted url]",
  }));
  if (typeof qaAuthToken === "string" && qaAuthToken) {
    for (
      let start = value.indexOf(qaAuthToken);
      start !== -1;
      start = value.indexOf(qaAuthToken, start + 1)
    ) {
      spans.push({ start, end: start + qaAuthToken.length, marker: "[redacted token]" });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  let scrubbed = "";
  let cursor = 0;
  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    while (i + 1 < spans.length && spans[i + 1].start < span.end) {
      const next = spans[++i];
      span.end = Math.max(span.end, next.end);
      if (next.marker === "[redacted url]") span.marker = next.marker;
    }
    scrubbed += value.slice(cursor, span.start) + span.marker;
    cursor = span.end;
  }
  // Normalization and truncation must not split a configured token either.
  return cleanReason(scrubbed + value.slice(cursor))
    .replace(
      /["']?\b[\w-]*(?:__Host-[\w-]*|authorization|cookie|x-two-qa-auth|token|password|passwd|api[_\s-]*key|secret|private[_\s-]*key|session)[\w\s-]*["']?\s*[:=].*$/i,
      "[redacted credential data]",
    )
    .replace(
      /["']?\b(bearer|basic|digest)\b["']?(?:\s*[:=]\s*|\s+).*$/gi,
      (_, scheme) => `${scheme[0].toUpperCase()}${scheme.slice(1).toLowerCase()} [redacted]`,
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(
      /["']?\b[\w-]*(?:(?:member|user)(?:[_\s-]*(?:id|name))?|display[_\s-]*name|email|discord[_\s-]*id)[\w-]*["']?\s*[:=].*$/gi,
      "[redacted member data]",
    )
    .replace(/\b\d{17,}\b/g, "[redacted id]")
    .slice(0, MAX_REASON_LENGTH);
}

function failureReason(test, qaAuthToken) {
  const results = Array.isArray(test.results) ? test.results : [];
  for (const result of results) {
    if (result?.status === "failed" || result?.status === "timedOut") {
      const reason = scrubDiagnosticReason(result?.error?.message, qaAuthToken);
      if (reason) return reason;
    }
  }
  return "failed with no error message";
}

function flakyFailureReason(test, qaAuthToken) {
  const results = Array.isArray(test.results) ? test.results : [];
  for (const result of results) {
    if (result?.status !== "failed" && result?.status !== "timedOut") continue;
    const reason = scrubDiagnosticReason(result?.error?.message, qaAuthToken);
    if (reason) return reason;
  }
  return "flaky result; first-attempt failure details unavailable";
}

function unknownStatusReason(status, qaAuthToken) {
  if (typeof status !== "string") return "unknown test status: missing or non-string status";
  const cleaned = scrubDiagnosticReason(status, qaAuthToken);
  if (!cleaned) return "unknown test status: empty status";
  return `unknown test status: ${cleaned}`.slice(0, MAX_REASON_LENGTH);
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
 * @param {{ qaAuthToken?: string }} options known secret values to scrub from diagnostic reasons
 * @returns {{ version: number, counts: { total: number, passed: number, failed: number, skipped: number, flaky: number }, journeys: Array<{ name: string, file: string, project: string, status: string, reason: string | null }>, verdict: "pass" | "fail" | "all-skipped" | "empty" }}
 */
export function summarizeJourneys(report, { qaAuthToken } = {}) {
  const suites = Array.isArray(report?.suites) ? report.suites : [];
  const flat = [];
  collectTests(suites, flat);

  const journeys = flat.map(({ file, title, test }) => {
    const project =
      typeof test?.projectName === "string" && test.projectName ? test.projectName : "default";
    const name = project === "default" ? title : `${title} [${project}]`;
    const status = test?.status;
    if (status === "skipped") {
      return { name, file, project, status: "skipped", reason: skipReason(test, qaAuthToken) };
    }
    if (status === "flaky") {
      return {
        name,
        file,
        project,
        status: "flaky",
        reason: flakyFailureReason(test, qaAuthToken),
      };
    }
    if (status === "unexpected") {
      return { name, file, project, status: "failed", reason: failureReason(test, qaAuthToken) };
    }
    if (status === "expected") {
      return { name, file, project, status: "passed", reason: null };
    }
    return {
      name,
      file,
      project,
      status: "failed",
      reason: unknownStatusReason(status, qaAuthToken),
    };
  });

  const counts = {
    total: journeys.length,
    passed: journeys.filter((j) => j.status === "passed").length,
    failed: journeys.filter((j) => j.status === "failed" || j.status === "flaky").length,
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
  if (counts.flaky > 0) {
    lines.push(
      `> LOUD FLAKY: ${counts.flaky} flaky journey result(s) fail closed; verify the retries setting and report config/provenance (including any --retries override).`,
      "> First-attempt failure context is in the bounded ledger reason below; only scrubbed failure evidence is eligible for upload.",
      "",
    );
  }
  lines.push("| Journey | Project | Status | Reason |", "| --- | --- | --- | --- |");
  for (const journey of journeys) {
    const cells = [journey.name, journey.project, journey.status, journey.reason ?? "—"].map(
      (cell) => cell.replace(/\\/g, "\\\\").replace(/\|/g, "\\|"),
    );
    lines.push(`| ${cells.join(" | ")} |`);
  }
  if (journeys.length === 0) lines.push("| (no journeys recorded) | — | — | — |");
  lines.push("");
  return lines.join("\n");
}
