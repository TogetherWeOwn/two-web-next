// WARN-first, DB-free subset of the nightly signal. No configurable inventory:
// exactly R4–R7 + W1–W3, sharing nightly anchors and targeted/hash-verified restore.
// Exit 0: completed report (survivors are coverage gaps); 1: infrastructure error.
// CI keeps both outcomes advisory and preserves JSON, Markdown and Vitest reports.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTANTS, runMutant, verdictFor } from "./mutation-sessions-join.mjs";

export const FOCUSED_SUITE = [
  "test/moderator-malformed-success.test.ts",
  "test/event-time-validation.test.ts",
];
const IDS = [
  "R4-blank-allowlist-admits",
  "R5-fetch-failure-admits",
  "R6-lookup-failure-admits",
  "R7-any-role-admits",
  "W1-fold-later-resolves-earlier",
  "W2-gap-time-admitted",
  "W3-unknown-timezone-admitted",
];
export const FOCUSED_MUTANTS = IDS.map((id) => MUTANTS.find((m) => m.id === id));
const TARGETS = ["src/roles.ts", "src/admin/validation-wall-time.ts"];
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const errorText = (error) => (error instanceof Error ? error.message : String(error));

// Vitest also exits 1 on load/config errors. Only complete two-file assertion
// results count as green/red; absent, skipped or errored suites are infrastructure.
export function classifyRun(child, json, root) {
  const verdict = verdictFor(child);
  if (verdict === "error" || !json || !Array.isArray(json.testResults)) return "error";
  const expected = FOCUSED_SUITE.map((file) => join(root, file)).sort();
  const actual = json.testResults.map((suite) => suite.name).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual)) return "error";
  if (json.numPendingTests !== 0 || json.numTodoTests !== 0 || json.numUnhandledErrors > 0)
    return "error";
  const assertions = json.testResults.flatMap((suite) => suite.assertionResults || []);
  if (json.testResults.some((suite) => !suite.assertionResults?.length || suite.message))
    return "error";
  if (assertions.some((a) => a.status !== "passed" && a.status !== "failed")) return "error";
  const failed = assertions.filter((a) => a.status === "failed").length;
  const passed = assertions.length - failed;
  if (
    json.numTotalTests !== assertions.length ||
    json.numFailedTests !== failed ||
    json.numPassedTests !== passed
  )
    return "error";
  if (verdict === "green" && json.success === true && failed === 0) return "green";
  if (verdict === "red" && json.success === false && failed > 0) return "red";
  return "error";
}

function killSuite(root, reportDir, label) {
  const path = join(reportDir, `${label}.vitest.json`);
  rmSync(path, { force: true });
  const env = { ...process.env };
  for (const name of [
    "DATABASE_URL",
    "AUDIT_IMPORT_TEST_DATABASE_URL",
    "LEGACY_DATABASE_URL",
    "BOT_DATABASE_URL",
  ])
    delete env[name];
  const child = spawnSync(
    process.execPath,
    [
      join(root, "node_modules/.bin/vitest"),
      "run",
      ...FOCUSED_SUITE,
      "--reporter=json",
      `--outputFile=${path}`,
    ],
    { cwd: root, env, encoding: "utf8", timeout: 20_000, maxBuffer: 2 * 1024 * 1024 },
  );
  const output = [child.stdout, child.stderr, child.error?.message]
    .filter(Boolean)
    .join("\n")
    .slice(-8000);
  writeFileSync(join(reportDir, `${label}.log`), output);
  let json;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    json = null;
  }
  return { verdict: classifyRun(child, json, root), output };
}

