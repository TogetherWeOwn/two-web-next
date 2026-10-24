// Per-journey pass/skip/fail ledger for the staging browser run.
//
// Playwright exits 0 when every test skips, so a run with all journeys
// skipped (for example empty-staging preconditions) looks green unless
// something counts outcomes per journey. This module turns a Playwright JSON
// report into a small ledger: one row per journey with its status and reason,
// plus a verdict. The `ci/check-staging-journeys.mjs` gate runs it in CI and
// fails loud when nothing passed.

import { createHash } from "node:crypto";

export const LEDGER_VERSION = 2;
export const REPORT_LIMITS = Object.freeze({
  bytes: 8 * 1024 * 1024,
  depth: 64,
  nodes: 100000,
  journeys: 100,
});

const MAX_REASON_LENGTH = 200;
const MAX_DIAGNOSTIC_COUNT = 10000;
const DIAGNOSTICS = Object.freeze({
  report_unreadable: [
    true,
    "Restore the local Playwright JSON report, then regenerate the receipt. Do not rerun a deployment.",
  ],
  report_invalid_json: [
    false,
    "Fix the report producer or recover a complete JSON report, then regenerate the receipt.",
  ],
  report_invalid_shape: [
    false,
    "Check the report producer and nested collection types; retained rows are partial evidence only.",
  ],
  report_too_large: [
    false,
    "Check report size, collection volume and reporter configuration before regenerating the receipt.",
  ],
  report_too_deep: [
    false,
    "Check report nesting and reporter configuration before regenerating the receipt.",
  ],
  runner_error: [
    false,
    "Inspect the original runner/teardown failure in restricted evidence. Do not trust passing rows or rerun until green.",
  ],
  output_unwritable: [
    true,
    "Choose distinct writable local receipt and step-summary paths, then regenerate the receipt.",
  ],
});

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Inspect even ignored metadata without recursion or serialization. CLI input also
// has a byte cap before JSON.parse; direct callers get node/string/depth bounds.
function reportBoundError(report) {
  const pending = [{ value: report, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  let bytes = 0;
  while (pending.length) {
    const { value, depth } = pending.pop();
    if (++nodes > REPORT_LIMITS.nodes) return "report_too_large";
    if (depth > REPORT_LIMITS.depth) return "report_too_deep";
    if (typeof value === "string") bytes += Buffer.byteLength(value);
    if (value !== null && typeof value === "object") {
      if (seen.has(value)) return "report_invalid_shape";
      seen.add(value);
      const keys = Object.keys(value);
      if (nodes + pending.length + keys.length > REPORT_LIMITS.nodes) return "report_too_large";
      for (const key of keys) {
        bytes += Buffer.byteLength(key);
        pending.push({ value: value[key], depth: depth + 1 });
      }
    }
    if (bytes > REPORT_LIMITS.bytes) return "report_too_large";
  }
  return null;
}

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
  // Withhold oversized diagnostics in full instead of truncating a secret or
  // running the legacy redaction patterns over megabytes of attacker text.
  if (value.length > 2048) return "[redacted oversized diagnostic]";
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
      /["']?\b[\w-]*(?:__Host-[\w-]*|authorization|cookie|x-two-qa-auth|token|password|passwd|api[_\s-]*key|secret|private[_\s-]*key|session)[\w\s-]*\\*["']?\s*[:=].*$/i,
      "[redacted credential data]",
    )
    .replace(
      /["']?\b(bearer|basic|digest)\b["']?(?:\s*[:=]\s*|\s+).*$/gi,
      (_, scheme) => `${scheme[0].toUpperCase()}${scheme.slice(1).toLowerCase()} [redacted]`,
    )
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted email]")
    .replace(
      /["']?\b[\w-]*(?:(?:member|user)(?:[_\s-]*(?:id|name))?|display[_\s-]*name|email|discord[_\s-]*id)[\w-]*\\*["']?\s*[:=].*$/gi,
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

function collection(owner, key, addDiagnostic) {
  if (!Object.hasOwn(owner, key)) return [];
  if (Array.isArray(owner[key])) return owner[key];
  addDiagnostic("report_invalid_shape");
  return [];
}

function collectTests(suites, out, addDiagnostic, parents = []) {
  for (const suite of suites) {
    if (!isRecord(suite)) {
      addDiagnostic("report_invalid_shape");
      continue;
    }
    const path = [...parents, typeof suite.title === "string" ? suite.title : ""];
    for (const spec of collection(suite, "specs", addDiagnostic)) {
      if (!isRecord(spec)) {
        addDiagnostic("report_invalid_shape");
        continue;
      }
      const file = typeof spec.file === "string" ? spec.file : "";
      const title = typeof spec.title === "string" ? spec.title : "";
      for (const test of collection(spec, "tests", addDiagnostic)) {
        if (!isRecord(test)) {
          addDiagnostic("report_invalid_shape");
          continue;
        }
        for (const key of ["results", "annotations"]) {
          for (const item of collection(test, key, addDiagnostic)) {
            if (!isRecord(item)) addDiagnostic("report_invalid_shape");
          }
        }
        if (out.length === REPORT_LIMITS.journeys) {
          addDiagnostic("report_too_large");
          return;
        }
        out.push({ file, title, test, path });
      }
    }
    collectTests(collection(suite, "suites", addDiagnostic), out, addDiagnostic, path);
  }
}

function safeProvenance(provenance = {}) {
  return {
    sha:
      typeof provenance.sha === "string" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(provenance.sha)
        ? provenance.sha
        : "unknown",
    runId:
      typeof provenance.runId === "string" && /^[1-9]\d{0,19}$/.test(provenance.runId)
        ? provenance.runId
        : "unknown",
    runAttempt:
      typeof provenance.runAttempt === "string" && /^[1-9]\d{0,9}$/.test(provenance.runAttempt)
        ? provenance.runAttempt
        : "unknown",
  };
}

/**
 * Summarize bounded Playwright JSON. No report objects, global error text,
 * timing measurements, paths supplied to the CLI, or arbitrary provenance are
 * copied into diagnostics. See docs/critical-journeys.md for the receipt contract.
 */
export function summarizeJourneys(
  report,
  { qaAuthToken, provenance, inputError, outputError = false } = {},
) {
  const diagnosticCounts = new Map();
  const addDiagnostic = (code, count = 1) => {
    diagnosticCounts.set(
      code,
      Math.min(MAX_DIAGNOSTIC_COUNT, (diagnosticCounts.get(code) ?? 0) + count),
    );
  };
  const flat = [];
  const boundError = inputError ?? reportBoundError(report);
  if (boundError && Object.hasOwn(DIAGNOSTICS, boundError)) {
    addDiagnostic(boundError);
  } else if (!isRecord(report)) {
    addDiagnostic("report_invalid_shape");
  } else {
    const errors = collection(report, "errors", addDiagnostic);
    let runnerErrors = 0;
    for (const error of errors) {
      if (isRecord(error)) runnerErrors++;
      else addDiagnostic("report_invalid_shape");
    }
    if (runnerErrors) addDiagnostic("runner_error", runnerErrors);
    collectTests(collection(report, "suites", addDiagnostic), flat, addDiagnostic);
  }

  if (outputError) addDiagnostic("output_unwritable");
  const journeys = flat.map(({ file: rawFile, title, test, path }) => {
    const rawProject =
      typeof test.projectName === "string" && test.projectName ? test.projectName : "default";
    const id = `journey:${createHash("sha256")
      .update(JSON.stringify([rawFile, path, title, rawProject]))
      .digest("hex")}`;
    const file = scrubDiagnosticReason(rawFile, qaAuthToken);
    const project = scrubDiagnosticReason(rawProject, qaAuthToken);
    const safeTitle = scrubDiagnosticReason(title, qaAuthToken);
    const name = (project === "default" ? safeTitle : `${safeTitle} [${project}]`).slice(
      0,
      MAX_REASON_LENGTH,
    );
    const status = test.status;
    if (status === "skipped") {
      return { id, name, file, project, status: "skipped", reason: skipReason(test, qaAuthToken) };
    }
    if (status === "flaky") {
      return {
        id,
        name,
        file,
        project,
        status: "flaky",
        reason: flakyFailureReason(test, qaAuthToken),
      };
    }
    if (status === "unexpected") {
      return {
        id,
        name,
        file,
        project,
        status: "failed",
        reason: failureReason(test, qaAuthToken),
      };
    }
    if (status === "expected") {
      return { id, name, file, project, status: "passed", reason: null };
    }
    return {
      id,
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

  const diagnostics = [...diagnosticCounts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([code, count]) => ({
      code,
      count,
      retryable: DIAGNOSTICS[code][0],
      next_action: DIAGNOSTICS[code][1],
    }));
  let verdict = "pass";
  if (diagnosticCounts.has("runner_error")) {
    verdict = "fail";
  } else if (counts.total === 0) {
    verdict = "empty";
  } else if (diagnostics.length > 0 || counts.failed > 0) {
    verdict = "fail";
  } else if (counts.passed === 0) {
    verdict = "all-skipped";
  }

  return {
    version: LEDGER_VERSION,
    schemaVersion: LEDGER_VERSION,
    provenance: safeProvenance(provenance),
    counts,
    journeys,
    diagnostics,
    verdict,
  };
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
  if (summary.provenance) {
    const { sha, runId, runAttempt } = summary.provenance;
    lines.push(
      `Receipt v${summary.schemaVersion}; SHA: ${sha}; run: ${runId}; attempt: ${runAttempt}.`,
      "",
    );
  }
  for (const diagnostic of summary.diagnostics ?? []) {
    lines.push(
      `> ${diagnostic.code} (count: ${diagnostic.count}, retryable: ${diagnostic.retryable}): ${diagnostic.next_action}`,
      "",
    );
  }
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
