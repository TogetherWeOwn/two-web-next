import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const job = (id) => workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
const mergeJob = job("coverage-merge");
const args = ["run", "--coverage", "--pool=threads"];

test("the independent browser fixture remains selected and fail-closed in ci-ok", () => {
  const job = workflow.split("\n  kit-browser-fixture:\n")[1]?.split(/\n  [\w-]+:\n/)[0];
  const checkJob = check.split(/\n  [\w-]+:\n/)[1];
  const ok = workflow.split("\n  ci-ok:\n")[1];
  assert(job && ok && checkJob);
  assert.match(job, /needs: \[scope\]/);
  assert.match(
    job,
    /if: \$\{\{ !cancelled\(\) && needs\.scope\.result == 'success' && needs\.scope\.outputs\.docs_only != 'true' && needs\.scope\.outputs\.draft != 'true' && \(needs\.scope\.outputs\.full == 'true' \|\| needs\.scope\.outputs\.app == 'true' \|\| needs\.scope\.outputs\.worker == 'true'\) \}\}/,
  );
  const command =
    "node --test --test-timeout=300000 ci/kit-browser-fixture-isolation.test.mjs ci/kit-browser-fixture.test.mjs";
  const fixtureStep = job.split("\n      - name: Kit disposable browser fixture\n")[1];
  assert.equal(fixtureStep?.split(/\n\s*\n/)[0]?.trim(), `run: ${command}`);
  assert.doesNotMatch(job, /continue-on-error:/);
  assert(!checkJob.includes(command));
  assert.match(ok, /KIT_BROWSER_RESULT: \$\{\{ needs\.kit-browser-fixture\.result \}\}/);
  const script = ok.match(
    /- name: Aggregate change-gated conclusions\n[\s\S]*?        run: \|\n((?:          .*\n)+)/,
  )?.[1];
  assert(script);
  const base = {
    SCOPE_RESULT: "success",
    DRAFT: "false",
    DOCS_ONLY: "false",
    FULL: "false",
    APP: "false",
    WORKER: "false",
    DB: "false",
    CHECK_RESULT: "success",
    A11Y_RESULT: "success",
    LIGHTHOUSE_RESULT: "success",
    BUDGET_RESULT: "success",
    KIT_BROWSER_RESULT: "success",
  };
  const run = (env) => spawnSync("bash", ["-c", script], { env: { ...base, ...env } }).status;
  for (const area of ["FULL", "APP", "WORKER"]) {
    assert.equal(run({ [area]: "true" }), 0);
    for (const result of ["failure", "cancelled", "skipped", ""])
      assert.notEqual(run({ [area]: "true", KIT_BROWSER_RESULT: result }), 0);
  }
  assert.equal(run({ KIT_BROWSER_RESULT: "skipped" }), 0);
  assert.equal(run({ FULL: "true", DRAFT: "true", KIT_BROWSER_RESULT: "skipped" }), 0);
  assert.equal(run({ DOCS_ONLY: "true", KIT_BROWSER_RESULT: "skipped" }), 0);
  assert.notEqual(run({ DOCS_ONLY: "", KIT_BROWSER_RESULT: "skipped" }), 0);
  assert.notEqual(run({ SCOPE_RESULT: "failure", KIT_BROWSER_RESULT: "skipped" }), 0);
});

