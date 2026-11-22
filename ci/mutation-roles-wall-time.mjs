// DB-free PR gate for R4–R7 and W1–W3. Only changes to their source or test
// files select mutants, and survivors already present on the target pass.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { MUTANTS, runMutant, verdictFor } from "./mutation-sessions-join.mjs";

const TEST_FOR_TARGET = {
  "src/roles.ts": "test/moderator-malformed-success.test.ts",
  "src/admin/validation-wall-time.ts": "test/event-time-validation.test.ts",
};
export const FOCUSED_SUITE = Object.values(TEST_FOR_TARGET);
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
const TARGETS = Object.keys(TEST_FOR_TARGET);
const SCOPE = [...TARGETS, ...FOCUSED_SUITE];
const isSha = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const hash = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const errorText = (error) => (error instanceof Error ? error.message : String(error));
const git = (root, ...args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });

// Vitest also exits 1 on load/config errors. Only complete assertion
// results count as green/red; absent, skipped or errored suites are infrastructure.
export function classifyRun(child, json, root, suiteFiles = FOCUSED_SUITE) {
  const verdict = verdictFor(child);
  if (verdict === "error" || !json || !Array.isArray(json.testResults)) return "error";
  const expected = suiteFiles.map((file) => join(root, file)).sort();
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

function killSuite(root, reportDir, label, suite) {
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
      ...suite,
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
  return { verdict: classifyRun(child, json, root, suite), output };
}

function save(reportDir, report) {
  const killed = report.results.filter((r) => r.status === "killed").length;
  const survivors = report.results.filter((r) => r.status === "survived");
  const infra = report.infrastructureErrors;
  const markdown = [
    "# Focused mutation gate",
    "",
    `- Tested revision: ${report.head}`,
    `- Target: ${report.base ?? "unavailable"}`,
    `- Started: ${report.startedAt}`,
    `- Baseline: ${report.baseline.verdict}`,
    `- Suite: ${report.suite.join(", ") || "none"}`,
    `- Killed: ${killed}/${report.mutants.length}; completed: ${report.results.length}/${report.mutants.length}`,
    `- Survivors: ${survivors.length}; new: ${newSurvivors(report).length}`,
    `- Infrastructure failures: ${infra.length}`,
    "",
    "| Mutant | Head verdict | Target verdict | Before SHA-256 | After SHA-256 |",
    "| --- | --- | --- | --- | --- |",
    ...report.results.map(
      (r) =>
        `| ${r.id} | ${r.status} | ${r.baseStatus ?? "—"} | ${r.beforeHash ?? "unavailable"} | ${r.afterHash ?? "unavailable"} |`,
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

function newSurvivors(report) {
  return report.results.filter((r) => ["killed", "stale", "absent"].includes(r.baseStatus));
}

function compareSurvivors(root, report, execute) {
  const survivors = report.results.filter((r) => r.status === "survived");
  if (!survivors.length) return;
  const scratch = mkdtempSync(join(tmpdir(), "focused-mutation-base-"));
  const baseRoot = join(scratch, "worktree");
  try {
    git(root, "worktree", "add", "--detach", baseRoot, report.base);
    // Hold the installed dependencies constant while comparing tracked inputs.
    symlinkSync(join(root, "node_modules"), join(baseRoot, "node_modules"), "dir");
    const suite = report.suite.filter((path) => existsSync(join(baseRoot, path)));
    if (suite.length) report.baseBaseline = execute(suite, baseRoot, "base-baseline");
    if (suite.length && report.baseBaseline.verdict !== "green")
      throw new Error(`unmutated target is ${report.baseBaseline.verdict}`);
    for (const row of survivors) {
      const mutant = FOCUSED_MUTANTS.find((m) => m.id === row.id);
      if (
        !suite.includes(TEST_FOR_TARGET[mutant.file]) ||
        !existsSync(join(baseRoot, mutant.file))
      ) {
        row.baseStatus = "absent";
        continue;
      }
      const killAtTarget = () => execute(suite, baseRoot, `base-${mutant.id}`);
      const result = runMutant(baseRoot, mutant, killAtTarget, suite);
      row.baseStatus = result.status;
      if (result.status === "error" || result.status === "ambiguous")
        throw new Error(`target ${mutant.id}: ${result.detail}`);
    }
  } finally {
    if (existsSync(join(baseRoot, ".git"))) git(root, "worktree", "remove", "--force", baseRoot);
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function runFocused(root, target, { kill } = {}) {
  const reportDir = join(root, "artifacts/mutation-roles-wall-time");
  mkdirSync(reportDir, { recursive: true });
  const report = {
    mode: "HARD",
    head: "unknown",
    base: null,
    startedAt: new Date().toISOString(),
    suite: [],
    mutants: [],
    baseline: { verdict: "not_run" },
    baseBaseline: { verdict: "not_run" },
    results: [],
    infrastructureErrors: [],
  };
  save(reportDir, report);
  let label = "baseline";
  const execute = (suite, checkout = root, runLabel = label) =>
    kill ? kill(suite, runLabel) : killSuite(checkout, reportDir, runLabel, suite);
  try {
    if (!isSha(target)) throw new Error("expected a full target commit SHA");
    if (!FOCUSED_MUTANTS.every((m) => m && TARGETS.includes(m.file)))
      throw new Error("focused mutant inventory drifted");
    report.head = git(root, "rev-parse", "HEAD").trim();
    git(root, "merge-base", "--is-ancestor", target, report.head);
    report.base = target;
    const range = `${target}..${report.head}`;
    const diff = git(root, "diff", "--name-only", "--no-renames", "-z", range, "--", ...SCOPE);
    const changed = new Set(diff.split("\0"));
    const selected = FOCUSED_MUTANTS.filter(
      ({ file }) => changed.has(file) || changed.has(TEST_FOR_TARGET[file]),
    );
    report.mutants = selected.map(({ id }) => id);
    report.suite = [...new Set(selected.map(({ file }) => TEST_FOR_TARGET[file]))];
    if (selected.length) {
      const inputs = [...new Set(selected.map(({ file }) => file)), ...report.suite];
      const missing = [...inputs, "node_modules/.bin/vitest"].filter(
        (file) => !existsSync(join(root, file)),
      );
      if (missing.length) throw new Error(`missing runner inputs: ${missing.join(", ")}`);
      const dirty = git(root, "status", "--porcelain", "--", ...inputs).trim();
      if (dirty) throw new Error(`refusing dirty mutation inputs: ${dirty}`);
      report.baseline = execute(report.suite);
      if (report.baseline.verdict !== "green")
        throw new Error(`unmutated baseline is ${report.baseline.verdict}`);
    }
    save(reportDir, report);
    for (const mutant of selected) {
      label = mutant.id;
      const path = join(root, mutant.file);
      const beforeHash = hash(path);
      let result;
      try {
        result = runMutant(root, mutant, execute, report.suite);
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
    if (!report.infrastructureErrors.length) compareSurvivors(root, report, execute);
  } catch (error) {
    report.infrastructureErrors.push(errorText(error));
  }
  save(reportDir, report);
  const survivors = newSurvivors(report);
  console.log(
    `focused mutation: ${report.mutants.length} selected; ${survivors.length} new survivors; ${report.infrastructureErrors.length} infrastructure failures`,
  );
  console.log(`report: ${reportDir}/report.{json,md}`);
  return survivors.length || report.infrastructureErrors.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3 || !isSha(process.argv[2])) {
    console.error("Usage: node ci/mutation-roles-wall-time.mjs <target-sha>");
    process.exitCode = 2;
  } else if (process.env.GITHUB_ACTIONS !== "true") {
    console.error("Run the focused mutation gate in GitHub Actions.");
    process.exitCode = 2;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    process.exitCode = runFocused(root, process.argv[2]);
  }
}
