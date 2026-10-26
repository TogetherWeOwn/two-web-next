import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { checkExecuted as checkVitest } from "./a11y-require-executed.mjs";
import { checkExecuted as checkTap } from "./rsvp-focus-require-executed.mjs";

// Implementation-owned follow-up regressions. The independent acceptance
// contract and its captured fixtures remain unchanged.
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suite = "RSVP outcome focus in Chromium";
const tapFixture = readFileSync(
  new URL("./fixtures/execution-receipt-node24.tap", import.meta.url),
  "utf8",
);
const vitestFixture = JSON.parse(
  readFileSync(new URL("./fixtures/execution-receipt-vitest.json", import.meta.url), "utf8"),
);
const adapters = [
  { id: "tap", script: "ci/rsvp-focus-require-executed.mjs", check: checkTap },
  { id: "vitest", script: "ci/a11y-require-executed.mjs", check: checkVitest },
];
const stdoutMax = 16384;
const canary = "REPORT_DIAGNOSTIC_CANARY";

function temporary(callback) {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "receipt-regression-"),
  );
  try {
    return callback(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args, options = {}) {
  const env = { ...process.env, GITHUB_STEP_SUMMARY: "", ...options.env };
  // This subprocess is a fresh runner, not a child managed by our own --test.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
    ...options,
    env,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return result;
}

function cli(adapter, body, { json = true, minimum = 3, summary = "" } = {}) {
  return temporary((dir) => {
    const report = join(dir, "report");
    writeFileSync(report, typeof body === "string" ? body : JSON.stringify(body));
    return run(
      [
        join(root, adapter.script),
        report,
        suite,
        String(minimum),
        ...(json ? ["--format", "json"] : []),
      ],
      {
        env: { ...process.env, GITHUB_STEP_SUMMARY: summary },
      },
    );
  });
}

function refused(result, json = true) {
  assert.equal(result.status, 1);
  assert.doesNotMatch(result.stdout, /cases executed and passed|"verdict":"pass"/);
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${canary}|Error:|\\n\\s+at `));
  assert.ok(Buffer.byteLength(result.stdout) <= stdoutMax);
  assert.ok(Buffer.byteLength(result.stderr) <= 4096);
  if (json) {
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.verdict, "fail");
    assert.equal(receipt.error_code, "EXECUTION_RECEIPT_REJECTED");
    assert.ok(receipt.next_action.length > 0);
  } else assert.equal(result.stdout, "");
}

function vitestReport(count = 3) {
  const report = structuredClone(vitestFixture);
  const file = report.testResults[0];
  const entry = file.assertionResults[0];
  file.assertionResults = Array.from({ length: count }, (_, i) => ({
    ...entry,
    title: `case-${i}`,
    fullName: `${suite} case-${i}`,
  }));
  report.numTotalTests = count;
  report.numPassedTests = count;
  return report;
}

function tapReport(count) {
  const cases = Array.from(
    { length: count },
    (_, i) => `    # Subtest: case-${i}\n    ok ${i + 1} - case-${i}\n`,
  ).join("");
  return `TAP version 13\n# Subtest: ${suite}\n${cases}    1..${count}\nok 1 - ${suite}\n1..1\n# tests ${count}\n# suites 1\n# pass ${count}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
}

function valid(adapter, count = 3) {
  return adapter.id === "tap" ? tapReport(count) : vitestReport(count);
}

test("TAP refuses a genuine Node report with a failed suite teardown and passing leaf counters", () => {
  temporary((dir) => {
    const source = join(dir, "teardown.test.mjs");
    writeFileSync(
      source,
      `import { describe, it, after } from 'node:test';\ndescribe(${JSON.stringify(suite)}, () => {\n  for (const name of ['alpha', 'beta', 'gamma']) it(name, () => {});\n  after(() => { throw new Error(${JSON.stringify(canary)}); });\n});\n`,
    );
    const runner = run(["--test", "--test-reporter=tap", source]);
    assert.equal(runner.status, 1, "the real runner failed despite clean leaf counters");
    assert.match(runner.stdout, /^not ok 1 - RSVP outcome focus in Chromium$/m);
    assert.match(runner.stdout, /^# pass 3$/m);
    assert.match(runner.stdout, /^# fail 0$/m);
    assert.throws(() => checkTap(runner.stdout, suite, 3));
    refused(cli(adapters[0], runner.stdout));
  });
});

test("TAP refuses a failed outsider even when clean totals claim it passed", () => {
  const body = tapFixture
    .replace("1..1\n# tests 3", `# Subtest: outsider\nnot ok 2 - outsider\n1..2\n# tests 4`)
    .replace("# pass 3", "# pass 4");
  assert.throws(() => checkTap(body, suite, 3));
  refused(cli(adapters[0], body));
});

