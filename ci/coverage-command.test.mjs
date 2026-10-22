import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const args = ["run", "--coverage", "--pool=threads"];

test("the required check keeps full coverage in isolated serial threads inside main's job budget", async () => {
  assert.equal(manifest.scripts["test:coverage"], `vitest ${args.join(" ")}`);
  assert.equal(manifest.scripts["pretest:coverage"], undefined);
  assert.equal(manifest.scripts["posttest:coverage"], undefined);
  // main owns the budget (raised 10 -> 20 -> 40 for shared-runner container setup);
  // isolated threads must fit inside it, never widen it.
  const budget = Number(check.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(budget > 0 && budget <= 40, `check timeout-minutes ${budget} exceeds main's 40`);
  const step = check.match(
    /      - name: Check \(lint \+ typecheck \+ coverage gate\)\n([\s\S]*?)(?=      - )/,
  );
  assert.equal(
    step?.[1].match(/^        run: (.+)$/m)?.[1],
    "npm run lint && npm run typecheck && npm run e2e:typecheck && npm run test:coverage && npm run e2e:safety && node --test ci/a11y-*.test.mjs ci/admin-properties-ci.test.mjs ci/coverage-command.test.mjs ci/kit-preview-e2e-wiring.test.mjs ci/visual-accept.test.mjs ci/tier0-changed-query-files.test.mjs",
  );
  // Only the docs-only/draft scope gate (TOG-11811/TOG-14880) may guard the step; nothing may bypass it.
  assert.doesNotMatch(step[1], /continue-on-error:/);
  const guards = step[1].match(/^        if:.*$/gm) ?? [];
  assert.equal(guards.length, 1);
  assert.ok(
    guards[0].includes("needs.scope.outputs.docs_only != 'true'") &&
      guards[0].includes("needs.scope.outputs.draft != 'true'"),
    `Step guard must stay scope-gated: ${guards[0]}`,
  );
  const config = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
  assert.match(
    config,
    /include: \["test\/\*\*\/\*\.test\.ts", "test\/\*\*\/\*\.test\.mjs", "ci\/audit-lifecycle\.test\.mjs"\]/,
  );
  assert.match(config, /fileParallelism: false/);
  assert.doesNotMatch(config, /\bisolate:\s*false/);
});

test("the coverage gate keeps area floors and summary scopes for the high-blast-radius areas", async () => {
  const config = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
  const summary = await readFile(new URL("./coverage-summary.mjs", import.meta.url), "utf8");
  for (const area of ["src/jobs", "src/bot", "src/agent-events", "src/profiles", "src/auth"]) {
    assert.match(
      config,
      new RegExp(
        `"${area}/\\*\\*": \\{ statements: [0-9.]+, branches: [0-9.]+, functions: [0-9.]+, lines: [0-9.]+ \\}`,
      ),
    );
    assert.ok(summary.includes(`"${area}/"`), `coverage summary must report ${area}/`);
  }
  assert.match(
    config,
    /"src\/kit-\*": \{ statements: [0-9.]+, branches: [0-9.]+, functions: [0-9.]+, lines: [0-9.]+ \}/,
  );
  assert.ok(summary.includes('"src/kit-*"'), "coverage summary must report src/kit-*");
  for (const file of [
    "src/invite.ts",
    "src/return-journey.ts",
    "src/write-recovery.tsx",
    "src/counts.ts",
    "src/seo.ts",
  ]) {
    assert.match(
      config,
      new RegExp(
        `"${file}": \\{ statements: [0-9.]+, branches: [0-9.]+, functions: [0-9.]+, lines: [0-9.]+ \\}`,
      ),
    );
    assert.ok(summary.includes(`"${file}"`), `coverage summary must report ${file}`);
  }
});

test("patch coverage fails closed when its coverage input is missing", async () => {
  const script = await readFile(new URL("./patch-coverage.mjs", import.meta.url), "utf8");
  // The old warn-and-skip branch let a broken test:coverage silence its own
  // downstream gate; a missing input must error the step instead.
  assert.doesNotMatch(script, /::warning::patch coverage skipped/);
  assert.match(script, /::error::patch coverage missing input/);
  assert.match(script, /if \(requireCoverageInput\(coveragePath\)\)/);
  // The --selftest pins requireCoverageInput behaviorally, so the gate cannot
  // be reverted without the selftest failing the same step.
  assert.match(script, /missing coverage input fails closed instead of warn\/skip/);
});

// Pin the CLI's fail-closed exit status behaviorally: copying the shipped
// script into a bare fixture leaves <fixture>/coverage/ absent, so running
// it must exit 1 with the ::error:: annotation. A source-text assertion
// alone would still pass if `process.exitCode = 1` were flipped to 0.
test("the patch coverage CLI exits 1 when its coverage input is missing", {
  timeout: 20000,
}, async (t) => {
  const fixture = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "patch-coverage-missing-"),
  );
  t.after(() => rm(fixture, { recursive: true, force: true }));
  // repoRoot is derived from the script location, so <fixture>/coverage/
  // does not exist and the missing-input branch runs.
  await mkdir(join(fixture, "ci"), { recursive: true });
  await copyFile(
    new URL("./patch-coverage.mjs", import.meta.url),
    join(fixture, "ci", "patch-coverage.mjs"),
  );
  const child = spawn(process.execPath, [join(fixture, "ci", "patch-coverage.mjs")], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr += data;
  });
  const [code, signal] = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve([code, signal]));
  });
  assert.equal(signal, null, stderr);
  assert.equal(code, 1, stderr);
  assert.match(stderr, /::error::patch coverage missing input/);
});

