import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

// Author-owned acceptance contract; consume unchanged with the implementation.
// Run: node --test ci/a11y-execution-receipt-acceptance.test.mjs
// Existing ci/a11y-*.test.mjs inventory/check glob executes this without a browser opt-in.
// RCP-1: named/distinct evidence; RCP-2: structural admission; RCP-3: safe CLI receipts;
// RCP-4: read-only fixtures. A shared policy is observed through equivalent adapter outcomes,
// not a prescribed module layout. JSON contract: --format json, version: 1, suite_id,
// cases[].case_id, counts, verdict: pass|fail, error_code (null on success), next_action.
// Error spelling/ID encoding are deliberately not pinned; codes must be fixed safe tokens.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const suite = "RSVP outcome focus in Chromium";
const canary = "REPORT_CANARY_PRIVATE_CONTENT";
const adapters = [
  { id: "tap", script: "ci/rsvp-focus-require-executed.mjs" },
  { id: "vitest", script: "ci/a11y-require-executed.mjs" },
];

function tapReport({ title = suite, names = ["alpha", "beta", "gamma"], directive = "" } = {}) {
  const cases = names
    .map(
      (name, i) =>
        `    # Subtest: ${name}\n    ok ${i + 1} - ${name}${i === 0 ? directive : ""}\n      ---\n      duration_ms: 1\n      type: 'test'\n      ...\n`,
    )
    .join("");
  return `TAP version 13\n# Subtest: ${title}\n${cases}    1..${names.length}\nok 1 - ${title}\n  ---\n  duration_ms: 4\n  type: 'suite'\n  ...\n1..1\n# tests ${names.length}\n# suites 1\n# pass ${names.length}\n# fail 0\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 5\n`;
}

function vitestReport({
  title = suite,
  names = ["alpha", "beta", "gamma"],
  status = "passed",
} = {}) {
  return JSON.stringify({
    numTotalTestSuites: 2,
    numPassedTestSuites: 2,
    numFailedTestSuites: 0,
    numPendingTestSuites: 0,
    numTotalTests: names.length,
    numPassedTests: names.length,
    numFailedTests: 0,
    numPendingTests: 0,
    numTodoTests: 0,
    startTime: 1,
    success: true,
    snapshot: {},
    testResults: [
      {
        name: "/fixtures/browser-receipt.test.ts",
        status: "passed",
        message: "",
        startTime: 1,
        endTime: 5,
        assertionResults: names.map((name) => ({
          ancestorTitles: [title],
          title: name,
          fullName: `${title} ${name}`,
          status,
          duration: 1,
          failureMessages: [],
          meta: {},
        })),
      },
    ],
  });
}

function changeVitest(mutator, options) {
  const value = JSON.parse(vitestReport(options));
  mutator(value, value.testResults[0].assertionResults);
  return JSON.stringify(value);
}

function valid(adapter, options) {
  return adapter.id === "tap" ? tapReport(options) : vitestReport(options);
}

