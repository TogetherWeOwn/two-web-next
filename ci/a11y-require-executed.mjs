// Fails unless a Vitest JSON report shows the named suite really ran: the
// suite appears with distinct passed cases, every matched case passed, at
// least `min` ran, and the report holds no pending, todo, failed or
// contradictory entries. An opt-in `skipIf`, a failing `beforeAll` (vitest
// then reports every case skipped) or a dropped case would otherwise leave a
// green run that executed nothing. Counters alone never admit a receipt.
//
// Usage: node ci/a11y-require-executed.mjs <report.json> <suite title> <min> [--format json]
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import {
  ReceiptFailure,
  admitCases,
  caseIdFor,
  displaySuite,
  emitFailure,
  emitSuccess,
  humanSuccessLine,
  parseCliArgs,
  passReceipt,
  suiteIdFor,
  validateMinimum,
  validateSuiteName,
} from "./execution-receipt-authority.mjs";

const SUMMARY_KEYS = [
  "numTotalTests",
  "numPassedTests",
  "numFailedTests",
  "numPendingTests",
  "numTodoTests",
];
const KNOWN_STATUSES = new Set(["passed", "failed", "pending", "todo", "skipped", "cancelled"]);

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// JSON.parse keeps the last of two identical keys, which would hide an
// ambiguous report. This scan refuses any object that repeats a key. It only
// adds duplicate detection: JSON.parse stays the validity authority, so the
// scan must never throw on malformed input.
export function assertNoDuplicateKeys(raw) {
  const frames = [];
  let index = 0;
  const readString = () => {
    let out = "";
    index += 1;
    while (index < raw.length) {
      const char = raw[index];
      if (char === '"') {
        index += 1;
        return out;
      }
      if (char === "\\") {
        const next = raw[index + 1];
        if (next === "u" && /^[0-9a-fA-F]{4}$/.test(raw.slice(index + 2, index + 6))) {
          out += String.fromCharCode(Number.parseInt(raw.slice(index + 2, index + 6), 16));
          index += 6;
          continue;
        }
        if (next !== undefined) {
          out += next;
          index += 2;
          continue;
        }
      }
      out += char;
      index += 1;
    }
    return out;
  };
  const skipGap = () => {
    while (index < raw.length && /\s/.test(raw[index])) index += 1;
  };
  while (index < raw.length) {
    skipGap();
    if (index >= raw.length) break;
    const char = raw[index];
    if (char === '"') {
      const text = readString();
      skipGap();
      const top = frames[frames.length - 1];
      if (raw[index] === ":" && top?.type === "object" && top.expectKey) {
        if (top.keys.has(text))
          throw new ReceiptFailure("execution receipt refused (duplicate-json-key)");
        top.keys.add(text);
        top.expectKey = false;
        index += 1;
      }
      continue;
    }
    if (char === "{") {
      frames.push({ type: "object", keys: new Set(), expectKey: true });
      index += 1;
      continue;
    }
    if (char === "[") {
      frames.push({ type: "array" });
      index += 1;
      continue;
    }
    if (char === "}" || char === "]") {
      frames.pop();
      index += 1;
      const top = frames[frames.length - 1];
      if (top?.type === "object") top.expectKey = true;
      continue;
    }
    if (char === ",") {
      index += 1;
      const top = frames[frames.length - 1];
      if (top?.type === "object") top.expectKey = true;
      continue;
    }
    if (char === ":") {
      index += 1;
      const top = frames[frames.length - 1];
      if (top?.type === "object") top.expectKey = false;
      continue;
    }
    index += 1;
  }
}

function validCount(report, key) {
  const value = report[key];
  if (!Number.isSafeInteger(value) || value < 0)
    throw new ReceiptFailure(`execution receipt refused (invalid-test-summary: ${key})`);
  return value;
}

function canonicalStatus(status) {
  if (status === "passed") return "passed";
  if (status === "failed") return "failed";
  if (status === "pending" || status === "skipped") return "skipped";
  if (status === "todo") return "todo";
  return "cancelled";
}

