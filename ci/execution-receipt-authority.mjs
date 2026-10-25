// Single receipt-admission authority behind the TAP and Vitest browser-proof
// verifiers. Both adapters parse their own report format, then admit through
// this module so named-suite, distinct-identity, all-passed, minimum,
// error-code and output policy cannot diverge between formats.
//
// Every refusal message is static text plus operator argv (suite/min) and
// counts. Report bytes, report paths, stacks and raw diagnostics never reach
// stdout, stderr or the CI summary, so a hostile report cannot leak through a
// receipt.
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";

export const RECEIPT_VERSION = 1;
export const RECEIPT_ERROR_CODE = "EXECUTION_RECEIPT_REJECTED";
export const RECEIPT_NEXT_ACTION =
  "Re-run the named browser suite with its documented opt-in enabled, " +
  "then re-verify the fresh report with the same command.";
export const RECEIPT_STDOUT_BYTES_MAX = 16384;
export const RECEIPT_DIAG_BYTES_MAX = 4096;
export const RECEIPT_ID_LENGTH_MAX = 256;
export const RECEIPT_SUITE_DISPLAY_MAX = 256;

// Canonical case outcomes. Adapters map format statuses onto these before
// admission; anything unmapped is refused as malformed by the adapter.
export const RECEIPT_STATUSES = ["passed", "failed", "skipped", "todo", "cancelled"];

export class ReceiptFailure extends Error {
  constructor(message) {
    super(message);
    this.name = "ReceiptFailure";
  }
}

export function displaySuite(suite) {
  if (suite.length <= RECEIPT_SUITE_DISPLAY_MAX) return suite;
  return `${suite.slice(0, RECEIPT_SUITE_DISPLAY_MAX - 1)}…`;
}

function displayRaw(value) {
  return String(value)
    .replace(/[\r\n\x00-\x1f\x7f]/g, "?")
    .slice(0, 64);
}

export function validateSuiteName(suite) {
  if (typeof suite !== "string" || suite.trim().length === 0)
    throw new ReceiptFailure("execution receipt refused: suite name must be a non-blank string");
  if (/[\r\n\x00-\x1f\x7f]/.test(suite))
    throw new ReceiptFailure("execution receipt refused: suite name must not hold control text");
  return suite;
}

export function validateMinimum(raw) {
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isSafeInteger(value) || value < 1)
    throw new ReceiptFailure(`Minimum case count must be a positive integer: ${displayRaw(raw)}`);
  return value;
}

// Validates argv of shape [report, suite, min, ...rest]. Rest must be empty
// (human output) or exactly ["--format", "json"]. Throws before any caller
// IO so invalid invocations never open the report or touch the summary.
export function parseCliArgs(argv) {
  if (argv.length < 3)
    throw new ReceiptFailure(
      "execution receipt refused: expected <report> <suite> <min> [--format json]",
    );
  const [reportPath, suiteRaw, minRaw, ...rest] = argv;
  if (typeof reportPath !== "string" || reportPath.length === 0)
    throw new ReceiptFailure("execution receipt refused: report path must be a non-empty string");
  let format = "human";
  if (rest.length > 0) {
    if (rest.length !== 2 || rest[0] !== "--format" || rest[1] !== "json")
      throw new ReceiptFailure(
        "execution receipt refused: unknown arguments (only --format json is supported)",
      );
    format = "json";
  }
  const suite = validateSuiteName(suiteRaw);
  const min = validateMinimum(minRaw);
  return { reportPath, suite, min, format };
}

export function stableId(prefix, parts) {
  const digest = createHash("sha256").update(parts.join("\n"), "utf8").digest("hex").slice(0, 32);
  return `${prefix}-${digest}`;
}

export function suiteIdFor(adapter, suite) {
  return stableId(adapter, [suite]);
}

export function caseIdFor(adapter, parts) {
  return stableId(`${adapter}-case`, parts);
}

function countBy(cases, status) {
  return cases.filter((entry) => entry.status === status).length;
}

// Shared admission: distinct identities, every matched case passed, at least
// the minimum ran. Cases carry adapter-built {id, status} pairs with canonical
// statuses; ids must already be distinct-safe (hashes), never raw names.
export function admitCases(suite, min, cases) {
  const ids = cases.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: execution receipt refused (duplicate-case-identity)`,
    );
  const failed = countBy(cases, "failed");
  const skipped = countBy(cases, "skipped");
  const todo = countBy(cases, "todo");
  const cancelled = countBy(cases, "cancelled");
  const notPassed = failed + skipped + todo + cancelled;
  if (notPassed > 0)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: ${notPassed} of ${cases.length} cases did not pass ` +
        `(failed ${failed}, skipped ${skipped}, todo ${todo}, cancelled ${cancelled})`,
    );
  if (cases.length < min)
    throw new ReceiptFailure(
      `${displaySuite(suite)}: ${cases.length} cases executed, expected at least ${min}`,
    );
  return cases.length;
}

export function humanSuccessLine(suite, count, min) {
  return `${displaySuite(suite)}: ${count} cases executed and passed, 0 skipped (minimum ${min})`;
}

export function passReceipt({ suiteId, caseIds, count }) {
  return {
    version: RECEIPT_VERSION,
    suite_id: suiteId,
    cases: caseIds.map((case_id) => ({ case_id })),
    counts: { executed: count, passed: count, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    verdict: "pass",
    error_code: null,
    next_action: RECEIPT_NEXT_ACTION,
  };
}

// Refusals admit nothing, so failure counts stay zero: the verdict and the
// fixed code carry the outcome, never report-derived numbers or text.
export function failReceipt(suiteId) {
  return {
    version: RECEIPT_VERSION,
    suite_id: suiteId,
    cases: [],
    counts: { executed: 0, passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0 },
    verdict: "fail",
    error_code: RECEIPT_ERROR_CODE,
    next_action: RECEIPT_NEXT_ACTION,
  };
}

function failSuiteId(adapter, suite) {
  return typeof suite === "string" && suite.length > 0
    ? suiteIdFor(adapter, suite)
    : "unknown-suite";
}

export function emitFailure({ adapter, suite, format, error }) {
  const message = error instanceof Error ? error.message : String(error);
  const annotation = `::error::${message}`;
  if (format === "json") {
    process.stdout.write(`${JSON.stringify(failReceipt(failSuiteId(adapter, suite)))}\n`);
    process.stderr.write(`${annotation}\n`);
  } else {
    process.stdout.write("");
    process.stderr.write(`${annotation}\n`);
  }
}

export function emitSuccess({ suite, count, min, format, receipt }) {
  const line = humanSuccessLine(suite, count, min);
  const output = `${format === "json" ? JSON.stringify(receipt) : line}\n`;
  if (Buffer.byteLength(output, "utf8") > RECEIPT_STDOUT_BYTES_MAX)
    throw new ReceiptFailure("execution receipt refused (receipt-output-too-large)");
  // Append the CI summary before emitting stdout: if the append fails, the
  // refusal must not follow an already-written pass receipt or success line.
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (summary) {
    try {
      appendFileSync(summary, `${line}\n`);
    } catch {
      throw new ReceiptFailure(
        `${displaySuite(suite)}: execution receipt refused (summary-append-failed)`,
      );
    }
  }
  process.stdout.write(output);
  return line;
}