function withFixture(adapter, body, callback) {
  const dir = mkdtempSync(
    join(process.env.PAPERCLIP_SCRATCH_DIR || tmpdir(), "receipt-acceptance-"),
  );
  const report = join(dir, `report.${adapter.id === "tap" ? "tap" : "json"}`);
  writeFileSync(report, body);
  try {
    return callback({ dir, report });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function invoke(adapter, report, args = [], extraEnv = {}, minimum = 3, title = suite) {
  const env = { ...process.env, ...extraEnv };
  delete env.GITHUB_STEP_SUMMARY;
  if (extraEnv.GITHUB_STEP_SUMMARY) env.GITHUB_STEP_SUMMARY = extraEnv.GITHUB_STEP_SUMMARY;
  const result = spawnSync(
    process.execPath,
    [resolve(root, adapter.script), report, title, String(minimum), ...args],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 256 * 1024,
    },
  );
  assert.equal(
    result.error,
    undefined,
    "fixture process must launch/finish; setup errors are not RED",
  );
  assert.equal(result.signal, null, "fixture process must not be killed");
  return result;
}

function rejected(result, label) {
  assert.equal(result.status, 1, `${label}: reject inadmissible execution evidence`);
  assert.doesNotMatch(result.stdout, /cases executed and passed, 0 skipped/);
}

function jsonReceipt(result, verdict) {
  assert.ok(Buffer.byteLength(result.stdout) <= 16384, "bounded machine receipt");
  assert.ok(Buffer.byteLength(result.stderr) <= 4096, "bounded diagnostics");
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${canary}|Error:|\\n\\s+at `));
  let receipt;
  assert.doesNotThrow(() => {
    receipt = JSON.parse(result.stdout);
  }, "one JSON document, no human preamble");
  assert.equal(receipt.version, 1);
  assert.equal(receipt.verdict, verdict);
  assert.equal(typeof receipt.counts, "object");
  for (const key of ["executed", "passed", "failed", "skipped", "todo", "cancelled"]) {
    assert.ok(
      Number.isSafeInteger(receipt.counts[key]) && receipt.counts[key] >= 0,
      `safe ${key} count`,
    );
  }
  assert.ok(Array.isArray(receipt.cases));
  assert.equal(typeof receipt.suite_id, "string");
  assert.ok(receipt.suite_id.length > 0 && receipt.suite_id.length <= 256);
  assert.equal(typeof receipt.next_action, "string");
  assert.ok(receipt.next_action.trim().length > 0 && receipt.next_action.length <= 512);
  assert.doesNotMatch(receipt.next_action, /[\r\n\x00-\x1f]/);
  if (verdict === "pass") assert.equal(receipt.error_code, null);
  else assert.match(receipt.error_code, /^[A-Za-z][A-Za-z0-9_]{0,63}$/);
  return receipt;
}

const refusals = [
  [
    "RCP-1.01 counters-only",
    "# tests 3\n# pass 3\n# fail 0\n# cancelled 0\n# skipped 7\n# todo 0\n",
    JSON.stringify({ numTotalTests: 3, numPassedTests: 3, success: true, testResults: [] }),
  ],
  [
    "RCP-1.02 unrelated suite",
    tapReport({ title: "unrelated browser suite" }),
    vitestReport({ title: "unrelated browser suite" }),
  ],
  [
    "RCP-1.03 duplicate case identity",
    tapReport({ names: ["alpha", "alpha", "alpha"] }),
    vitestReport({ names: ["alpha", "alpha", "alpha"] }),
  ],
  [
    "RCP-1.04 missing case title",
    tapReport({ names: ["", "beta", "gamma"] }),
    changeVitest((_r, cases) => {
      delete cases[0].title;
    }),
  ],
  [
    "RCP-1.05 whitespace-only identity",
    tapReport({ names: ["   ", "beta", "gamma"] }),
    vitestReport({ names: ["   ", "beta", "gamma"] }),
  ],
  [
    "RCP-1.06 named suite below minimum cannot borrow unrelated passes",
    tapReport({ names: ["alpha", "beta"] })
      .replace(
        "1..1\n# tests 2",
        `# Subtest: unrelated\n    # Subtest: extra\n    ok 1 - extra\n      ---\n      type: 'test'\n      ...\n    1..1\nok 2 - unrelated\n  ---\n  type: 'suite'\n  ...\n1..2\n# tests 3`,
      )
      .replace("# suites 1", "# suites 2")
      .replace("# pass 2", "# pass 3"),
    changeVitest(
      (r) => {
        r.testResults.push(
          JSON.parse(vitestReport({ title: "unrelated", names: ["extra"] })).testResults[0],
        );
        r.testResults[1].name = "/fixtures/unrelated.test.ts";
        r.numTotalTests = 3;
        r.numPassedTests = 3;
        r.numTotalTestSuites = 4;
        r.numPassedTestSuites = 4;
      },
      { names: ["alpha", "beta"] },
    ),
  ],
  [
    "RCP-2.01 contradictory pass summary",
    tapReport().replace("# pass 3", "# pass 4"),
    changeVitest((r) => {
      r.numPassedTests = 4;
    }),
  ],
  [
    "RCP-2.02 hidden skipped summary",
    tapReport().replace("# skipped 0", "# skipped 1"),
    changeVitest((r) => {
      r.numPendingTests = 1;
    }),
  ],
  [
    "RCP-2.03 hidden todo summary",
    tapReport().replace("# todo 0", "# todo 1"),
    changeVitest((r) => {
      r.numTodoTests = 1;
    }),
  ],
  ["RCP-2.04 truncated completion", tapReport().split("1..1\n")[0], vitestReport().slice(0, -1)],
  [
    "RCP-2.05 contradictory failure summary",
    tapReport().replace("# fail 0", "# fail 1"),
    changeVitest((r) => {
      r.numFailedTests = 1;
    }),
  ],
  [
    "RCP-2.06 duplicate summary document",
    tapReport() + tapReport(),
    vitestReport() + vitestReport(),
  ],
  [
    "RCP-2.07 missing summary identity",
    tapReport()
      .replace("# Subtest: " + suite, "# Subtest: ")
      .replace("ok 1 - " + suite, "ok 1 - "),
    changeVitest((_r, cases) => {
      cases[0].ancestorTitles = [];
    }),
  ],
  [
    "RCP-2.08 malformed numeric summary",
    tapReport().replace("# tests 3", "# tests 3oops"),
    changeVitest((r) => {
      r.numTotalTests = "3";
    }),
  ],
  [
    "RCP-2.09 false success",
    tapReport().replace("ok 1 - alpha", "not ok 1 - alpha"),
    changeVitest((r) => {
      r.success = false;
    }),
  ],
  [
    "RCP-2.10 failed case masked by totals",
    tapReport().replace("ok 1 - alpha", "not ok 1 - alpha"),
    vitestReport({ status: "failed" }),
  ],
];