test("the patch coverage step has no file-presence skip so a missing input fails the job", async () => {
  const step = check
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Patch coverage (WARN)\n"));
  assert(step, "check must keep the patch coverage step");
  // A hashFiles presence check would skip the step on a missing report and
  // silence the gate; only the docs-only/draft scope guard may skip it.
  assert.doesNotMatch(step, /hashFiles\('coverage\/coverage-final\.json'\)/);
  assert.doesNotMatch(step, /continue-on-error:/);
  const guards = step.match(/^        if:.*$/gm) ?? [];
  assert.equal(guards.length, 1);
  assert.equal(
    guards[0],
    "        if: success() && (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true')",
  );
  assert.equal(
    step.match(/^        run: (.+)$/m)?.[1],
    "npm run patch:coverage:selftest && npm run patch:coverage",
  );
});

// Post-install gates must not add secondary noise (vitest not found, missing
// coverage report) after an earlier step already failed the job. These cases
// evaluate the real `if:` guards of the check job with a small GitHub Actions
// expression evaluator that supports only what the guards use and throws on
// anything else, so a new construct cannot silently pass.
const checkJob = check.split(/\n  [a-z][a-z0-9-]*:\n/)[1];
const checkSteps = checkJob
  .split(/\n      - /)
  .slice(1)
  .map((entry) => ({
    label: entry.match(/^name: (.+)$/m)?.[1] ?? entry.split("\n", 1)[0],
    guard: entry.match(/^        if: (.+)$/m)?.[1] ?? "success()",
  }));
const AUDIT = "Dependency audit (lockfile, including dev dependencies)";
const INSTALL = "run: npm ci --no-audit --no-fund";
const COVERAGE = "Check (lint + typecheck + coverage gate)";
const TIER0 = "Tier-0 check (validators + authz + EXPLAIN)";
const PATCH = "Patch coverage (WARN)";
const SUMMARY = "Coverage job summary";
const UPLOAD = "Upload coverage report";

