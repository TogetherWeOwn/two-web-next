// Fails unless the auth-browser sign-in proof left real evidence behind:
// the evidence directory must exist and be non-empty, and result.json must
// exist, be non-empty, parse as JSON, carry the shared schema version,
// record exactly the six stable check IDs (no numeric placeholders,
// duplicates, missing or substituted entries), record zero unexpected
// requests, and list exactly the four screenshots the suite writes, each
// present and non-empty (the suite writes result.json last, so six checks
// prove it ran to completion). The ci.yml upload step additionally uses
// if-no-files-found: error, so an empty directory fails there too; this
// assertion names the missing evidence instead of failing on the upload.
//
// Every failure throws a machine-readable Error: a stable code, the fixture
// suite to rerun in the message and nextAction, and the missing/offending
// IDs for check-set failures. The validator is read-only and idempotent.
//
// Usage: node ci/require-auth-browser-evidence.mjs [artifacts/auth-browser]
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { AUTH_BROWSER_CHECK_IDS, AUTH_EVIDENCE_SCHEMA_VERSION } from "./auth-evidence-schema.mjs";

export const EVIDENCE_RESULT = "result.json";
export const EXPECTED_CHECKS = AUTH_BROWSER_CHECK_IDS.length;
export const EXPECTED_SCREENSHOTS = [
  "auth-success.png",
  "auth-replay.png",
  "join-success.png",
  "join-replay.png",
];

const SUITE = "test:auth-signin-browser";

function fail(code, detail, extra) {
  const error = new Error(
    `${detail} Rerun \`npm run ${SUITE}\` to regenerate the receipt; do not hand-edit ${EVIDENCE_RESULT}.`,
  );
  error.code = code;
  error.nextAction = `rerun npm run ${SUITE}`;
  if (extra) Object.assign(error, extra);
  throw error;
}

function evidenceStat(path) {
  try {
    return statSync(path);
  } catch (error) {
    // Only a missing path means "the suite wrote nothing". Any other stat
    // failure (EACCES, ELOOP, ...) must surface as unreadable at the call
    // site so the validator never misreports a permission error as missing.
    if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return null;
    throw error;
  }
}

export function checkAuthBrowserEvidence(dir = "artifacts/auth-browser") {
  let dirStat;
  try {
    dirStat = evidenceStat(dir);
  } catch {
    fail("AUTH_BROWSER_DIR_UNREADABLE", `${dir}: auth-browser evidence directory is unreadable`);
  }
  if (!dirStat?.isDirectory())
    fail(
      "AUTH_BROWSER_NO_EVIDENCE_DIR",
      `${dir}: no auth-browser evidence directory (the suite wrote nothing)`,
    );
  let files;
  try {
    files = readdirSync(dir).sort();
  } catch {
    fail("AUTH_BROWSER_DIR_UNREADABLE", `${dir}: auth-browser evidence directory is unreadable`);
  }
  if (files.length === 0)
    fail(
      "AUTH_BROWSER_EMPTY_DIR",
      `${dir}: auth-browser evidence directory is empty (the suite wrote nothing)`,
    );
  const resultPath = join(dir, EVIDENCE_RESULT);
  let raw = "";
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch {
    fail(
      "AUTH_BROWSER_RESULT_MISSING",
      `${dir}: ${EVIDENCE_RESULT} is missing (found: ${files.join(", ")})`,
    );
  }
  if (raw.trim().length === 0)
    fail("AUTH_BROWSER_RESULT_EMPTY", `${dir}: ${EVIDENCE_RESULT} is empty`);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    fail("AUTH_BROWSER_RESULT_INVALID_JSON", `${dir}: ${EVIDENCE_RESULT} is not valid JSON`);
  }
  const checks = report?.checks;
  const missing = AUTH_BROWSER_CHECK_IDS.filter(
    (id) => !Array.isArray(checks) || !checks.includes(id),
  );
  const offending = Array.isArray(checks)
    ? checks.filter((entry) => !AUTH_BROWSER_CHECK_IDS.includes(entry))
    : [];
  if (
    !Array.isArray(checks) ||
    checks.length !== EXPECTED_CHECKS ||
    missing.length > 0 ||
    offending.length > 0
  )
    fail(
      "AUTH_BROWSER_CHECKS_INCOMPLETE",
      `${dir}: ${EVIDENCE_RESULT} records ${JSON.stringify(checks?.length)} checks instead of ${EXPECTED_CHECKS} (missing: ${JSON.stringify(missing)}; offending: ${JSON.stringify(offending)})`,
      { missing, offending },
    );
  if (report?.schemaVersion !== AUTH_EVIDENCE_SCHEMA_VERSION)
    fail(
      "AUTH_BROWSER_SCHEMA_VERSION_MISMATCH",
      `${dir}: ${EVIDENCE_RESULT} records schemaVersion ${JSON.stringify(report?.schemaVersion)} instead of ${AUTH_EVIDENCE_SCHEMA_VERSION}`,
    );
  if (report?.unexpectedRequests !== 0)
    fail(
      "AUTH_BROWSER_UNEXPECTED_REQUESTS",
      `${dir}: ${EVIDENCE_RESULT} records ${JSON.stringify(report?.unexpectedRequests)} unexpected requests instead of 0`,
    );
  if (
    !Array.isArray(report?.screenshots) ||
    report.screenshots.length !== EXPECTED_SCREENSHOTS.length ||
    new Set(report.screenshots).size !== EXPECTED_SCREENSHOTS.length ||
    report.screenshots.some((shot) => !EXPECTED_SCREENSHOTS.includes(shot))
  )
    fail(
      "AUTH_BROWSER_SCREENSHOTS_INCOMPLETE",
      `${dir}: ${EVIDENCE_RESULT} must list all four screenshots`,
    );
  for (const shot of report.screenshots) {
    const shotPath = join(dir, shot);
    let stat;
    try {
      stat = evidenceStat(shotPath);
    } catch {
      fail("AUTH_BROWSER_SCREENSHOT_FILE_MISSING", `${dir}: screenshot ${shot} is unreadable`);
    }
    if (!stat?.isFile() || stat.size === 0)
      fail(
        "AUTH_BROWSER_SCREENSHOT_FILE_MISSING",
        `${dir}: screenshot ${shot} is missing or empty`,
      );
  }
  return `${dir}: auth-browser evidence present (${files.length} files, ${EXPECTED_CHECKS} checks, 0 unexpected requests)`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir] = process.argv.slice(2);
  try {
    const line = checkAuthBrowserEvidence(dir);
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