for (const [label, suffix] of [
  ["unattached bailout", `---\nBail out! ${canary}\nnot ok 2 - missing\n...\n`],
  ["indented but unattached", `  ---\n  Bail out! ${canary}\n  ...\n`],
  ["stray closing fence", "...\n"],
]) {
  test(`TAP refuses ${label} diagnostics after the completed report`, () => {
    refused(cli(adapters[0], tapFixture + suffix));
  });
}

for (const [label, body] of [
  [
    "before assertion",
    tapFixture.replace(
      "        ok 1 - returns focus",
      "          ---\n          message: premature\n          ...\n        ok 1 - returns focus",
    ),
  ],
  ["wrong opening indentation", tapFixture.replace("          ---", "        ---")],
  [
    "dedented bailout inside fence",
    tapFixture.replace("          duration_ms: 1.877336", `Bail out! ${canary}`),
  ],
  ["wrong closing indentation", tapFixture.replace("          ...", "        ...")],
]) {
  test(`TAP refuses diagnostic ${label}`, () => refused(cli(adapters[0], body)));
}

for (const json of [false, true]) {
  test(`TAP ${json ? "JSON" : "human"} refuses tab-indented diagnostic content`, () => {
    const body = tapFixture.replace(
      "          duration_ms: 1.877336",
      `          duration_ms: 1.877336\n          \tBail out! ${canary}`,
    );
    assert.notEqual(body, tapFixture);
    const result = cli(adapters[0], body, { json });
    refused(result, json);
    assert.match(result.stderr, /malformed-diagnostics/);
    assert.throws(() => checkTap(body, suite, 3), /malformed-diagnostics/);
  });
}

test("TAP permits diagnostic literals attached to an assertion without parsing their contents as results", () => {
  const body = tapFixture.replace(
    "          type: 'test'",
    "          type: 'test'\n          message: |\n            Bail out! literal text\n            not ok 2 - literal text\n            ---\n            ...",
  );
  const result = cli(adapters[0], body);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.executed, 3);
});

test("TAP refuses a positive child plan without child results", () => {
  const body = tapFixture.replace(
    "        ok 1 - returns focus",
    "            1..99\n        ok 1 - returns focus",
  );
  assert.throws(() => checkTap(body, suite, 3));
  refused(cli(adapters[0], body));
});

for (const [label, mutate] of [
  [
    "failed file",
    (r) => {
      r.testResults[0].status = "failed";
    },
  ],
  [
    "failed suite count",
    (r) => {
      r.numFailedTestSuites = 2;
    },
  ],
  [
    "pending suite count",
    (r) => {
      r.numPendingTestSuites = 1;
    },
  ],
  [
    "unequal suite counts",
    (r) => {
      r.numTotalTestSuites += 1;
    },
  ],
  [
    "invalid suite count",
    (r) => {
      r.numFailedTestSuites = "0";
    },
  ],
  [
    "missing file status",
    (r) => {
      delete r.testResults[0].status;
    },
  ],
  [
    "snapshot failure",
    (r) => {
      r.snapshot.failure = true;
    },
  ],
  [
    "failed assertion diagnostics",
    (r) => {
      r.testResults[0].assertionResults[0].failureMessages = [canary];
    },
  ],
]) {
  test(`Vitest refuses ${label} despite passed target assertions and overall success`, () => {
    const report = vitestReport();
    mutate(report);
    assert.throws(() => checkVitest(report, suite, 3));
    refused(cli(adapters[1], report));
  });
}

