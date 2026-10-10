// Fails unless a Vitest JSON report shows a named suite really ran: at least
// `min` cases, every one passed. An opt-in `skipIf`, a failing `beforeAll`
// (vitest then reports every case skipped) or a dropped case would otherwise
// leave a green run that executed nothing.
//
// Usage: node ci/a11y-require-executed.mjs <report.json> <suite title> <min>
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function executedSummary(report, suite) {
  const cases = (report.testResults ?? [])
    .flatMap((file) => file.assertionResults ?? [])
    .filter((entry) => (entry.ancestorTitles ?? []).includes(suite));
  const count = (status) => cases.filter((entry) => entry.status === status).length;
  return { total: cases.length, passed: count("passed") };
}

export function checkExecuted(report, suite, min) {
  const { total, passed } = executedSummary(report, suite);
  if (!Number.isInteger(min) || min < 1)
    throw new Error(`Minimum case count must be a positive integer: ${min}`);
  if (passed !== total) {
    throw new Error(
      `${suite}: ${total - passed} of ${total} cases did not pass (skipped, failed or todo)`,
    );
  }
  if (passed < min) throw new Error(`${suite}: ${passed} cases executed, expected at least ${min}`);
  return `${suite}: ${passed} cases executed and passed, 0 skipped (minimum ${min})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, suite, min] = process.argv.slice(2);
  try {
    const line = checkExecuted(JSON.parse(readFileSync(file, "utf8")), suite, Number(min));
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