function save(reportDir, report) {
  const killed = report.results.filter((r) => r.status === "killed").length;
  const survivors = report.results.filter((r) => r.status === "survived");
  const infra = report.infrastructureErrors;
  const markdown = [
    "# Focused mutation signal (WARN-only)",
    "",
    `- Head: ${report.head}`,
    `- Started: ${report.startedAt}`,
    `- Baseline: ${report.baseline.verdict}`,
    `- Suite: ${FOCUSED_SUITE.join(", ")} (DB-free)`,
    `- Killed: ${killed}/${IDS.length}; completed: ${report.results.length}/${IDS.length}`,
    `- Survivors (coverage gaps): ${survivors.length}`,
    `- Infrastructure failures: ${infra.length}`,
    "",
    "| Mutant | Status | Before SHA-256 | After SHA-256 |",
    "| --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| ${r.id} | ${r.status} | ${r.beforeHash ?? "unavailable"} | ${r.afterHash ?? "unavailable"} |`,
    ),
    "",
    "## Coverage gaps",
    "",
    ...survivors.map((r) => `- ${r.id}: suite passed with the check weakened.`),
    "",
    "## Infrastructure errors (not kills or survivors)",
    "",
    ...infra.map((detail) => `- ${detail}`),
    "",
  ].join("\n");
  writeFileSync(join(reportDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
  writeFileSync(join(reportDir, "report.md"), markdown);
}

export function runFocused(root, { kill, argumentError } = {}) {
  const reportDir = join(root, "artifacts/mutation-roles-wall-time");
  mkdirSync(reportDir, { recursive: true });
  const report = {
    mode: "WARN",
    head: "unknown",
    startedAt: new Date().toISOString(),
    suite: FOCUSED_SUITE,
    mutants: IDS,
    baseline: { verdict: "not_run" },
    results: [],
    infrastructureErrors: [],
  };
  let label = "baseline";
  const execute = kill || (() => killSuite(root, reportDir, label));
  save(reportDir, report);
  try {
    if (argumentError) throw new Error(argumentError);
    if (!FOCUSED_MUTANTS.every((m) => m && TARGETS.includes(m.file)))
      throw new Error("focused mutant inventory drifted");
    const missing = [...TARGETS, ...FOCUSED_SUITE, "node_modules/.bin/vitest"].filter(
      (file) => !existsSync(join(root, file)),
    );
    if (missing.length) throw new Error(`missing runner inputs: ${missing.join(", ")}`);
    const dirty = execFileSync("git", ["status", "--porcelain", "--", ...TARGETS], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    if (dirty) throw new Error(`refusing dirty mutation targets: ${dirty}`);
    report.head = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
    report.baseline = execute(FOCUSED_SUITE);
    if (report.baseline.verdict !== "green")
      throw new Error(`unmutated baseline is ${report.baseline.verdict}`);
    save(reportDir, report);
    for (const mutant of FOCUSED_MUTANTS) {
      label = mutant.id;
      const path = join(root, mutant.file);
      const beforeHash = hash(path);
      let result;
      try {
        result = runMutant(root, mutant, execute, FOCUSED_SUITE);
      } catch (error) {
        result = { id: mutant.id, status: "error", detail: errorText(error) };
      }
      let afterHash = null;
      try {
        afterHash = hash(path);
      } catch (error) {
        result = { ...result, status: "error", detail: `restore unreadable: ${errorText(error)}` };
      }
      result = { ...result, beforeHash, afterHash };
      report.results.push(result);
      if (beforeHash !== afterHash) {
        result.status = "error";
        throw new Error(`${mutant.id}: restore hash mismatch; refusing further mutations`);
      }
      if (result.status !== "killed" && result.status !== "survived")
        report.infrastructureErrors.push(`${mutant.id}: ${result.detail}`);
      save(reportDir, report);
    }
  } catch (error) {
    report.infrastructureErrors.push(errorText(error));
  }
  save(reportDir, report);
  const survivors = report.results.filter((r) => r.status === "survived").length;
  console.log(
    `focused mutation WARN: ${survivors} survivors; ${report.infrastructureErrors.length} infrastructure failures`,
  );
  console.log(`report: ${reportDir}/report.{json,md}`);
  return report.infrastructureErrors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  process.exitCode = runFocused(root, {
    argumentError:
      process.argv.length > 2 ? "Usage: node ci/mutation-roles-wall-time.mjs (no options)" : null,
  });
}
