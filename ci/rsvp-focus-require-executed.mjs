// Fails unless a node --test TAP report shows the RSVP Chromium suite really
// ran: at least `min` cases passed, with zero failures, cancellations, skips
// or todos. A missing opt-in (`RSVP_FOCUS_BROWSER_TESTS !== "true"`) skips the
// whole describe, which exits 0 with `pass 0` — without this verifier that
// empty run would read as green.
//
// Usage: node ci/rsvp-focus-require-executed.mjs <report.tap> <suite title> <min>
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function parseTapSummary(tap) {
  const get = (key) => {
    const match = tap.match(new RegExp(`^# ${key} (\\d+)`, "m"));
    return match ? Number(match[1]) : null;
  };
  return {
    tests: get("tests"),
    pass: get("pass"),
    fail: get("fail"),
    cancelled: get("cancelled"),
    skipped: get("skipped"),
    todo: get("todo"),
  };
}

export function checkExecuted(tap, suite, min) {
  if (!Number.isInteger(min) || min < 1)
    throw new Error(`Minimum case count must be a positive integer: ${min}`);
  const summary = parseTapSummary(tap);
  if (
    summary.tests === null ||
    summary.pass === null ||
    summary.fail === null ||
    summary.cancelled === null ||
    summary.skipped === null ||
    summary.todo === null
  )
    throw new Error(
      `${suite}: missing node --test TAP summary (expected # tests/pass/fail/cancelled/skipped/todo)`,
    );
  const notPassed = summary.tests - summary.pass;
  if (summary.fail > 0 || summary.cancelled > 0 || notPassed !== 0) {
    throw new Error(
      `${suite}: ${notPassed} of ${summary.tests} cases did not pass (fail ${summary.fail}, cancelled ${summary.cancelled}, skipped ${summary.skipped}, todo ${summary.todo})`,
    );
  }
  if (summary.pass < min)
    throw new Error(`${suite}: ${summary.pass} cases executed, expected at least ${min}`);
  return `${suite}: ${summary.pass} cases executed and passed, 0 skipped (minimum ${min})`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [file, suite, min] = process.argv.slice(2);
  try {
    const line = checkExecuted(readFileSync(file, "utf8"), suite, Number(min));
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