for (const adapter of adapters) {
  test(`${adapter.id} RCP-CONTROL-1 accepts distinct named cases with the legacy CLI`, () => {
    withFixture(adapter, valid(adapter), ({ report }) => {
      const result = invoke(adapter, report);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /3 cases executed and passed, 0 skipped/);
    });
  });

  for (const [id, tap, vitest] of refusals) {
    test(`${adapter.id} ${id}`, () => {
      withFixture(adapter, adapter.id === "tap" ? tap : vitest, ({ report }) =>
        rejected(invoke(adapter, report), id),
      );
    });
    test(`${adapter.id} ${id} machine refusal`, () => {
      withFixture(adapter, adapter.id === "tap" ? tap : vitest, ({ report }) => {
        const result = invoke(adapter, report, ["--format", "json"]);
        rejected(result, id);
        jsonReceipt(result, "fail");
      });
    });
  }

  test(`${adapter.id} RCP-3.01 JSON success has stable unique IDs and literal counts`, () => {
    withFixture(adapter, valid(adapter), ({ report, dir }) => {
      const result = invoke(adapter, report, ["--format", "json"]);
      assert.equal(result.status, 0);
      const first = jsonReceipt(result, "pass");
      assert.deepEqual(first.counts, {
        executed: 3,
        passed: 3,
        failed: 0,
        skipped: 0,
        todo: 0,
        cancelled: 0,
      });
      assert.equal(first.cases.length, 3);
      const ids = first.cases.map((entry) => entry.case_id);
      assert.ok(ids.every((id) => typeof id === "string" && id.length > 0 && id.length <= 256));
      assert.equal(new Set(ids).size, 3);
      const other = join(dir, "moved-report");
      const reordered = valid(adapter, { names: ["gamma", "alpha", "beta"] });
      writeFileSync(other, reordered);
      const second = jsonReceipt(invoke(adapter, other, ["--format", "json"]), "pass");
      assert.equal(
        second.suite_id,
        first.suite_id,
        "suite identity cannot depend on file location",
      );
      assert.deepEqual(
        second.cases.map((entry) => entry.case_id).sort(),
        [...ids].sort(),
        "case identity cannot be a row index",
      );
    });
  });

  test(`${adapter.id} RCP-3.02 fixed safe failure code ignores raw report text`, () => {
    withFixture(adapter, `${canary}\n${"x".repeat(65536)}`, ({ report, dir }) => {
      const one = invoke(adapter, report, ["--format", "json"]);
      rejected(one, "invalid report");
      const first = jsonReceipt(one, "fail");
      const other = join(dir, "different-invalid");
      writeFileSync(other, `${canary}_CHANGED\n`);
      const second = jsonReceipt(invoke(adapter, other, ["--format", "json"]), "fail");
      assert.equal(second.error_code, first.error_code, "fixed code, not report-derived prose");
    });
  });

  const badArgs = [
    ["unknown option", ["--unknown"]],
    ["extra positional", ["extra"]],
    ["wrong format", ["--format", "yaml"]],
    ["missing format value", ["--format"]],
    ["repeated format", ["--format", "json", "--format", "json"]],
  ];
  for (const [id, args] of badArgs) {
    test(`${adapter.id} RCP-3.03 ${id} rejects before reading or appending`, () => {
      withFixture(adapter, valid(adapter), ({ report, dir }) => {
        const summary = join(dir, "summary");
        writeFileSync(summary, "existing-summary\n");
        const result = invoke(adapter, report, args, { GITHUB_STEP_SUMMARY: summary });
        assert.equal(result.status, 1, "invalid arguments fail closed");
        assert.equal(readFileSync(summary, "utf8"), "existing-summary\n");
        assert.doesNotMatch(result.stdout, /cases executed and passed|"verdict"\s*:\s*"pass"/);
        const missing = invoke(adapter, join(dir, canary), args);
        assert.equal(missing.status, result.status);
        assert.equal(missing.stdout, result.stdout, "arguments checked before opening report");
        assert.equal(missing.stderr, result.stderr, "report path must not supply a stack/error");
        assert.doesNotMatch(result.stdout + result.stderr, new RegExp(canary));
      });
    });
  }

  for (const minimum of ["0", "-1", "3oops", "1.5", "Infinity", "9007199254740992"]) {
    test(`${adapter.id} RCP-3.04 invalid minimum ${minimum}`, () => {
      withFixture(adapter, valid(adapter), ({ report }) => {
        const result = spawnSync(
          process.execPath,
          [resolve(root, adapter.script), report, suite, minimum],
          {
            encoding: "utf8",
            timeout: 10000,
            env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
          },
        );
        assert.equal(result.error, undefined);
        rejected(result, "minimum must be a positive safe integer");
      });
    });
  }

  test(`${adapter.id} RCP-4.01 fixture-only verification is deterministic and read-only`, () => {
    withFixture(adapter, valid(adapter), ({ report, dir }) => {
      const before = readFileSync(report);
      const one = invoke(adapter, report);
      const two = invoke(adapter, report);
      assert.equal(one.status, 0);
      assert.equal(two.status, 0);
      assert.equal(one.stdout, two.stdout);
      assert.equal(one.stderr, two.stderr);
      assert.deepEqual(readFileSync(report), before);
      assert.deepEqual(readdirSync(dir), [report.split("/").at(-1)]);
    });
  });

  test(`${adapter.id} RCP-4.02 only explicit CI summary is appended without replacing content`, () => {
    withFixture(adapter, valid(adapter), ({ report, dir }) => {
      const summary = join(dir, "summary");
      writeFileSync(summary, "existing-summary\n");
      const before = readFileSync(report);
      const result = invoke(adapter, report, [], { GITHUB_STEP_SUMMARY: summary });
      assert.equal(result.status, 0);
      const text = readFileSync(summary, "utf8");
      assert.ok(text.startsWith("existing-summary\n"));
      assert.match(text, /3 cases executed and passed, 0 skipped/);
      assert.ok(text.length < 4096);
      assert.deepEqual(readFileSync(report), before);
      assert.deepEqual(readdirSync(dir).sort(), [report.split("/").at(-1), "summary"].sort());
    });
  });
}

