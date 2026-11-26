import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
const check = workflow.slice(workflow.indexOf("\n  check:\n"));
const job = (id) => workflow.split(`\n  ${id}:\n`)[1]?.split(/\n  [\w-]+:\n/)[0];
const mergeJob = job("coverage-merge");
const args = ["run", "--coverage", "--pool=threads"];

test("Kit browser shards partition the fixture workload and fail closed in ci-ok", async (t) => {
  const { jobs } = parse(workflow);
  const fixture = jobs["kit-browser-fixture"];
  const lifeline = jobs["kit-browser-lifeline"];
  const ok = jobs["ci-ok"];
  const { env, run: script } = ok.steps.find(
    (step) => step.name === "Aggregate change-gated conclusions",
  );
  const command = "node --test --test-timeout=300000";
  const shards = [
    [
      "kit-browser-fixture",
      "KIT_BROWSER_RESULT",
      `${command} --test-skip-pattern='^calendar ' ci/kit-browser-fixture-isolation.test.mjs ci/kit-browser-fixture.test.mjs`,
    ],
    [
      "kit-browser-calendar",
      "KIT_CALENDAR_RESULT",
      `${command} --test-name-pattern='^calendar ' ci/kit-browser-fixture.test.mjs`,
    ],
    ["kit-browser-lifeline", "KIT_LIFELINE_RESULT", "node --test ci/kit-lifeline-browser.test.mjs"],
  ];
  assert.equal(
    fixture.if,
    "${{ !cancelled() && needs.scope.result == 'success' && needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true' && (needs.scope.outputs.full == 'true' || needs.scope.outputs.app == 'true' || needs.scope.outputs.worker == 'true') }}",
  );
  assert.deepEqual(fixture.steps[0].with, {
    ref: "${{ github.sha }}",
    "persist-credentials": false,
  });
  for (const [id, variable, testCommand] of shards) {
    const shard = jobs[id];
    assert.deepEqual(shard.needs, ["scope"]);
    assert.equal(shard.if, fixture.if);
    assert.equal(shard["timeout-minutes"], 30);
    assert.deepEqual(shard.container, fixture.container);
    assert.deepEqual(shard.steps.slice(0, 6), fixture.steps.slice(0, 6));
    assert.equal(shard.steps[6].run, testCommand);
    assert(!jobs.check.steps.some((step) => step.run?.includes(testCommand)));
    for (const step of shard.steps) assert.equal(step.if, undefined);
    for (const part of [shard, ...shard.steps]) assert.equal(part["continue-on-error"], undefined);
    assert(ok.needs.includes(id));
    assert.equal(env[variable], `\${{ needs.${id}.result }}`);
  }

  const upload = lifeline.steps.at(-1);
  assert.equal(upload.id, "lifeline-upload");
  assert.match(upload.uses, /^actions\/upload-artifact@[0-9a-f]{40}$/);
  assert.deepEqual(upload.with, {
    name: "kit-lifeline-${{ github.sha }}-${{ github.run_attempt }}",
    path: "artifacts/kit-lifeline/",
    "if-no-files-found": "error",
  });
  assert.equal(lifeline.outputs["artifact-id"], "${{ steps.lifeline-upload.outputs.artifact-id }}");
  assert.equal(
    env.KIT_LIFELINE_ARTIFACT_ID,
    "${{ needs.kit-browser-lifeline.outputs.artifact-id }}",
  );

  const cwd = await mkdtemp(join(tmpdir(), "kit-browser-wiring-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, "ci"));
  // Run the actual commands against stand-ins. Node matches name patterns
  // against ancestors too, so complementary regexes alone do not prove a split.
  for (const [file, names] of [
    ["kit-browser-fixture-isolation", ["fixture isolation"]],
    ["kit-browser-fixture", ["calendar example", "other fixture example"]],
    ["kit-lifeline-browser", ["Lifeline example"]],
  ]) {
    await writeFile(
      join(cwd, "ci", `${file}.test.mjs`),
      `import { test } from 'node:test';
import { appendFileSync } from 'node:fs';
for (const name of ${JSON.stringify(names)}) {
  test(name, () => appendFileSync('executed.txt', name + '\\n'));
}`,
    );
  }
  const executed = join(cwd, "executed.txt");
  for (const [id, cases] of [
    ["kit-browser-fixture", ["fixture isolation", "other fixture example"]],
    ["kit-browser-calendar", ["calendar example"]],
    ["kit-browser-lifeline", ["Lifeline example"]],
  ]) {
    await writeFile(executed, "");
    const run = spawnSync("sh", ["-c", jobs[id].steps[6].run], {
      cwd,
      encoding: "utf8",
      // Do not inherit NODE_TEST_CONTEXT from this outer test runner.
      env: { PATH: process.env.PATH },
    });
    assert.equal(run.status, 0, `${id}: ${run.stdout}\n${run.stderr}`);
    assert.deepEqual((await readFile(executed, "utf8")).trim().split("\n").sort(), cases, id);
  }

  const dir = join(cwd, upload.with.path);
  const verify = () => spawnSync("sh", ["-c", lifeline.steps[7].run], { cwd, env: {} }).status;
  assert.equal(verify(), 1);
  await mkdir(dir, { recursive: true });
  for (const state of ["upcoming", "frozen", "cancelled", "ended"])
    for (const width of [1280, 390]) await writeFile(join(dir, `${state}-${width}.png`), "fixture");
  assert.equal(verify(), 0);
  await writeFile(join(dir, "ended-390.png"), "");
  assert.equal(verify(), 1);
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
    KIT_CALENDAR_RESULT: "success",
    KIT_LIFELINE_RESULT: "success",
    KIT_LIFELINE_ARTIFACT_ID: "42",
  };
  const run = (overrides) =>
    spawnSync("bash", ["-c", script], { env: { ...base, ...overrides } }).status;
  for (const area of ["FULL", "APP", "WORKER"]) {
    assert.equal(run({ [area]: "true" }), 0);
    for (const [, variable] of shards)
      for (const result of ["failure", "cancelled", "skipped", ""])
        assert.equal(
          run({ [area]: "true", [variable]: result }),
          1,
          `${area}: ${variable}=${result}`,
        );
    for (const id of ["", "0", "not-an-id"])
      assert.equal(run({ [area]: "true", KIT_LIFELINE_ARTIFACT_ID: id }), 1);
  }
  const skipped = {
    KIT_BROWSER_RESULT: "skipped",
    KIT_CALENDAR_RESULT: "skipped",
    KIT_LIFELINE_RESULT: "skipped",
    KIT_LIFELINE_ARTIFACT_ID: "",
  };
  assert.equal(run(skipped), 0);
  assert.equal(run({ ...skipped, FULL: "true", DRAFT: "true" }), 0);
  assert.equal(run({ ...skipped, FULL: "true", DOCS_ONLY: "true" }), 0);
  assert.equal(run({ ...skipped, DOCS_ONLY: "" }), 1);
  assert.equal(run({ ...skipped, SCOPE_RESULT: "failure" }), 1);
});

test("coverage shards preserve serial threads and the merge uses the canonical coverage config", async () => {
  assert.equal(
    manifest.scripts["test:coverage"],
    `npm run generate:first-party && vitest ${args.join(" ")}`,
  );
  assert.equal(manifest.scripts["pretest:coverage"], undefined);
  assert.equal(manifest.scripts["posttest:coverage"], undefined);
  const shard = job("coverage-shard");
  assert.match(shard, /shard: \[1, 2, 3\]/);
  assert.match(shard, /SHARDS: \$\{\{ strategy\.job-total \}\}/);
  const run = 'npm run test:coverage -- --shard="$SHARD/$SHARDS" --reporter=dot --reporter=blob';
  assert(shard.includes(`VITEST_COVERAGE_SHARD: "1"\n        run: ${run} `));
  assert.equal(workflow.match(/VITEST_COVERAGE_SHARD:/g)?.length, 1);
  const artifact =
    /if-no-files-found: error\n          overwrite: true\n          retention-days: 30\b/;
  for (const id of ["coverage-shard", "node22-shard"]) assert.match(job(id), artifact);
  const budget = Number(shard.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(budget > 0 && budget <= 60, `coverage shard timeout ${budget} exceeds 60`);
  for (const key of ["path", "BLOB_DIR"])
    assert(mergeJob.includes(key + ": ${{ steps.blob-dir.outputs.path }}"));
  const merge = `TEST=true VITEST=true NODE_ENV=test node ci/verify-vitest-shards.mjs --coverage-dir "$BLOB_DIR"
          npm run test:coverage -- --merge-reports="$BLOB_DIR" --reporter=dot\n`;
  const result =
    'SHARD_RESULT: ${{ needs.coverage-shard.result }}\n        run: test "$SHARD_RESULT" = success';
  for (const required of [merge, result]) assert(mergeJob.includes(required), required);
  const staticCheck = job("static-check");
  assert.match(staticCheck, /run: npm run lint && npm run typecheck && npm run e2e:typecheck\n/);
  assert.doesNotMatch(shard + mergeJob + staticCheck, /continue-on-error:/);
  const gate = 'run: test "$STATIC_RESULT" = success && test "$COVERAGE_RESULT" = success\n';
  assert(job("ci-ok").includes(gate));
  const config = await readFile(new URL("../vitest.config.ts", import.meta.url), "utf8");
  assert.match(
    config,
    /include: \["test\/\*\*\/\*\.test\.ts", "test\/\*\*\/\*\.test\.mjs", "ci\/audit-lifecycle\.test\.mjs"\]/,
  );
  assert.match(config, /fileParallelism: false/);
  assert.doesNotMatch(config, /\bisolate:\s*false/);
});

test("coverage replay rejects hidden entries and blobs without coverage", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "coverage-replay-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const argv = ["ci/verify-vitest-shards.mjs", "--coverage-dir", dir];
  const reject = (diagnostic) => {
    const { status, stderr } = spawnSync(process.execPath, argv, { encoding: "utf8" });
    assert.equal(status, 1, stderr);
    assert.match(stderr, diagnostic);
  };
  const blob = (map) => `[[null,"1",null,${map}],["2"],{"filepath":"3"},"test/example.test.ts",{}]`;
  for (const shard of [1, 2, 3]) await writeFile(join(dir, `vitest-${shard}.json`), blob("null"));
  await writeFile(join(dir, ".hidden.json"), blob("null"));
  reject(/expected exactly three regular Vitest reports/);
  await rm(join(dir, ".hidden.json"));
  reject(/vitest-1\.json: missing or empty coverage map/);
  await writeFile(join(dir, "vitest-1.json"), blob('"4"'));
  reject(/vitest-1\.json: missing or empty coverage map/);
});

test("all split installs require successful dependency admission", () => {
  for (const id of ["static-check", "coverage-shard", "coverage-merge"]) {
    const extra = id === "coverage-merge" ? ", coverage-shard" : "";
    assert(job(id).includes(`    needs: [scope, dependency-admission${extra}]\n`), id);
    const condition = job(id)
      .split("\n")
      .find((line) => line.startsWith("    if: "));
    assert.equal(
      condition?.replace(" && needs.scope.outputs.isolated != 'true'", ""),
      "    if: ${{ !cancelled() && needs.scope.result == 'success' && needs.dependency-admission.result == 'success' && needs.scope.outputs.docs_only != 'true' && needs.scope.outputs.draft != 'true' }}",
    );
    assert.equal(
      condition?.includes("needs.scope.outputs.isolated != 'true'"),
      id !== "static-check",
    );
  }
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

test("the join coverage summary aggregates join and the shared throttle module", async (t) => {
  const fixture = await mkdtemp(join(tmpdir(), "join-coverage-summary-"));
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const coverage = (covered, total) =>
    Object.fromEntries(
      ["statements", "branches", "functions", "lines"].map((metric) => [
        metric,
        { covered, total, pct: (covered / total) * 100 },
      ]),
    );
  const summary = { total: coverage(1, 1) };
  for (const file of [
    "admin/index.ts",
    "events/index.ts",
    "sessions.ts",
    "jobs/index.ts",
    "bot/index.ts",
    "agent-events/index.ts",
    "profiles/index.ts",
    "auth/index.ts",
    "invite.ts",
    "return-journey.ts",
    "write-recovery.tsx",
    "kit-example.ts",
    "counts.ts",
    "seo.ts",
    "http/throttle-extra.ts",
  ]) {
    summary[join(fixture, "src", file)] = coverage(1, 1);
  }
  summary[join(fixture, "src/join/service.ts")] = coverage(1, 1);
  summary[join(fixture, "src/http/throttle.ts")] = coverage(1, 3);
  const reportPath = join(fixture, "coverage.json");
  await writeFile(reportPath, JSON.stringify(summary));
  const script = new URL("./coverage-summary.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(script), reportPath], {
    cwd: fixture,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.split("\n").find((line) => line.startsWith("| `src/join/")),
    "| `src/join/ + src/http/throttle.ts` | 50% | 50% | 50% | 50% |",
  );
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
  // silence the gate; the job already carries the docs-only/draft scope guard.
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
const parseSteps = (job) =>
  job
    .split(/\n      - /)
    .slice(1)
    .map((entry) => ({
      label: entry.match(/^name: (.+)$/m)?.[1] ?? entry.split("\n", 1)[0],
      id: entry.match(/^        id: ([\w-]+)$/m)?.[1],
      guard: entry.match(/^        if: (.+)$/m)?.[1] ?? "success()",
    }));
const checkSteps = parseSteps(checkJob);
const mergeSteps = parseSteps(mergeJob);
const auditStep = parseSteps(job("dependency-admission")).find(
  (step) => step.label === "Dependency audit (lockfile, including dev dependencies)",
);
const ADMISSION = "Require successful dependency admission";
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

// Walk the job's steps in order. `failing` names the one step that fails
// when it runs; a step whose guard is false is skipped without failing the job.
function simulateCheckJob({ failing, alsoFailing, scope, reportPresent = true, steps }) {
  const outcomes = new Map();
  const stepOutcomes = new Map();
  let jobFailed = false;
  for (const { label, id, guard } of steps ?? checkSteps) {
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
const simulateCoverage = (opts) =>
  simulateCheckJob({ scope: codeScope, ...opts, steps: mergeSteps });

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
  const labels = checkSteps.map((step) => step.label);
  assert(auditStep, "dependency-admission must run the lockfile audit");
  assert(!labels.includes(auditStep.label), "check must not repeat the lockfile audit");
  for (const [actual, expected] of [
    [labels, [ADMISSION, INSTALL, CHECK_CONTRACTS, TIER0]],
    [mergeSteps.map((step) => step.label), [COVERAGE, PATCH, SUMMARY, UPLOAD]],
  ])
    assert.deepEqual(
      actual.filter((label) => expected.includes(label)),
      expected,
    );
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

for (const failing of [ADMISSION, INSTALL, CHECK_CONTRACTS]) {
  test(`Tier-0 is skipped after ${failing} fails`, () => {
    const outcomes = simulateCheckJob({ failing, scope: codeScope });
    assert.equal(outcomes.get(TIER0), "skipped");
  });
}

test("a failed dependency audit skips npm install and every later success-guarded step", () => {
  // The guard's exit status for all admission results is tested in a11y-policy.test.mjs.
  const outcomes = simulateCheckJob({ failing: ADMISSION, scope: codeScope, reportPresent: false });
  for (const label of [INSTALL, CHECK_CONTRACTS, TIER0]) {
    assert.equal(outcomes.get(label), "skipped", label);
  }
});

test("Tier-0 and patch coverage run when every earlier step succeeded", () => {
  const outcomes = simulateCheckJob({ scope: codeScope });
  assert.equal(outcomes.get(TIER0), "success");
  assert.equal(simulateCoverage().get(PATCH), "success");
  // A missing report is the patch gate's own fail-closed case: it still runs.
  const noReport = simulateCoverage({ reportPresent: false });
  assert.equal(noReport.get(PATCH), "success");
});

test("a patch coverage failure on a good run does not hide the evidence steps", () => {
  const outcomes = simulateCoverage({ failing: PATCH });
  assert.equal(outcomes.get(SUMMARY), "success");
  assert.equal(outcomes.get(UPLOAD), "success");
});

test("the coverage summary and upload still run after a failed coverage run that wrote a report", () => {
  const outcomes = simulateCoverage({ failing: COVERAGE });
  assert.equal(outcomes.get(PATCH), "skipped");
  assert.equal(outcomes.get(SUMMARY), "success");
  assert.equal(outcomes.get(UPLOAD), "success");
  const noReport = simulateCoverage({ failing: COVERAGE, reportPresent: false });
  assert.equal(noReport.get(SUMMARY), "skipped");
  assert.equal(noReport.get(UPLOAD), "skipped");
});

for (const scopeName of ["docs_only", "draft"]) {
  test(`Tier-0 is skipped on a ${scopeName} scope`, () => {
    const scope = { ...codeScope, [scopeName]: "true" };
    assert(auditStep);
    assert(!evaluateGuard(auditStep.guard, { jobFailed: false, scope }));
    const outcomes = simulateCheckJob({ scope });
    assert.equal(outcomes.get(ADMISSION), "success");
    for (const label of [INSTALL, CHECK_CONTRACTS, TIER0]) {
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
