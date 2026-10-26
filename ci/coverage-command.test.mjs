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

// --- Shared core check (same checks everywhere) ------------------------------
// The local root `check` script and the CI Check step must resolve ONE
// authoritative core chain: a dedicated npm script referenced by both
// callers. The core chain carries full coverage plus every node suite in
// CORE_SUITES; neither caller may inline those outside the shared entry
// (no bypass). Before the extraction there are 2 independently maintained
// chains (local `npm run test` + a short suite list vs CI `test:coverage`
// + the full suite list), so the resolution tests below fail; after the
// extraction they pass unchanged.
const CORE_SUITES = [
  "ci/a11y-*.test.mjs",
  "ci/admin-properties-ci.test.mjs",
  "ci/coverage-command.test.mjs",
  "ci/kit-preview-e2e-wiring.test.mjs",
  "ci/visual-accept.test.mjs",
  "ci/tier0-changed-query-files.test.mjs",
];

function npmRunRefs(command) {
  return [...command.matchAll(/npm run ([A-Za-z0-9:._-]+)/g)]
    .map((match) => match[1])
    .filter((name) => !name.startsWith("-"));
}

function expandScript(name, seen = []) {
  assert(!seen.includes(name), `npm script cycle: ${[...seen, name].join(" -> ")}`);
  const body = manifest.scripts[name];
  assert(body !== undefined, `npm script "${name}" does not exist`);
  return body.replace(/npm run ([A-Za-z0-9:._-]+)/g, (all, ref) =>
    ref.startsWith("-") ? all : `(${expandScript(ref, [...seen, name])})`,
  );
}

function ciCheckStepText() {
  const step = check.match(
    /      - name: Check \(lint \+ typecheck \+ coverage gate\)\n([\s\S]*?)(?=      - )/,
  );
  assert(step, "check job must keep the Check (lint + typecheck + coverage gate) step");
  return step[1];
}

function ciCheckRun() {
  const text = ciCheckStepText();
  const single = text.match(/^        run: (.+)$/m)?.[1];
  if (single !== undefined) return single;
  const block = text.match(/^        run: \|\n((?:          .*(?:\n|$))+)/m)?.[1];
  assert(block !== undefined, "Check step must keep a run: command");
  return block.replace(/^          /gm, "").trim();
}

function sharedCoreEntry() {
  const localRefs = npmRunRefs(manifest.scripts.check);
  const ciRefs = npmRunRefs(ciCheckRun());
  const common = [...new Set(localRefs)].filter((name) => ciRefs.includes(name));
  const carrying = common.filter((name) => {
    if (manifest.scripts[name] === undefined) return false;
    const expanded = expandScript(name);
    return expanded.includes("test:coverage") || expanded.includes("--coverage");
  });
  return { localRefs, ciRefs, common, carrying };
}

function requireSharedCoreEntry() {
  const { carrying } = sharedCoreEntry();
  assert.equal(
    carrying.length,
    1,
    `expected exactly one shared core entry referenced by both the local check and the CI Check step, found [${carrying.join(", ")}]`,
  );
  const entry = carrying[0];
  assert.notEqual(
    entry,
    "check",
    "the shared core must be a dedicated entry: CI must not run the full local check with its local-only surrounding checks",
  );
  return entry;
}

function missingCoreMembers(expanded) {
  const missing = [];
  if (!expanded.includes(`vitest ${args.join(" ")}`)) {
    missing.push(`full coverage (vitest ${args.join(" ")})`);
  }
  for (const suite of CORE_SUITES) {
    if (!expanded.includes(suite)) missing.push(suite);
  }
  return missing;
}

function callerBypassesCore(callerText, entry) {
  const remainder = callerText.replace(new RegExp(`npm run ${entry}(?![\\w:.-])`, "g"), "");
  return (
    /test:coverage/.test(remainder) ||
    /node --test/.test(remainder) ||
    /(^|\s)vitest(\s|$)/.test(remainder)
  );
}