for (const [id, reason] of [
  ["skip", "disabled"],
  ["todo", "pending"],
]) {
  test(`tap RCP-2.11 ${id} directive cannot be hidden by clean totals`, () => {
    const directive = ` # ${id.toUpperCase()} ${reason}`;
    withFixture(adapters[0], tapReport({ directive }), ({ report }) =>
      rejected(invoke(adapters[0], report), id),
    );
  });
}

for (const [id, mutate] of [
  [
    "string ancestors",
    (_r, cases) => {
      cases[0].ancestorTitles = suite;
    },
  ],
  [
    "null ancestors",
    (_r, cases) => {
      cases[0].ancestorTitles = null;
    },
  ],
  [
    "nonstring ancestor",
    (_r, cases) => {
      cases[0].ancestorTitles = [suite, 7];
    },
  ],
  [
    "blank ancestor",
    (_r, cases) => {
      cases[0].ancestorTitles = [suite, ""];
    },
  ],
  [
    "nonstring title",
    (_r, cases) => {
      cases[0].title = 7;
    },
  ],
  [
    "conflicting fullName",
    (_r, cases) => {
      cases[0].fullName = "different suite alpha";
    },
  ],
  [
    "unknown status",
    (_r, cases) => {
      cases[0].status = "success";
    },
  ],
  [
    "missing status",
    (_r, cases) => {
      delete cases[0].status;
    },
  ],
  [
    "pending",
    (_r, cases) => {
      cases[0].status = "pending";
    },
  ],
  [
    "todo",
    (_r, cases) => {
      cases[0].status = "todo";
    },
  ],
  [
    "cancelled",
    (_r, cases) => {
      cases[0].status = "cancelled";
    },
  ],
  [
    "missing file identity",
    (r) => {
      delete r.testResults[0].name;
    },
  ],
  [
    "duplicate file result",
    (r) => {
      r.testResults.push(structuredClone(r.testResults[0]));
    },
  ],
  [
    "missing assertions",
    (r) => {
      delete r.testResults[0].assertionResults;
    },
  ],
  [
    "wrong assertions shape",
    (r) => {
      r.testResults[0].assertionResults = {};
    },
  ],
  [
    "null result",
    (r) => {
      r.testResults = [null];
    },
  ],
]) {
  test(`vitest RCP-2.12 ${id}`, () => {
    withFixture(adapters[1], changeVitest(mutate), ({ report }) =>
      rejected(invoke(adapters[1], report), id),
    );
  });
}