for (const status of ["failed", "pending", "skipped", "todo", "cancelled"]) {
  test(`Vitest refuses a ${status} outsider`, () => {
    const report = vitestReport();
    report.testResults[0].assertionResults.push({
      ancestorTitles: ["outsider"],
      title: "extra",
      fullName: "outsider extra",
      status,
    });
    report.numTotalTests += 1;
    if (status === "failed") report.numFailedTests += 1;
    if (status === "pending" || status === "skipped") report.numPendingTests += 1;
    if (status === "todo") report.numTodoTests += 1;
    assert.throws(() => checkVitest(report, suite, 3));
    refused(cli(adapters[1], report));
  });
}

for (const [escape, code] of [
  ["b", "0008"],
  ["f", "000c"],
  ["n", "000a"],
  ["r", "000d"],
  ["t", "0009"],
]) {
  test(`Vitest refuses equivalent short/Unicode ${escape} metadata keys`, () => {
    const body = JSON.stringify(vitestReport()).replace(
      '"meta":{}',
      `"meta":{"\\${escape}":1,"\\u${code}":2}`,
    );
    refused(cli(adapters[1], body));
  });
  test(`Vitest accepts distinct literal/${escape}-escaped metadata keys`, () => {
    const body = JSON.stringify(vitestReport()).replace(
      '"meta":{}',
      `"meta":{"${escape}":1,"\\${escape}":2}`,
    );
    const result = cli(adapters[1], body);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).counts.executed, 3);
  });
}

for (const adapter of adapters) {
  test(`${adapter.id} JSON receipt admits the last fitting case count and refuses the next before summary append`, () => {
    const control = cli(adapter, valid(adapter, 1), { minimum: 1 });
    assert.equal(control.status, 0, control.stderr);
    const sample = JSON.parse(control.stdout);
    let maximum = 1;
    for (let count = 2; count <= 400; count += 1) {
      const expected = {
        ...sample,
        cases: Array(count).fill(sample.cases[0]),
        counts: { ...sample.counts, executed: count, passed: count },
      };
      if (Buffer.byteLength(`${JSON.stringify(expected)}\n`) > stdoutMax) break;
      maximum = count;
    }
    assert.ok(maximum > 1 && maximum < 400);
    const atLimit = cli(adapter, valid(adapter, maximum), { minimum: maximum });
    assert.equal(atLimit.status, 0, atLimit.stderr);
    assert.ok(Buffer.byteLength(atLimit.stdout) <= stdoutMax);
    assert.equal(JSON.parse(atLimit.stdout).cases.length, maximum);
    temporary((dir) => {
      const summary = join(dir, "summary");
      writeFileSync(summary, "existing\n");
      const tooLarge = cli(adapter, valid(adapter, maximum + 1), { minimum: maximum + 1, summary });
      refused(tooLarge);
      assert.equal(readFileSync(summary, "utf8"), "existing\n");
    });
    const human = cli(adapter, valid(adapter, 400), { minimum: 400, json: false });
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /400 cases executed and passed/);
  });

  for (const json of [false, true]) {
    test(`${adapter.id} ${json ? "JSON" : "human"} append failure never emits success`, () => {
      temporary((dir) => refused(cli(adapter, valid(adapter), { json, summary: dir }), json));
    });
  }
}

test("TAP refuses a lone test bearing the requested suite name", () => {
  const body = `TAP version 13\n# Subtest: ${suite}\nok 1 - ${suite}\n1..1\n# tests 1\n# suites 0\n# pass 1\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n`;
  assert.throws(() => checkTap(body, suite, 1));
  refused(cli(adapters[0], body, { minimum: 1 }));
});

test("TAP counts a nested same-name suite only once", () => {
  const body = tapFixture.replaceAll("keyboard", suite);
  const result = cli(adapters[0], body);
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(result.stdout);
  assert.equal(receipt.counts.executed, 3);
  assert.equal(receipt.cases.length, 3);
  refused(cli(adapters[0], body, { minimum: 4 }));
});

test("Vitest admits unrelated top-level assertions with an empty ancestor array", () => {
  const report = vitestReport();
  report.testResults[0].assertionResults.push({
    ancestorTitles: [],
    title: "top-level",
    fullName: "top-level",
    status: "passed",
  });
  report.numTotalTests += 1;
  report.numPassedTests += 1;
  assert.match(checkVitest(report, suite, 3), /3 cases executed/);
  const result = cli(adapters[1], report);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).counts.executed, 3);
});