function evaluateGuard(guard, { jobFailed, scope, reportPresent }) {
  const expression = guard.replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/, "$1");
  const tokens = expression.match(/'[^']*'|[A-Za-z_][\w.]*\(?|!=|==|&&|\|\||[()!]|\)/g) ?? [];
  assert.equal(tokens.join(""), expression.replace(/\s+/g, ""), `unsupported guard: ${guard}`);
  // Actions wraps an `if:` that names no status function in an implicit success().
  const implicitSuccess = !tokens.some((token) =>
    ["success(", "failure(", "always(", "cancelled("].includes(token),
  );
  let at = 0;
  const peek = () => tokens[at];
  const primary = () => {
    const token = tokens[at++];
    if (token === "!") return !primary();
    if (token === "(") {
      const value = or();
      assert.equal(tokens[at++], ")", `unbalanced guard: ${guard}`);
      return value;
    }
    if (token === "success(") return close(!jobFailed);
    if (token === "failure(") return close(jobFailed);
    if (token === "always(") return close(true);
    if (token === "cancelled(") return close(false);
    if (token === "hashFiles(") {
      assert.equal(
        tokens[at++],
        "'coverage/coverage-summary.json'",
        `unsupported hashFiles: ${guard}`,
      );
      return close(reportPresent ? "present-hash" : "");
    }
    const output = token.match(/^needs\.scope\.outputs\.(\w+)$/);
    assert(output, `unsupported guard token ${token}: ${guard}`);
    return scope[output[1]] ?? "";
  };
  const close = (value) => {
    assert.equal(tokens[at++], ")", `unbalanced guard: ${guard}`);
    return value;
  };
  const comparison = () => {
    const left = primary();
    if (peek() === "!=" || peek() === "==") {
      const operator = tokens[at++];
      const literal = tokens[at++];
      assert(/^'[^']*'$/.test(literal), `unsupported comparison: ${guard}`);
      const equal = left === literal.slice(1, -1);
      return operator === "==" ? equal : !equal;
    }
    return left;
  };
  const and = () => {
    let value = comparison();
    while (peek() === "&&") {
      at++;
      const right = comparison();
      value = value && right;
    }
    return value;
  };
  const or = () => {
    let value = and();
    while (peek() === "||") {
      at++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const result = or();
  assert.equal(at, tokens.length, `trailing guard tokens: ${guard}`);
  return Boolean(result) && (!implicitSuccess || !jobFailed);
}

// Walk the check job's steps in order. `failing` names the one step that fails
// when it runs; a step whose guard is false is skipped without failing the job.
function simulateCheckJob({ failing, scope, reportPresent = true }) {
  const outcomes = new Map();
  let jobFailed = false;
  for (const { label, guard } of checkSteps) {
    if (!evaluateGuard(guard, { jobFailed, scope, reportPresent })) {
      outcomes.set(label, "skipped");
      continue;
    }
    const failed = label === failing;
    outcomes.set(label, failed ? "failure" : "success");
    if (failed) jobFailed = true;
  }
  if (failing) assert.equal(outcomes.get(failing), "failure", `${failing} must run to fail`);
  return outcomes;
}

const codeScope = { docs_only: "false", draft: "false", full: "true", app: "true" };

test("the check job models the guarded steps the simulation relies on", () => {
  const labels = checkSteps.map((step) => step.label);
  for (const label of [AUDIT, INSTALL, COVERAGE, TIER0, PATCH, SUMMARY, UPLOAD]) {
    assert(labels.includes(label), `check job must keep the "${label}" step`);
  }
  assert(labels.indexOf(AUDIT) < labels.indexOf(INSTALL));
  assert(labels.indexOf(INSTALL) < labels.indexOf(COVERAGE));
  assert(labels.indexOf(COVERAGE) < labels.indexOf(TIER0));
  assert(labels.indexOf(TIER0) < labels.indexOf(PATCH));
  assert(labels.indexOf(PATCH) < labels.indexOf(SUMMARY));
  assert(labels.indexOf(SUMMARY) < labels.indexOf(UPLOAD));
});

test("the Tier-0 check guard requires success and keeps the docs-only/draft scope", () => {
  const guard = checkSteps.find((step) => step.label === TIER0)?.guard;
  assert.equal(
    guard,
    "success() && (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true')",
  );
});

test("the coverage summary and upload keep collecting evidence after a failure", () => {
  for (const label of [SUMMARY, UPLOAD]) {
    const guard = checkSteps.find((step) => step.label === label)?.guard;
    assert.equal(
      guard,
      "always() && (needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true') && hashFiles('coverage/coverage-summary.json') != ''",
    );
  }
});

for (const [label, failing] of [
  ["a failed dependency audit (npm install skipped)", AUDIT],
  ["a failed npm install", INSTALL],
  ["a failed coverage run", COVERAGE],
]) {
  test(`Tier-0 and patch coverage are skipped after ${label}`, () => {
    const outcomes = simulateCheckJob({ failing, scope: codeScope });
    assert.equal(outcomes.get(TIER0), "skipped");
    assert.equal(outcomes.get(PATCH), "skipped");
  });
}

test("a failed dependency audit skips npm install and every later success-guarded step", () => {
  const outcomes = simulateCheckJob({ failing: AUDIT, scope: codeScope, reportPresent: false });
  assert.equal(outcomes.get(INSTALL), "skipped");
  assert.equal(outcomes.get(COVERAGE), "skipped");
  assert.equal(outcomes.get(SUMMARY), "skipped");
  assert.equal(outcomes.get(UPLOAD), "skipped");
});

test("Tier-0 and patch coverage run when every earlier step succeeded", () => {
  const outcomes = simulateCheckJob({ scope: codeScope });
  assert.equal(outcomes.get(TIER0), "success");
  assert.equal(outcomes.get(PATCH), "success");
  // A missing report is the patch gate's own fail-closed case: it still runs.
  const noReport = simulateCheckJob({ scope: codeScope, reportPresent: false });
  assert.equal(noReport.get(PATCH), "success");
});

test("a patch coverage failure on a good run does not hide the evidence steps", () => {
  const outcomes = simulateCheckJob({ failing: PATCH, scope: codeScope });
  assert.equal(outcomes.get(SUMMARY), "success");
  assert.equal(outcomes.get(UPLOAD), "success");
});

test("the coverage summary and upload still run after a failed coverage run that wrote a report", () => {
  const outcomes = simulateCheckJob({ failing: COVERAGE, scope: codeScope });
  assert.equal(outcomes.get(SUMMARY), "success");
  assert.equal(outcomes.get(UPLOAD), "success");
  const noReport = simulateCheckJob({ failing: COVERAGE, scope: codeScope, reportPresent: false });
  assert.equal(noReport.get(SUMMARY), "skipped");
  assert.equal(noReport.get(UPLOAD), "skipped");
});

for (const scopeName of ["docs_only", "draft"]) {
  test(`Tier-0 and patch coverage are skipped on a ${scopeName} scope`, () => {
    const outcomes = simulateCheckJob({ scope: { ...codeScope, [scopeName]: "true" } });
    for (const label of [AUDIT, COVERAGE, TIER0, PATCH, SUMMARY, UPLOAD]) {
      assert.equal(outcomes.get(label), "skipped", label);
    }
  });
}

// Exercise the shipped npm script against a local CLI fixture. A successful-looking
// summary must not turn a failed coverage invocation into a passing required gate.
for (const [label, body, expected] of [
  ["success", "process.exitCode = 0;", 0],
  [
    "coverage failure after a passing summary",
    'console.log("Tests 2808 passed"); process.exitCode = 7;',
    7,
  ],
]) {
  test(`the full coverage command propagates ${label}`, { timeout: 20000 }, async (t) => {
    const fixture = await mkdtemp(
      join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "coverage-command-"),
    );
    t.after(() => rm(fixture, { recursive: true, force: true }));
    await mkdir(join(fixture, "node_modules/.bin"), { recursive: true });
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        private: true,
        type: "module",
        scripts: { "test:coverage": manifest.scripts["test:coverage"] },
      }),
    );
    const cli = join(fixture, "node_modules/.bin/vitest");
    await writeFile(
      cli,
      `#!/usr/bin/env node
import assert from "node:assert/strict";
assert.deepEqual(process.argv.slice(2), ${JSON.stringify(args)});
${body}
`,
    );
    await chmod(cli, 0o755);
    const child = spawn("npm", ["run", "--silent", "test:coverage"], {
      cwd: fixture,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data) => {
      stdout += data;
    });
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const [code, signal] = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve([code, signal]));
    });
    assert.equal(signal, null, stderr);
    assert.equal(code, expected, stderr);
    if (expected === 7) assert.match(stdout, /Tests 2808 passed/);
  });
}