for (const [id, body] of [
  ["duplicate terminal count", tapReport() + "# tests 3\n"],
  ["conflicting terminal count", tapReport() + "# tests 99\n"],
  ["missing terminal count", tapReport().replace("# tests 3\n", "")],
  ["cancelled count", tapReport().replace("# cancelled 0", "# cancelled 1")],
  ["wrong child plan", tapReport().replace("    1..3", "    1..4")],
  ["missing child plan", tapReport().replace("    1..3\n", "")],
  ["duplicate assertion number", tapReport().replace("ok 2 - beta", "ok 1 - beta")],
  ["bail out", tapReport() + "Bail out! " + canary + "\n"],
  ["trailing assertion", tapReport() + "# Subtest: extra\nok 2 - extra\n"],
  [
    "summary text inside diagnostics",
    `TAP version 13\n# ${canary}\n  ---\n  message: |\n    # tests 3\n    # pass 3\n  ...\n`,
  ],
]) {
  test(`tap RCP-2.13 ${id}`, () => {
    withFixture(adapters[0], body, ({ report }) => rejected(invoke(adapters[0], report), id));
  });
}

for (const adapter of adapters) {
  test(`${adapter.id} RCP-1.07 skipped target plus unrelated passes cannot substitute a receipt`, () => {
    const unrelated = valid(adapter, { title: "unrelated suite" });
    const body =
      adapter.id === "tap"
        ? unrelated
            .replace(
              "# Subtest: unrelated suite",
              `# Subtest: ${suite}\nok 1 - ${suite} # SKIP opt-in absent\n# Subtest: unrelated suite`,
            )
            .replace("ok 1 - unrelated suite", "ok 2 - unrelated suite")
            .replace("1..1\n# tests", "1..2\n# tests")
            .replace("# suites 1", "# suites 2")
            .replace("# skipped 0", "# skipped 1")
        : changeVitest(
            (r) => {
              const target = JSON.parse(
                vitestReport({ status: "pending", names: ["not executed"] }),
              ).testResults[0];
              target.name = "/fixtures/skipped-target.test.ts";
              target.status = "skipped";
              r.testResults.push(target);
              r.numTotalTests = 4;
              r.numPendingTests = 1;
              r.numTotalTestSuites = 4;
              r.numPassedTestSuites = 2;
              r.numPendingTestSuites = 2;
            },
            { title: "unrelated suite" },
          );
    withFixture(adapter, body, ({ report }) => rejected(invoke(adapter, report), "skipped target"));
  });
}

for (const version of ["22", "24"]) {
  test(`tap RCP-CONTROL-2 genuine Node ${version} nested suite receipt`, () => {
    const body = readFileSync(
      resolve(root, `ci/fixtures/execution-receipt-node${version}.tap`),
      "utf8",
    );
    withFixture(adapters[0], body, ({ report }) => {
      const result = invoke(adapters[0], report);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /3 cases executed and passed, 0 skipped/);
    });
  });
}

test("RCP-3.05 adapters share rejection policy and safe fixed code for duplicate identities", () => {
  const receipts = adapters.map((adapter) =>
    withFixture(adapter, valid(adapter, { names: ["same", "same", "same"] }), ({ report }) => {
      const result = invoke(adapter, report, ["--format", "json"]);
      rejected(result, "duplicates");
      return jsonReceipt(result, "fail");
    }),
  );
  assert.equal(receipts[0].error_code, receipts[1].error_code);
});

