// Fails unless the auth-browser sign-in proof left real evidence behind:
// the evidence directory must exist and be non-empty, and result.json must
// exist, be non-empty, parse as JSON, record all six checks and zero
// unexpected requests, with every listed screenshot present and non-empty
// (the suite writes result.json last, so six checks prove it ran to
// completion). The ci.yml upload step additionally uses if-no-files-found:
// error, so an empty directory fails there too; this assertion names the
// missing evidence instead of failing on the upload.
//
// Usage: node ci/require-auth-browser-evidence.mjs [artifacts/auth-browser]
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const EVIDENCE_RESULT = "result.json";
export const EXPECTED_CHECKS = 6;

export function checkAuthBrowserEvidence(dir = "artifacts/auth-browser") {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`${dir}: no auth-browser evidence directory (the suite wrote nothing)`);
  const files = readdirSync(dir).sort();
  if (files.length === 0)
    throw new Error(`${dir}: auth-browser evidence directory is empty (the suite wrote nothing)`);
  const resultPath = join(dir, EVIDENCE_RESULT);
  let raw = "";
  try {
    raw = readFileSync(resultPath, "utf8");
  } catch {
    throw new Error(`${dir}: ${EVIDENCE_RESULT} is missing (found: ${files.join(", ")})`);
  }
  if (raw.trim().length === 0) throw new Error(`${dir}: ${EVIDENCE_RESULT} is empty`);
  let report;
  try {
    report = JSON.parse(raw);
  } catch {
    throw new Error(`${dir}: ${EVIDENCE_RESULT} is not valid JSON`);
  }
  if (!Array.isArray(report?.checks) || report.checks.length !== EXPECTED_CHECKS)
    throw new Error(
      `${dir}: ${EVIDENCE_RESULT} records ${JSON.stringify(report?.checks?.length)} checks instead of ${EXPECTED_CHECKS}`,
    );
  if (report?.unexpectedRequests !== 0)
    throw new Error(
      `${dir}: ${EVIDENCE_RESULT} records ${JSON.stringify(report?.unexpectedRequests)} unexpected requests instead of 0`,
    );
  for (const shot of report?.screenshots ?? []) {
    const shotPath = join(dir, shot);
    if (!existsSync(shotPath) || statSync(shotPath).size === 0)
      throw new Error(`${dir}: screenshot ${shot} is missing or empty`);
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