test("the required check keeps full coverage in isolated serial threads inside main's job budget", async () => {
  assert.equal(manifest.scripts["test:coverage"], `vitest ${args.join(" ")}`);
  assert.equal(manifest.scripts["pretest:coverage"], undefined);
  assert.equal(manifest.scripts["posttest:coverage"], undefined);
  // main owns the budget (raised 10 -> 20 -> 40 for shared-runner
  // container setup, then 40 -> 60 when the full suite reached 38m and
  // runner noise started cancelling green runs at the 40m ceiling);
  // isolated threads must fit inside it, never widen it.
  const budget = Number(check.match(/^    timeout-minutes: (\d+)$/m)?.[1]);
  assert.ok(budget > 0 && budget <= 60, `check timeout-minutes ${budget} exceeds main's 60`);
  const stepText = ciCheckStepText();
  // The exact CI command string pin lived here. It now follows the shared
  // core entry: both callers reference one dedicated npm script whose
  // expansion carries full coverage plus every node suite in CORE_SUITES.
  const entry = requireSharedCoreEntry();
  assert.deepEqual(missingCoreMembers(expandScript(entry)), []);
  // Only the docs-only/draft scope gate (TOG-11811/TOG-14880) may guard the step; nothing may bypass it.
  assert.doesNotMatch(stepText, /continue-on-error:/);
  const guards = stepText.match(/^        if:.*$/gm) ?? [];
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

test("neither caller inlines core commands outside the shared entry", () => {
  const entry = requireSharedCoreEntry();
  assert.equal(
    callerBypassesCore(manifest.scripts.check, entry),
    false,
    "local check must not invoke coverage or node suites outside the shared entry",
  );
  assert.equal(
    callerBypassesCore(ciCheckRun(), entry),
    false,
    "CI Check step must not invoke coverage or node suites outside the shared entry",
  );
  const localRemainder = manifest.scripts.check.replace(
    new RegExp(`npm run ${entry}(?![\\w:.-])`, "g"),
    "",
  );
  assert.doesNotMatch(
    localRemainder,
    /npm run test(?![\w:.-])/,
    "local check must not keep the ordinary non-coverage test run beside the shared core",
  );
});

async function runCoreChain(t, chain, failExact) {
  const fixture = await mkdtemp(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "core-chain-"),
  );
  t.after(() => rm(fixture, { recursive: true, force: true }));
  const bin = join(fixture, "bin");
  await mkdir(bin, { recursive: true });
  const log = join(fixture, "invocations.log");
  const words = [
    ...new Set(chain.split("&&").map((stage) => stage.trim().split(/\s+/, 1)[0])),
  ];
  for (const word of words) {
    await writeFile(
      join(bin, word),
      `#!/bin/sh
printf '%s %s\\n' '${word}' "$*" >> "$CORE_CHAIN_LOG"
if [ -n "$CORE_CHAIN_FAIL_EXACT" ] && [ "${word} $*" = "$CORE_CHAIN_FAIL_EXACT" ]; then
  exit 7
fi
exit 0
`,
    );
    await chmod(join(bin, word), 0o755);
  }
  const child = spawn("sh", ["-c", chain], {
    cwd: fixture,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      CORE_CHAIN_LOG: log,
      CORE_CHAIN_FAIL_EXACT: failExact ?? "",
    },
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
  let lines = [];
  try {
    lines = (await readFile(log, "utf8")).trim().split("\n").filter(Boolean);
  } catch {
    lines = [];
  }
  return { code, lines, stderr };
}

// Execute the resolved chain against stub commands: a source-text `&&`
// assertion alone would still pass if the shared entry wrapped the chain
// in a runner that swallowed a nonzero status.
test("the resolved core chain fails fast: a nonzero status stops later commands", {
  timeout: 30000,
}, async (t) => {
  const entry = requireSharedCoreEntry();
  const chain = manifest.scripts[entry];
  const stages = chain.split("&&").map((stage) => stage.trim()).filter(Boolean);
  assert.ok(stages.length >= 3, `shared core entry must be a multi-command chain, got: ${chain}`);
  assert.doesNotMatch(chain, /;/, "shared core stages must join with &&, never ;");
  for (const stage of stages) {
    assert.match(
      stage,
      /^(npm|node) /,
      `shared core stage must be an npm/node invocation, got: ${stage}`,
    );
    assert.doesNotMatch(stage, /\|\|/, `shared core stage must not swallow failure with ||: ${stage}`);
  }
  assert.equal(
    new Set(stages).size,
    stages.length,
    "shared core chain must not repeat a command",
  );
  const norm = stages.map((stage) => stage.replace(/\s+/g, " "));
  const middle = Math.floor(stages.length / 2);
  const ok = await runCoreChain(t, chain, null);
  assert.equal(ok.code, 0, ok.stderr);
  assert.deepEqual(ok.lines, norm);
  const mid = await runCoreChain(t, chain, norm[middle]);
  assert.equal(mid.code, 7, mid.stderr);
  assert.deepEqual(mid.lines, norm.slice(0, middle + 1));
  const first = await runCoreChain(t, chain, norm[0]);
  assert.equal(first.code, 7, first.stderr);
  assert.deepEqual(first.lines, norm.slice(0, 1));
});

test("removing a selected command from the shared definition fails acceptance", () => {
  const victims = [`vitest ${args.join(" ")}`, "ci/visual-accept.test.mjs"];
  const synthetic =
    `(vitest ${args.join(" ")}) && npm run e2e:safety && node --test ${CORE_SUITES.join(" ")}`;
  // Pre-extraction this proves the predicate against a synthetic chain so
  // the check cannot pass vacuously once the shared entry lands.
  assert.deepEqual(missingCoreMembers(synthetic), []);
  for (const victim of victims) {
    assert.ok(synthetic.includes(victim));
    assert.ok(
      missingCoreMembers(synthetic.replace(victim, "")).length > 0,
      `removing ${victim} must fail acceptance`,
    );
  }
  const { carrying } = sharedCoreEntry();
  if (carrying.length === 1) {
    const expanded = expandScript(carrying[0]);
    assert.deepEqual(missingCoreMembers(expanded), []);
    for (const victim of victims) {
      assert.ok(expanded.includes(victim), `shared expansion must contain ${victim}`);
      assert.ok(
        missingCoreMembers(expanded.replace(victim, "")).length > 0,
        `removing ${victim} from the shared definition must fail acceptance`,
      );
    }
  }
});

test("bypassing the shared entry in either caller fails acceptance", () => {
  const entry = "check:core";
  const good = `npm run lint && npm run ${entry} && npm run budget`;
  assert.equal(callerBypassesCore(good, entry), false);
  assert.equal(
    callerBypassesCore(good.replace(`npm run ${entry}`, "npm run test:coverage"), entry),
    true,
    "inlining coverage beside the shared entry must fail acceptance",
  );
  assert.equal(
    callerBypassesCore(
      good.replace(`npm run ${entry}`, `node --test ${CORE_SUITES.join(" ")}`),
      entry,
    ),
    true,
    "inlining node suites beside the shared entry must fail acceptance",
  );
  const { carrying } = sharedCoreEntry();
  if (carrying.length === 1) {
    assert.equal(
      callerBypassesCore(manifest.scripts.check, carrying[0]),
      false,
      "local check must route core through the shared entry",
    );
    assert.equal(
      callerBypassesCore(ciCheckRun(), carrying[0]),
      false,
      "CI Check step must route core through the shared entry",
    );
  }
});

test("the local root check keeps its local-only surrounding checks", () => {
  for (const name of [
    "config:check",
    "docs:links",
    "ledger:timeouts",
    "check:kit-payloads",
    "test:cutover",
    "test:shadow",
    "budget",
    "gate:selftest",
    "test:smoke",
  ]) {
    assert.ok(
      manifest.scripts.check.includes(`npm run ${name}`),
      `local check must keep npm run ${name}`,
    );
  }
  assert.doesNotMatch(
    manifest.scripts.check,
    /check:offline/,
    "local check must not substitute the partial offline lane",
  );
  assert.doesNotMatch(
    ciCheckRun(),
    /check:offline/,
    "CI Check step must not substitute the partial offline lane",
  );
});

test("the offline lane stays deliberately partial and never substitutes for the full lane", async () => {
  const offline = await readFile(new URL("./offline-check.mjs", import.meta.url), "utf8");
  assert.match(offline, /Fixture-only check/, "offline lane must keep its limited-evidence disclaimer");
  assert.ok(
    offline.includes('["npm", ["run", "test"]]'),
    "offline lane keeps the ordinary non-coverage test run",
  );
  assert.doesNotMatch(offline, /test:coverage/, "offline lane must stay partial: no coverage gate");
  assert.match(offline, /delete env\[/, "offline lane must keep stripping database URLs");
  assert.doesNotMatch(offline, /postgres:\/\//, "offline lane must not embed a database URL");
});

test("required jobs, the CI gate wiring and security steps stay intact", () => {
  for (const job of ["scope", "check", "ci-ok"]) {
    assert.ok(workflow.includes(`\n  ${job}:\n`), `workflow must keep the ${job} job`);
  }
  const gate = workflow.slice(workflow.indexOf("\n  ci-ok:\n"));
  assert.match(gate, /needs: \[[^\]]*\bcheck\b[^\]]*\]/, "ci-ok must keep gating on check");
  for (const name of [
    "Dependency audit (lockfile, including dev dependencies)",
    "Security-pin contracts (Host admission + CSP inline styles)",
  ]) {
    const entry = check
      .split(/\n      - /)
      .find((item) => item.startsWith(`name: ${name}\n`));
    assert(entry, `check job must keep the "${name}" step`);
    assert.doesNotMatch(entry, /continue-on-error:/);
    const guards = entry.match(/^        if:.*$/gm) ?? [];
    assert.equal(guards.length, 1, `${name} must keep exactly its scope guard`);
    assert.ok(
      guards[0].includes("needs.scope.outputs.docs_only != 'true'") &&
        guards[0].includes("needs.scope.outputs.draft != 'true'"),
      `${name} guard must stay scope-gated: ${guards[0]}`,
    );
  }
});

test("this acceptance file runs hermetically: no database URLs, no staging endpoints", async () => {
  const own = await readFile(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(own, /postgres:\/\//);
  assert.doesNotMatch(own, /togetherweown\.com/);
  assert.doesNotMatch(own, /DATABASE_URL:\s*['"]?postgres/);
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