// RCP-CONTROL fixtures captured with Node 22.23.0 / 24.22.1 and the locked Vitest.
// Only the Vitest producer's run-owned absolute directory was replaced by /fixtures.
test("vitest RCP-CONTROL-3 genuine locked-reporter receipt", () => {
  const body = readFileSync(resolve(root, "ci/fixtures/execution-receipt-vitest.json"), "utf8");
  withFixture(adapters[1], body, ({ report }) => {
    const result = invoke(adapters[1], report);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /3 cases executed and passed, 0 skipped/);
  });
});

for (const adapter of adapters) {
  test(`${adapter.id} RCP-CONTROL-4 minimum remains an inclusive case floor`, () => {
    const names = Array.from({ length: 16 }, (_, i) => `case-${i + 1}`);
    withFixture(adapter, valid(adapter, { names }), ({ report }) => {
      const result = invoke(adapter, report, [], {}, 16);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /16 cases executed and passed, 0 skipped/);
      rejected(invoke(adapter, report, [], {}, 17), "below configured minimum");
    });
  });

  test(`${adapter.id} RCP-3.06 malformed human report never echoes canaries or stacks`, () => {
    withFixture(adapter, `${canary}\n${"x".repeat(65536)}`, ({ report }) => {
      const result = invoke(adapter, report);
      rejected(result, "malformed report");
      assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 4096);
      assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${canary}|Error:|\\n\\s+at `));
    });
  });

  test(`${adapter.id} RCP-3.07 missing report returns a safe machine refusal`, () => {
    withFixture(adapter, valid(adapter), ({ dir }) => {
      const result = invoke(adapter, join(dir, canary), ["--format", "json"]);
      rejected(result, "missing report");
      jsonReceipt(result, "fail");
    });
  });

  for (const [id, title] of [
    ["empty", ""],
    ["blank", "   "],
    ["control character", "bad\nname"],
  ]) {
    test(`${adapter.id} RCP-3.08 ${id} suite argument is refused before reading`, () => {
      withFixture(adapter, valid(adapter), ({ report, dir }) => {
        const one = invoke(adapter, report, [], {}, 3, title);
        const two = invoke(adapter, join(dir, canary), [], {}, 3, title);
        rejected(one, "invalid suite argument");
        assert.equal(one.stdout, two.stdout);
        assert.equal(one.stderr, two.stderr);
        assert.doesNotMatch(one.stdout + one.stderr, new RegExp(canary));
      });
    });
  }

  test(`${adapter.id} RCP-CONTROL-5 nested identity distinguishes equal leaf titles`, () => {
    const body =
      adapter.id === "tap"
        ? readFileSync(resolve(root, "ci/fixtures/execution-receipt-node24.tap"), "utf8")
            .replaceAll("returns focus", "shared leaf")
            .replaceAll("retains selection", "shared leaf")
        : changeVitest((r, cases) => {
            r.numTotalTestSuites = 3;
            r.numPassedTestSuites = 3;
            cases[0].title = "shared leaf";
            cases[0].ancestorTitles = [suite, "keyboard"];
            cases[0].fullName = `${suite} keyboard shared leaf`;
            cases[1].title = "shared leaf";
            cases[1].fullName = `${suite} shared leaf`;
          });
    withFixture(adapter, body, ({ report }) => {
      const result = invoke(adapter, report);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /3 cases executed and passed, 0 skipped/);
    });
  });

  test(`${adapter.id} RCP-3.09 nested cases receive distinct machine IDs`, () => {
    const body =
      adapter.id === "tap"
        ? readFileSync(resolve(root, "ci/fixtures/execution-receipt-node24.tap"), "utf8")
            .replaceAll("returns focus", "shared leaf")
            .replaceAll("retains selection", "shared leaf")
        : changeVitest((r, cases) => {
            r.numTotalTestSuites = 3;
            r.numPassedTestSuites = 3;
            cases[0].title = "shared leaf";
            cases[0].ancestorTitles = [suite, "keyboard"];
            cases[0].fullName = `${suite} keyboard shared leaf`;
            cases[1].title = "shared leaf";
            cases[1].fullName = `${suite} shared leaf`;
          });
    withFixture(adapter, body, ({ report }) => {
      const result = invoke(adapter, report, ["--format", "json"]);
      assert.equal(result.status, 0);
      const receipt = jsonReceipt(result, "pass");
      assert.equal(receipt.counts.executed, 3);
      assert.equal(new Set(receipt.cases.map((entry) => entry.case_id)).size, 3);
    });
  });
}

function mixedReport(adapter) {
  if (adapter.id === "tap")
    return tapReport()
      .replace(
        "1..1\n# tests 3",
        "# Subtest: unrelated\n    # Subtest: extra\n    ok 1 - extra\n      ---\n      type: 'test'\n      ...\n    1..1\nok 2 - unrelated\n  ---\n  type: 'suite'\n  ...\n1..2\n# tests 4",
      )
      .replace("# suites 1", "# suites 2")
      .replace("# pass 3", "# pass 4");
  return changeVitest((r) => {
    const other = JSON.parse(vitestReport({ title: "unrelated", names: ["extra"] })).testResults[0];
    other.name = "/fixtures/unrelated.test.ts";
    r.testResults.push(other);
    r.numTotalTests = 4;
    r.numPassedTests = 4;
    r.numTotalTestSuites = 4;
    r.numPassedTestSuites = 4;
  });
}

for (const adapter of adapters) {
  test(`${adapter.id} RCP-CONTROL-6 named suite coexists with other passing suites`, () => {
    withFixture(adapter, mixedReport(adapter), ({ report }) => {
      const result = invoke(adapter, report);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stdout, /3 cases executed and passed, 0 skipped/);
    });
  });
  test(`${adapter.id} RCP-3.11 rejected case diagnostics stay out of receipts`, () => {
    const body =
      adapter.id === "tap"
        ? tapReport({ names: [canary, "beta", "gamma"] })
            .replace(`ok 1 - ${canary}`, `not ok 1 - ${canary}`)
            .replace("duration_ms: 1", `message: ${canary}\n      duration_ms: 1`)
            .replace("# pass 3", "# pass 2")
            .replace("# fail 0", "# fail 1")
        : changeVitest((r, cases) => {
            cases[0].title = canary;
            cases[0].fullName = `${suite} ${canary}`;
            cases[0].status = "failed";
            cases[0].failureMessages = [canary.repeat(1024)];
            r.numPassedTests = 2;
            r.numFailedTests = 1;
            r.success = false;
            r.numPassedTestSuites = 0;
            r.numFailedTestSuites = 2;
            r.testResults[0].status = "failed";
            r.testResults[0].message = canary;
          });
    withFixture(adapter, body, ({ report }) => {
      for (const args of [[], ["--format", "json"]]) {
        const result = invoke(adapter, report, args);
        rejected(result, "failed case diagnostics");
        assert.ok(Buffer.byteLength(result.stdout + result.stderr) <= 16384);
        assert.doesNotMatch(
          result.stdout + result.stderr,
          new RegExp(`${canary}|Error:|\\n\\s+at `),
        );
        if (args.length) jsonReceipt(result, "fail");
      }
    });
  });
  test(`${adapter.id} RCP-3.10 JSON counts only the requested suite`, () => {
    withFixture(adapter, mixedReport(adapter), ({ report }) => {
      const result = invoke(adapter, report, ["--format", "json"]);
      assert.equal(result.status, 0);
      const receipt = jsonReceipt(result, "pass");
      assert.equal(receipt.counts.executed, 3);
      assert.equal(receipt.counts.passed, 3);
      assert.equal(receipt.cases.length, 3);
    });
  });
}

for (const [id, body] of [
  [
    "duplicate numeric summary key",
    vitestReport().replace('"numTotalTests":3', '"numTotalTests":3,"numTotalTests":3'),
  ],
  [
    "conflicting numeric summary key",
    vitestReport().replace('"numTotalTests":3', '"numTotalTests":99,"numTotalTests":3'),
  ],
  [
    "duplicate assertions key",
    vitestReport().replace('"assertionResults":', '"assertionResults":[],"assertionResults":'),
  ],
  [
    "missing total summary",
    changeVitest((r) => {
      delete r.numTotalTests;
    }),
  ],
]) {
  test(`vitest RCP-2.14 ${id}`, () => {
    withFixture(adapters[1], body, ({ report }) => rejected(invoke(adapters[1], report), id));
  });
}