function admitVitest(report, suite, min) {
  validateSuiteName(suite);
  validateMinimum(min);
  if (!isRecord(report)) throw new ReceiptFailure("execution receipt refused (malformed-report)");
  const expected = {};
  for (const key of SUMMARY_KEYS) expected[key] = validCount(report, key);
  if (!Array.isArray(report.testResults))
    throw new ReceiptFailure("execution receipt refused (invalid-test-summary: testResults)");
  const names = new Set();
  const parsed = [];
  for (const file of report.testResults) {
    if (!isRecord(file))
      throw new ReceiptFailure("execution receipt refused (malformed-result-entry)");
    if (typeof file.name !== "string" || file.name.trim().length === 0)
      throw new ReceiptFailure("execution receipt refused (missing-file-identity)");
    if (names.has(file.name))
      throw new ReceiptFailure("execution receipt refused (duplicate-file-result)");
    names.add(file.name);
    if (!Array.isArray(file.assertionResults))
      throw new ReceiptFailure("execution receipt refused (invalid-assertion-results)");
    for (const entry of file.assertionResults) {
      if (!isRecord(entry))
        throw new ReceiptFailure("execution receipt refused (malformed-result-entry)");
      const ancestors = entry.ancestorTitles;
      if (
        !Array.isArray(ancestors) ||
        ancestors.length === 0 ||
        ancestors.some((title) => typeof title !== "string" || title.trim().length === 0)
      )
        throw new ReceiptFailure("execution receipt refused (malformed-ancestor-titles)");
      if (typeof entry.title !== "string" || entry.title.trim().length === 0)
        throw new ReceiptFailure("execution receipt refused (missing-case-identity)");
      if (entry.fullName !== [...ancestors, entry.title].join(" "))
        throw new ReceiptFailure("execution receipt refused (conflicting-case-identity)");
      if (typeof entry.status !== "string" || !KNOWN_STATUSES.has(entry.status))
        throw new ReceiptFailure("execution receipt refused (unknown-case-status)");
      parsed.push({
        file: file.name,
        fullName: entry.fullName,
        status: entry.status,
        ancestors,
      });
    }
  }
  const cases = parsed
    .filter((entry) => entry.ancestors.includes(suite))
    .map((entry) => ({
      id: caseIdFor("vitest", [entry.file, entry.fullName]),
      status: canonicalStatus(entry.status),
    }));
  admitCases(suite, min, cases);
  const observed = {
    numTotalTests: parsed.length,
    numPassedTests: parsed.filter((entry) => entry.status === "passed").length,
    numFailedTests: parsed.filter((entry) => entry.status === "failed").length,
    numPendingTests: parsed.filter(
      (entry) => entry.status === "pending" || entry.status === "skipped",
    ).length,
    numTodoTests: parsed.filter((entry) => entry.status === "todo").length,
  };
  for (const key of SUMMARY_KEYS) {
    if (expected[key] !== observed[key])
      throw new ReceiptFailure(
        `${displaySuite(suite)}: execution receipt refused (contradictory-test-summary: ${key} ${expected[key]}, cases ${observed[key]})`,
      );
  }
  if (
    expected.numFailedTests !== 0 ||
    expected.numPendingTests !== 0 ||
    expected.numTodoTests !== 0
  )
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (unclean-test-summary: failed ${expected.numFailedTests}, ` +
        `pending ${expected.numPendingTests}, todo ${expected.numTodoTests})`,
    );
  if (report.success !== true)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (false-success-report)`,
    );
  return {
    count: cases.length,
    suiteId: suiteIdFor("vitest", suite),
    caseIds: cases.map((entry) => entry.id),
  };
}

export function executedSummary(report, suite) {
  validateSuiteName(suite);
  if (!isRecord(report) || !Array.isArray(report.testResults))
    throw new ReceiptFailure("execution receipt refused (malformed-report)");
  const matched = report.testResults
    .flatMap((file) =>
      isRecord(file) && Array.isArray(file.assertionResults) ? file.assertionResults : [],
    )
    .filter((entry) => isRecord(entry) && (entry.ancestorTitles ?? []).includes(suite));
  const passed = matched.filter((entry) => entry.status === "passed").length;
  return { total: matched.length, passed };
}

export function checkExecuted(report, suite, min) {
  const { count } = admitVitest(report, suite, min);
  return humanSuccessLine(suite, count, min);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argv = process.argv.slice(2);
  let parsed = null;
  try {
    parsed = parseCliArgs(argv);
    let raw = null;
    try {
      raw = readFileSync(parsed.reportPath, "utf8");
    } catch {
      throw new ReceiptFailure(
        `${displaySuite(parsed.suite)}: execution receipt refused (unreadable-report)`,
      );
    }
    assertNoDuplicateKeys(raw);
    let report = null;
    try {
      report = JSON.parse(raw);
    } catch {
      throw new ReceiptFailure("execution receipt refused (malformed-report)");
    }
    const admitted = admitVitest(report, parsed.suite, parsed.min);
    if (parsed.format === "json") {
      emitSuccess({
        suite: parsed.suite,
        count: admitted.count,
        min: parsed.min,
        format: "json",
        receipt: passReceipt({
          suiteId: admitted.suiteId,
          caseIds: admitted.caseIds,
          count: admitted.count,
        }),
      });
    } else {
      emitSuccess({ suite: parsed.suite, count: admitted.count, min: parsed.min, format: "human" });
    }
  } catch (error) {
    emitFailure({
      adapter: "vitest",
      suite: parsed?.suite ?? null,
      format: parsed?.format ?? "human",
      error,
    });
    process.exit(1);
  }
}
