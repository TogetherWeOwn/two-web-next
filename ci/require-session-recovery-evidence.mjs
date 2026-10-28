// Fails unless the session-recovery browser run left real evidence behind:
// the evidence directory must exist and be non-empty, and result.json must
// exist, be non-empty, parse as JSON, record result "PASS", carry the shared
// schema version, record exactly the ten stable check IDs (no numeric
// placeholders, duplicates, missing or substituted entries), and record a
// numeric unauthorizedWrites of 0 (the suite writes result.json last, so
// PASS proves it ran to completion). The ci.yml upload step additionally
// uses if-no-files-found: error, so an empty directory fails there too; this
// assertion names the missing evidence instead of failing on the upload.
//
// Every failure throws a machine-readable Error: a stable code, the fixture
// suite to rerun in the message and nextAction, and the missing/offending
// IDs for check-set failures. The validator is read-only and idempotent.
//
// Usage: node ci/require-session-recovery-evidence.mjs [artifacts/session-recovery]
import { appendFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AUTH_EVIDENCE_SCHEMA_VERSION,
  SESSION_RECOVERY_CHECK_IDS,
} from "./auth-evidence-schema.mjs";

export const EVIDENCE_RESULT = "result.json";
export const EXPECTED_CHECKS = SESSION_RECOVERY_CHECK_IDS.length;

const SUITE = "test:auth-browser";

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

export function checkSessionRecoveryEvidence(dir = "artifacts/session-recovery") {
  let dirStat;
  try {
    dirStat = evidenceStat(dir);
  } catch {
    fail(
      "SESSION_RECOVERY_DIR_UNREADABLE",
      `${dir}: session-recovery evidence directory is unreadable`,
    );
  }
  if (!dirStat?.isDirectory())
    fail(
      "SESSION_RECOVERY_NO_EVIDENCE_DIR",
      `${dir}: no session-recovery evidence directory (the suite wrote nothing)`,
    );
  let files;
  try {
    files = readdirSync(dir).sort();
  } catch {
    fail(
      "SESSION_RECOVERY_DIR_UNREADABLE",
      `${dir}: session-recovery evidence directory is unreadable`,
    );
  }
  if (files.length === 0)
    fail(
      "SESSION_RECOVERY_EMPTY_DIR",
      `${dir}: session-recovery evidence directory is empty (the suite wrote nothing)`,
    );
  const resultPath = join(dir, EVIDENCE_RESULT);
  let raw = "";
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch {
    fail(
      "SESSION_RECOVERY_RESULT_MISSING",
      `${dir}: ${EVIDENCE_RESULT} is missing (found: ${files.join(", ")})`,
    );
  }
  if (raw.trim().length === 0)
    fail("SESSION_RECOVERY_RESULT_EMPTY", `${dir}: ${EVIDENCE_RESULT} is empty`);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    fail("SESSION_RECOVERY_RESULT_INVALID_JSON", `${dir}: ${EVIDENCE_RESULT} is not valid JSON`);
  }
  if (report?.result !== "PASS")
    fail(
      "SESSION_RECOVERY_RESULT_NOT_PASS",
      `${dir}: ${EVIDENCE_RESULT} records result ${JSON.stringify(report?.result)} instead of "PASS"`,
    );
  const checks = report?.checks;
  const missing = SESSION_RECOVERY_CHECK_IDS.filter(
    (id) => !Array.isArray(checks) || !checks.includes(id),
  );
  const offending = Array.isArray(checks)
    ? checks.filter((entry) => !SESSION_RECOVERY_CHECK_IDS.includes(entry))
    : [];
  if (
    !Array.isArray(checks) ||
    checks.length !== EXPECTED_CHECKS ||
    missing.length > 0 ||
    offending.length > 0
  )
    fail(
      "SESSION_RECOVERY_CHECKS_INCOMPLETE",
      `${dir}: ${EVIDENCE_RESULT} records ${JSON.stringify(checks?.length)} checks instead of ${EXPECTED_CHECKS} (missing: ${JSON.stringify(missing)}; offending: ${JSON.stringify(offending)})`,
      { missing, offending },
    );
  if (report?.schemaVersion !== AUTH_EVIDENCE_SCHEMA_VERSION)
    fail(
      "SESSION_RECOVERY_SCHEMA_VERSION_MISMATCH",
      `${dir}: ${EVIDENCE_RESULT} records schemaVersion ${JSON.stringify(report?.schemaVersion)} instead of ${AUTH_EVIDENCE_SCHEMA_VERSION}`,
    );
  if (report?.unauthorizedWrites !== 0)
    fail(
      "SESSION_RECOVERY_UNAUTHORIZED_WRITES",
      `${dir}: ${EVIDENCE_RESULT} records unauthorizedWrites ${JSON.stringify(report?.unauthorizedWrites)} instead of 0`,
    );
  return `${dir}: session-recovery evidence present (${files.length} files, result PASS)`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [dir] = process.argv.slice(2);
  try {
    const line = checkSessionRecoveryEvidence(dir);
    console.log(line);
    if (process.env.GITHUB_STEP_SUMMARY)
      appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
  } catch (error) {
    console.error(`::error::${error.message}`);
    process.exit(1);
  }
}
