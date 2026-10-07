// Gate the staging browser run on its journey ledger.
//
// Reads the Playwright JSON report written by `playwright.staging.config.ts`,
// records per-journey pass/skip/fail accounting as JSON + Markdown, prints the
// ledger to the log, and fails loud when nothing passed: an all-skipped (or
// empty) run exits non-zero with every skipped journey and its reason named,
// so it can never report a quiet green. Runs only on the runner against
// report files; it never touches staging or any secret.
//
// Exit codes: 0 pass, 1 journeys failed, 2 all-skipped or empty report.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatLedgerMarkdown, summarizeJourneys } from "../e2e/staging/journey-ledger.mjs";

export const REPORT_DEFAULT = "test-results/staging-journeys.json";
export const LEDGER_JSON_DEFAULT = "test-results/staging-journey-ledger.json";
export const LEDGER_MD_DEFAULT = "test-results/staging-journey-ledger.md";

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

export function runGate({
  reportPath = REPORT_DEFAULT,
  ledgerJsonPath = LEDGER_JSON_DEFAULT,
  ledgerMdPath = LEDGER_MD_DEFAULT,
  stepSummaryPath = process.env.GITHUB_STEP_SUMMARY,
  stdout = process.stdout,
  stderr = process.stderr,
} = {}) {
  let report;
  try {
    report = JSON.parse(readFileSync(resolve(reportPath), "utf8"));
  } catch {
    const message =
      `LOUD ALL-SKIPPED: no readable Playwright JSON report at ${reportPath}. ` +
      `The staging run recorded no journey accounting, so it FAILS instead of ` +
      `reporting a quiet green.`;
    stderr.write(`${message}\n`);
    return 2;
  }

  const summary = summarizeJourneys(report);
  const ledgerJson = `${JSON.stringify(summary, null, 2)}\n`;
  const ledgerMd = formatLedgerMarkdown(summary);
  mkdirSync(dirname(resolve(ledgerJsonPath)), { recursive: true });
  writeFileSync(resolve(ledgerJsonPath), ledgerJson);
  writeFileSync(resolve(ledgerMdPath), `${ledgerMd}\n`);

  stdout.write(
    `Staging journey ledger: ${summary.counts.passed} passed, ` +
      `${summary.counts.failed} failed, ${summary.counts.skipped} skipped, ` +
      `${summary.counts.total} total (verdict: ${summary.verdict}).\n`,
  );
  for (const journey of summary.journeys) {
    stdout.write(
      ` - [${journey.status}] ${journey.name}${journey.reason ? ` — ${journey.reason}` : ""}\n`,
    );
  }
  if (stepSummaryPath) {
    appendFileSync(resolve(stepSummaryPath), `\n${ledgerMd}\n`);
  }

  if (summary.verdict === "empty" || summary.verdict === "all-skipped") {
    stderr.write(
      `LOUD ALL-SKIPPED: ${summary.counts.skipped} of ${summary.counts.total} staging ` +
        `journeys skipped with 0 passed — failing the run instead of a quiet green. ` +
        `See ${ledgerJsonPath} and ${ledgerMdPath}.\n`,
    );
    return 2;
  }
  if (summary.verdict === "fail") {
    stderr.write(
      `Staging journeys failed: ${summary.counts.failed} of ${summary.counts.total} — ` +
        `see ${ledgerJsonPath} and ${ledgerMdPath}.\n`,
    );
    return 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.exitCode = runGate({
    reportPath: argValue(args, "--report") ?? REPORT_DEFAULT,
    ledgerJsonPath: argValue(args, "--out-json") ?? LEDGER_JSON_DEFAULT,
    ledgerMdPath: argValue(args, "--out-md") ?? LEDGER_MD_DEFAULT,
  });
}
