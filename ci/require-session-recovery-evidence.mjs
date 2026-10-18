// Fails unless the session-recovery browser run left real evidence behind:
// the evidence directory must exist and be non-empty, and result.json must
// exist, be non-empty, parse as JSON and record result "PASS" (the suite
// writes result.json last, so PASS proves it ran to completion). The ci.yml
// upload step additionally uses if-no-files-found: error, so an empty
// directory fails there too; this assertion names the missing evidence
// instead of failing on the upload.
//
// Usage: node ci/require-session-recovery-evidence.mjs [artifacts/session-recovery]
import { appendFileSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const EVIDENCE_RESULT = "result.json";

export function checkSessionRecoveryEvidence(dir = "artifacts/session-recovery") {
  if (!existsSync(dir) || !statSync(dir).isDirectory())
    throw new Error(`${dir}: no session-recovery evidence directory (the suite wrote nothing)`);
  const files = readdirSync(dir).sort();
  if (files.length === 0)
    throw new Error(
      `${dir}: session-recovery evidence directory is empty (the suite wrote nothing)`,
    );
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
  if (report?.result !== "PASS")
    throw new Error(
      `${dir}: ${EVIDENCE_RESULT} records result ${JSON.stringify(report?.result)} instead of "PASS"`,
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