test("coverage shards preserve serial threads and the merge uses the canonical coverage config", async () => {
  assert.equal(
    manifest.scripts["test:coverage"],
    `npm run generate:first-party && vitest ${args.join(" ")}`,
  );
  assert.equal(manifest.scripts["pretest:coverage"], undefined);
  assert.equal(manifest.scripts["posttest:coverage"], undefined);
  const shard = job("coverage-shard");
  assert.match(shard, /needs: \[scope\]/);
  assert.match(shard, /shard: \[1, 2, 3\]/);
  assert.match(shard, /SHARDS: \$\{\{ strategy\.job-total \}\}/);
  assert(
    shard.includes('npm run test:coverage -- --shard="$SHARD/$SHARDS" --reporter=dot --reporter=blob'),
  );
  assert.match(shard, /if-no-files-found: error/);
  const budget = Number(shard.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(budget > 0 && budget <= 60, `coverage shard timeout ${budget} exceeds 60`);
  assert.match(mergeJob, /needs: \[scope, coverage-shard\]/);
  assert(
    mergeJob.includes('for shard in 1 2 3; do test -s "vitest-blob/vitest-$shard.json"; done'),
  );
  assert(
    mergeJob.includes("npm run test:coverage -- --merge-reports=vitest-blob --reporter=dot\n"),
  );
  assert(
    mergeJob.includes(
      'SHARD_RESULT: ${{ needs.coverage-shard.result }}\n        run: test "$SHARD_RESULT" = success',
    ),
  );
  assert.doesNotMatch(shard + mergeJob, /continue-on-error:/);
  const staticCheck = job("static-check");
  assert.match(staticCheck, /needs: \[scope\]/);
  assert.match(staticCheck, /run: npm run lint && npm run typecheck && npm run e2e:typecheck\n/);
  assert.doesNotMatch(staticCheck, /continue-on-error:/);
  assert(
    job("ci-ok").includes(
      'run: test "$STATIC_RESULT" = success && test "$COVERAGE_RESULT" = success\n',
    ),
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
  const step = mergeJob
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Patch coverage (WARN)\n"));
  assert(step, "coverage merge must keep the patch coverage step");
  // A hashFiles presence check would skip the step on a missing report and
  // silence the gate; only an earlier failure should skip it in the merge job.
  assert.doesNotMatch(step, /hashFiles\('coverage\/coverage-final\.json'\)/);
  assert.doesNotMatch(step, /continue-on-error:/);
  const guards = step.match(/^        if:.*$/gm) ?? [];
  assert.equal(guards.length, 1);
  assert.equal(guards[0], "        if: success()");
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
const stepsOf = (source) =>
  source
    .split(/\n      - /)
    .slice(1)
    .map((entry) => ({
      label: entry.match(/^name: (.+)$/m)?.[1] ?? entry.split("\n", 1)[0],
      id: entry.match(/^        id: ([\w-]+)$/m)?.[1],
      guard: entry.match(/^        if: (.+)$/m)?.[1] ?? "success()",
    }));
const checkSteps = stepsOf(checkJob);
const mergeSteps = stepsOf(mergeJob);
const AUDIT = "Dependency audit (lockfile, including dev dependencies)";
const INSTALL = "run: npm ci --no-audit --no-fund";
const CHECK_CONTRACTS = "Check CI contracts and e2e safety";
const COVERAGE = "Merge Vitest coverage with the repository thresholds";
const TIER0 = "Tier-0 check (validators + authz + EXPLAIN)";
const PATCH = "Patch coverage (WARN)";
const SUMMARY = "Coverage job summary";
const UPLOAD = "Upload coverage report";

function evaluateGuard(guard, { jobFailed, scope, reportPresent, stepOutcomes }) {
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
    const step = token.match(/^steps\.([\w-]+)\.outcome$/);
    if (step) return stepOutcomes.get(step[1]) ?? "";
    if (token === "env.KIT_CSS_FAILURE_DIR") return stepOutcomes.get("kit_css") ? "present" : "";
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
function simulateCheckJob(
  { failing, alsoFailing, scope, reportPresent = true },
  steps = checkSteps,
) {
  const outcomes = new Map();
  const stepOutcomes = new Map();
  let jobFailed = false;
  for (const { label, id, guard } of steps) {
    const runs = evaluateGuard(guard, { jobFailed, scope, reportPresent, stepOutcomes });
    const outcome = !runs
      ? "skipped"
      : label === failing || label === alsoFailing
        ? "failure"
        : "success";
    outcomes.set(label, outcome);
    if (id) stepOutcomes.set(id, outcome);
    if (outcome === "failure") jobFailed = true;
  }
  if (failing) assert.equal(outcomes.get(failing), "failure", `${failing} must run to fail`);
  return outcomes;
}

const codeScope = { docs_only: "false", draft: "false", full: "true", app: "true" };

test("bounded CSS evidence is collected only after the Kit budget fails", () => {
  const perf = "Kit performance budgets (worker + generated assets)";
  const collect = "Collect bounded Kit CSS on budget failure";
  const upload = "Upload bounded Kit CSS on budget failure";
  const cleanup = "Remove Kit CSS failure diagnostic";
  assert.equal(checkSteps.find((step) => step.label === perf)?.id, "kit_perf");
  const failed = simulateCheckJob({ failing: perf, scope: codeScope });
  for (const label of [collect, upload, cleanup]) assert.equal(failed.get(label), "success");
  const partial = simulateCheckJob({ failing: perf, alsoFailing: collect, scope: codeScope });
  assert.equal(partial.get(upload), "skipped");
  assert.equal(partial.get(cleanup), "success");
  for (const scenario of [
    { scope: codeScope },
    { failing: CHECK_CONTRACTS, scope: codeScope },
    { scope: { ...codeScope, draft: "true" } },
    { scope: { ...codeScope, docs_only: "true" } },
    { scope: { ...codeScope, full: "false", app: "false", worker: "false" } },
  ]) {
    const outcomes = simulateCheckJob(scenario);
    for (const label of [collect, upload, cleanup]) assert.equal(outcomes.get(label), "skipped");
  }
  const collectStep = checkJob
    .split(/\n      - /)
    .find((entry) => entry.startsWith(`name: ${collect}\n`));
  const uploadStep = checkJob
    .split(/\n      - /)
    .find((entry) => entry.startsWith(`name: ${upload}\n`));
  assert.match(collectStep, /env -i PATH="\$PATH" node ci\/kit-css-collect\.mjs/);
  assert.match(uploadStep, /retention-days: 3/);
  assert.match(uploadStep, /if-no-files-found: error/);
});

test("the shipping Kit route step reports overages but still fails on bad measurements", () => {
  const step = checkJob
    .split(/\n      - /)
    .find((entry) => entry.startsWith("name: Kit route performance (report only)\n"));
  assert.ok(step);
  assert.match(step, /^        run: node ci\/check-kit-route-perf\.mjs --report-only$/m);
  assert.doesNotMatch(step, /continue-on-error:/);
});

test("check and coverage merge keep the guarded steps in order", () => {
  for (const [steps, expected] of [
    [checkSteps, [AUDIT, INSTALL, CHECK_CONTRACTS, TIER0]],
    [mergeSteps, [COVERAGE, PATCH, SUMMARY, UPLOAD]],
  ]) {
    const labels = steps.map((step) => step.label);
    assert.deepEqual(
      labels.filter((label) => expected.includes(label)),
      expected,
    );
  }
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
    const guard = mergeSteps.find((step) => step.label === label)?.guard;
    assert.equal(guard, "${{ !cancelled() && hashFiles('coverage/coverage-summary.json') != '' }}");
  }
});

for (const failing of [AUDIT, INSTALL, CHECK_CONTRACTS]) {
  test(`Tier-0 is skipped after ${failing} fails`, () => {
    const outcomes = simulateCheckJob({ failing, scope: codeScope });
    assert.equal(outcomes.get(TIER0), "skipped");
  });
}

test("a failed dependency audit skips npm install and subsequently guarded checks", () => {
  const outcomes = simulateCheckJob({ failing: AUDIT, scope: codeScope });
  assert.equal(outcomes.get(INSTALL), "skipped");
  assert.equal(outcomes.get(CHECK_CONTRACTS), "skipped");
});

test("Tier-0 and patch coverage run when earlier steps in their own jobs succeed", () => {
  assert.equal(simulateCheckJob({ scope: codeScope }).get(TIER0), "success");
  const noReport = simulateCheckJob({ scope: codeScope, reportPresent: false }, mergeSteps);
  assert.equal(noReport.get(PATCH), "success");
});

for (const failing of [COVERAGE, PATCH]) {
  test(`${failing} failure does not hide evidence already generated`, () => {
    const outcomes = simulateCheckJob({ failing, scope: codeScope }, mergeSteps);
    assert.equal(outcomes.get(SUMMARY), "success");
    assert.equal(outcomes.get(UPLOAD), "success");
    if (failing === COVERAGE) assert.equal(outcomes.get(PATCH), "skipped");
    const noReport = simulateCheckJob(
      { failing, scope: codeScope, reportPresent: false },
      mergeSteps,
    );
    assert.equal(noReport.get(SUMMARY), "skipped");
    assert.equal(noReport.get(UPLOAD), "skipped");
  });
}

for (const scopeName of ["docs_only", "draft"]) {
  test(`Tier-0 is skipped on a ${scopeName} scope`, () => {
    const outcomes = simulateCheckJob({ scope: { ...codeScope, [scopeName]: "true" } });
    for (const label of [AUDIT, CHECK_CONTRACTS, TIER0]) {
      assert.equal(outcomes.get(label), "skipped", label);
    }
  });
}

// Exercise the shipped npm script against a local CLI fixture. A successful-looking
// summary must not turn a failed coverage invocation into a passing required gate.
for (const [label, body, expected, prepareFails] of [
  ["success", "process.exitCode = 0;", 0],
  ["preparation failure", 'console.log("unexpected coverage");', 9, true],
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
        scripts: {
          "test:coverage": manifest.scripts["test:coverage"],
          "generate:first-party": "node prepare.mjs",
        },
      }),
    );
    await writeFile(
      join(fixture, "prepare.mjs"),
      `console.log("preparation completed"); process.exitCode = ${prepareFails ? 9 : 0};`,
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
    assert.match(stdout, /preparation completed/);
    if (prepareFails) assert.doesNotMatch(stdout, /unexpected coverage/);
    if (expected === 7) assert.match(stdout, /Tests 2808 passed/);
  });
}
