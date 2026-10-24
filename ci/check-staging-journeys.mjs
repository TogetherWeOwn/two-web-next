// Fixture-only staging receipt gate; never contacts a Worker or launches a retry.
// Exit: 0 pass; 1 journey/runner failure; 2 input/output error, all-skipped or empty.
import {
  appendFileSync,
  closeSync,
  constants,
  fstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatLedgerMarkdown,
  REPORT_LIMITS,
  summarizeJourneys,
} from "../e2e/staging/journey-ledger.mjs";

export const REPORT_DEFAULT = "test-results/staging-journeys.json";
export const LEDGER_JSON_DEFAULT = "test-results/staging-journey-ledger.json";
export const LEDGER_MD_DEFAULT = "test-results/staging-journey-ledger.md";

const HELP = `Usage: node ci/check-staging-journeys.mjs [--report FILE] [--out-json FILE] [--out-md FILE]

Read a local Playwright JSON report and write bounded JSON + Markdown receipts.
No network, deployment, browser run or automatic retry. --help reads/writes nothing.
Exit: 0 pass; 1 journey/runner failure; 2 input/output error, all-skipped or empty.
Contract: docs/critical-journeys.md#diagnostic-receipt-contract
Hermetic check: node --test e2e/staging/journey-ledger.test.mjs e2e/staging/journey-receipt.test.mjs
`;

function readReport(reportPath) {
  let fd;
  let raw;
  try {
    // O_NONBLOCK plus the regular-file check refuses FIFOs/devices without hanging.
    fd = openSync(resolve(reportPath), constants.O_RDONLY | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { inputError: "report_unreadable" };
    if (stat.size > REPORT_LIMITS.bytes) return { inputError: "report_too_large" };
    const buffer = Buffer.alloc(REPORT_LIMITS.bytes + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, null);
      if (!read) break;
      length += read;
    }
    if (length > REPORT_LIMITS.bytes) return { inputError: "report_too_large" };
    raw = buffer.subarray(0, length).toString("utf8");
  } catch {
    return { inputError: "report_unreadable" };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    return { report: JSON.parse(raw) };
  } catch {
    return { inputError: "report_invalid_json" };
  }
}

export function runGate({
  reportPath = REPORT_DEFAULT,
  ledgerJsonPath = LEDGER_JSON_DEFAULT,
  ledgerMdPath = LEDGER_MD_DEFAULT,
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  // Colliding output paths are not admissible: never overwrite an input report
  // or replace one companion with the other. Do not echo caller-controlled paths.
  const paths = [reportPath, ledgerJsonPath, ledgerMdPath, stepSummaryPath]
    .filter(Boolean)
    .map((path) => resolve(path));
  if (new Set(paths).size !== paths.length) {
    stderr.write("output_unwritable: choose distinct local input, receipt and summary paths.\n");
    return 2;
  }
  const { report, inputError } = readReport(reportPath);
  const options = {
    qaAuthToken: process.env.QA_AUTH_TOKEN,
    provenance: {
      sha: process.env.GITHUB_SHA,
      runId: process.env.GITHUB_RUN_ID,
      runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    },
    inputError,
  };
  let summary = summarizeJourneys(report, options);
  const writeReceipts = () => {
    let failed = false;
    for (const [path, content] of [
      [ledgerJsonPath, `${JSON.stringify(summary, null, 2)}\n`],
      [ledgerMdPath, `${formatLedgerMarkdown(summary)}\n`],
    ]) {
      try {
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(resolve(path), content);
      } catch {
        failed = true;
      }
    }
    return !failed;
  };
  const written = writeReceipts();
  if (!written) summary = summarizeJourneys(report, { ...options, outputError: true });
  let summaryWritten = true;
  if (stepSummaryPath) {
    try {
      appendFileSync(resolve(stepSummaryPath), `\n${formatLedgerMarkdown(summary)}\n`);
    } catch {
      summaryWritten = false;
    }
  }
  if (!written || !summaryWritten) {
    // Make any writable companion non-pass too; never turn an output fault into
    // an exception stack or a clean-looking receipt. Unwritable paths get no file.
    summary = summarizeJourneys(report, { ...options, outputError: true });
    writeReceipts();
    stderr.write("output_unwritable: could not write every diagnostic receipt/summary.\n");
    return 2;
  }

  stdout.write(
    `Staging journey ledger: ${summary.counts.passed} passed, ` +
      `${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ` +
      `${summary.counts.total} total (verdict: ${summary.verdict}).\n`,
  );
  for (const diagnostic of summary.diagnostics) {
    stdout.write(
      ` - ${diagnostic.code} (${diagnostic.count}; retryable: ${diagnostic.retryable}): ${diagnostic.next_action}\n`,
    );
  }
  for (const journey of summary.journeys) {
    stdout.write(
      ` - [${journey.status}] ${journey.name}${journey.reason ? ` — ${journey.reason}` : ""}\n`,
    );
  }
  if (inputError === "report_unreadable") {
    // Preserve the existing loud-skip prefix, but never publish the input path.
    stderr.write(
      "LOUD ALL-SKIPPED: no readable Playwright JSON report; see the diagnostic receipts.\n",
    );
  }
  if (summary.diagnostics.some((entry) => entry.code !== "runner_error")) return 2;
  if (summary.verdict === "empty" || summary.verdict === "all-skipped") {
    stderr.write(
      `LOUD ALL-SKIPPED: ${summary.counts.skipped} of ${summary.counts.total} staging ` +
        "journeys skipped with 0 passed — failing the run instead of a quiet green. See the diagnostic receipts.\n",
    );
    return 2;
  }
  if (summary.verdict === "fail") {
    stderr.write(
      `Staging journeys failed: ${summary.counts.failed} of ${summary.counts.total}; ` +
        "runner diagnostics may also fail the run. See the diagnostic receipts.\n",
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(HELP);
  } else {
    const flags = {
      "--report": "reportPath",
      "--out-json": "ledgerJsonPath",
      "--out-md": "ledgerMdPath",
    };
    const options = {};
    let valid = true;
    for (let index = 0; index < args.length; index += 2) {
      const key = flags[args[index]];
      const value = args[index + 1];
      if (!key || !value || value.startsWith("--") || Object.hasOwn(options, key)) {
        valid = false;
        break;
      }
      options[key] = value;
    }
    if (valid) process.exitCode = runGate(options);
    else {
      process.stderr.write(
        "invalid_arguments: use --help for the fixture-only receipt contract.\n",
      );
      process.exitCode = 2;
    }
  }
}
