import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { parse } from "yaml";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  FOCUSED_MUTANTS,
  FOCUSED_SUITE,
  classifyRun,
  runFocused,
} from "./mutation-roles-wall-time.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = ["src/roles.ts", "src/admin/validation-wall-time.ts"];
const ids = [
  "R4-blank-allowlist-admits",
  "R5-fetch-failure-admits",
  "R6-lookup-failure-admits",
  "R7-any-role-admits",
  "W1-fold-later-resolves-earlier",
  "W2-gap-time-admitted",
  "W3-unknown-timezone-admitted",
];

function fixture(fn) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "focused-mutation-"),
  );
  const originals = Object.fromEntries(files.map((file) => [file, readFileSync(join(repo, file))]));
  try {
    for (const file of [...files, ...FOCUSED_SUITE, "node_modules/.bin/vitest"]) {
      mkdirSync(dirname(join(root, file)), { recursive: true });
      writeFileSync(join(root, file), originals[file] || "fixture\n");
    }
    const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "src", "test");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.com",
      "commit",
      "-qm",
      "fixture",
    );
    fn(root, originals);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function report(root) {
  return JSON.parse(
    readFileSync(join(root, "artifacts/mutation-roles-wall-time/report.json"), "utf8"),
  );
}

function restored(root, originals) {
  for (const file of files) assert.deepEqual(readFileSync(join(root, file)), originals[file]);
}

test("focused inventory is exactly two suites and seven existing nightly mutants", () => {
  assert.deepEqual(FOCUSED_SUITE, [
    "test/moderator-malformed-success.test.ts",
    "test/event-time-validation.test.ts",
  ]);
  assert.deepEqual(
    FOCUSED_MUTANTS.map((m) => m.id),
    ids,
  );
  assert.deepEqual([...new Set(FOCUSED_MUTANTS.map((m) => m.file))], files);
});

test("baseline precedes one mutant at a time, every outcome has verified restoration hashes", () => {
  fixture((root, originals) => {
    let calls = 0;
    const code = runFocused(root, {
      kill: (suite) => {
        assert.deepEqual(suite, FOCUSED_SUITE);
        const changed = files.filter(
          (file) => !readFileSync(join(root, file)).equals(originals[file]),
        );
        assert.equal(changed.length, calls === 0 ? 0 : 1);
        if (calls > 0) assert.equal(changed[0], FOCUSED_MUTANTS[calls - 1].file);
        return { verdict: calls++ === 0 ? "green" : "red", output: "fixture verdict" };
      },
    });
    assert.equal(code, 0);
    assert.equal(calls, 8);
    const r = report(root);
    assert.equal(r.baseline.verdict, "green");
    assert.equal(r.results.length, 7);
    assert.ok(r.results.every((row) => row.status === "killed"));
    for (const row of r.results) {
      assert.equal(row.beforeHash, row.afterHash);
      assert.match(row.beforeHash, /^[a-f0-9]{64}$/);
    }
    restored(root, originals);
  });
});

for (const verdict of ["green", "error", "throw"]) {
  test(`${verdict} mutant verdict is distinct from a kill and restores exact bytes`, () => {
    fixture((root, originals) => {
      let calls = 0;
      const code = runFocused(root, {
        kill: () => {
          if (calls++ === 0) return { verdict: "green", output: "baseline" };
          if (verdict === "throw") throw new Error("fixture spawn failure");
          return { verdict, output: "fixture outcome" };
        },
      });
      assert.equal(code, verdict === "green" ? 0 : 1);
      const r = report(root);
      assert.ok(
        r.results.every((row) => row.status === (verdict === "green" ? "survived" : "error")),
      );
      const md = readFileSync(join(root, "artifacts/mutation-roles-wall-time/report.md"), "utf8");
      assert.match(
        md,
        verdict === "green" ? /Survivors \(coverage gaps\): 7/ : /Infrastructure failures:/,
      );
      restored(root, originals);
    });
  });
}

for (const verdict of ["red", "error", "throw"]) {
  test(`${verdict} baseline refuses mutations but still writes reports`, () => {
    fixture((root, originals) => {
      let calls = 0;
      assert.equal(
        runFocused(root, {
          kill: () => {
            calls++;
            if (verdict === "throw") throw new Error("fixture baseline throw");
            return { verdict, output: "fixture baseline failure" };
          },
        }),
        1,
      );
      assert.equal(calls, 1);
      assert.equal(report(root).results.length, 0);
      assert.ok(report(root).infrastructureErrors.length > 0);
      restored(root, originals);
    });
  });
}

test("dirty target and missing suite are infrastructure refusals with reports, not mutations", () => {
  fixture((root, originals) => {
    writeFileSync(
      join(root, files[0]),
      Buffer.concat([originals[files[0]], Buffer.from("// dirty\n")]),
    );
    const dirty = readFileSync(join(root, files[0]));
    const kill = () => {
      throw new Error("must not run");
    };
    assert.equal(runFocused(root, { kill }), 1);
    assert.match(report(root).infrastructureErrors.join("\n"), /dirty/);
    assert.deepEqual(readFileSync(join(root, files[0])), dirty);
    writeFileSync(join(root, files[0]), originals[files[0]]);
    rmSync(join(root, FOCUSED_SUITE[0]));
    assert.equal(runFocused(root, { kill }), 1);
    assert.match(report(root).infrastructureErrors.join("\n"), /missing/);
    restored(root, originals);
  });
});

test("stale and ambiguous anchors report infrastructure, never count as kills", () => {
  for (const copies of [0, 2])
    fixture((root, originals) => {
      const m = FOCUSED_MUTANTS[0];
      writeFileSync(
        join(root, m.file),
        originals[m.file].toString().replace(m.find, m.find.repeat(copies)),
      );
      execFileSync("git", ["add", m.file], { cwd: root });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.com",
          "commit",
          "-qm",
          "drift",
        ],
        { cwd: root },
      );
      originals[m.file] = readFileSync(join(root, m.file));
      let calls = 0;
      assert.equal(
        runFocused(root, { kill: () => ({ verdict: calls++ === 0 ? "green" : "red" }) }),
        1,
      );
      const row = report(root).results[0];
      assert.equal(row.status, copies === 0 ? "stale" : "ambiguous");
      assert.equal(row.beforeHash, row.afterHash);
      restored(root, originals);
    });
});

test("restore mismatch stops the run, preserves unrelated bytes and persists the failure", () => {
  fixture((root, originals) => {
    let calls = 0;
    assert.equal(
      runFocused(root, {
        kill: () => {
          if (calls++ === 0) return { verdict: "green" };
          const path = join(root, files[0]);
          writeFileSync(path, readFileSync(path, "utf8") + "// concurrent edit\n");
          return { verdict: "red" };
        },
      }),
      1,
    );
    assert.equal(calls, 2);
    assert.equal(report(root).results[0].status, "error");
    assert.match(report(root).infrastructureErrors.join("\n"), /restore|hash/i);
    assert.equal(
      readFileSync(join(root, files[0]), "utf8"),
      originals[files[0]].toString() + "// concurrent edit\n",
    );
  });
});

function vitestReport(failed = 0) {
  return {
    success: failed === 0,
    numTotalTests: 46,
    numPassedTests: 46 - failed,
    numFailedTests: failed,
    numPendingTests: 0,
    numTodoTests: 0,
    testResults: FOCUSED_SUITE.map((name, i) => ({
      name: join(repo, name),
      assertionResults: Array.from({ length: i === 0 ? 20 : 26 }, (_, n) => ({
        status: i === 0 && n < failed ? "failed" : "passed",
      })),
    })),
  };
}

test("only real assertion failures are kills; exit-1 load failures and missing/skipped files are infra", () => {
  const classify = (status, json, extra = {}) =>
    classifyRun({ status, signal: null, ...extra }, json, repo);
  assert.equal(classify(0, vitestReport()), "green");
  assert.equal(classify(1, vitestReport(1)), "red");
  assert.equal(classify(1, { ...vitestReport(), success: false, numFailedTestSuites: 1 }), "error");
  assert.equal(classify(0, { ...vitestReport(), testResults: [] }), "error");
  const skipped = vitestReport();
  skipped.testResults[0].assertionResults[0].status = "pending";
  assert.equal(classify(0, skipped), "error");
  assert.equal(classify(0, null), "error");
  assert.equal(classify(2, vitestReport(1)), "error");
  assert.equal(classify(1, vitestReport(1), { signal: "SIGTERM" }), "error");
  assert.equal(classify(null, vitestReport(1), { error: new Error("ETIMEDOUT") }), "error");
});

test("unreadable restore target is recorded before refusing further mutation", () => {
  fixture((root) => {
    let calls = 0;
    assert.equal(
      runFocused(root, {
        kill: () => {
          if (calls++ === 0) return { verdict: "green" };
          rmSync(join(root, files[0]));
          return { verdict: "red" };
        },
      }),
      1,
    );
    assert.equal(calls, 2);
    const row = report(root).results[0];
    assert.equal(row.status, "error");
    assert.equal(row.afterHash, null);
    assert.match(row.detail, /unreadable/);
  });
});

test("real child invocation removes inherited DB URLs and writes fresh per-run evidence", () => {
  fixture((root) => {
    const databaseVars = [
      "DATABASE_URL",
      "AUDIT_IMPORT_TEST_DATABASE_URL",
      "LEGACY_DATABASE_URL",
      "BOT_DATABASE_URL",
    ];
    const oldEnv = databaseVars.map((name) => process.env[name]);
    const json = vitestReport();
    json.testResults.forEach((result, i) => {
      result.name = join(root, FOCUSED_SUITE[i]);
    });
    writeFileSync(
      join(root, "node_modules/.bin/vitest"),
      `
const fs = require('node:fs');
const assert = require('node:assert/strict');
for (const key of ${JSON.stringify(databaseVars)}) assert.equal(process.env[key], undefined);
assert.deepEqual(process.argv.slice(2, 5), ['run', ...${JSON.stringify(FOCUSED_SUITE)}]);
const output = process.argv.find((arg) => arg.startsWith('--outputFile=')).slice(13);
fs.writeFileSync(output, ${JSON.stringify(JSON.stringify(json))});
`,
    );
    try {
      databaseVars.forEach((name) => {
        process.env[name] = "must-be-removed";
      });
      assert.equal(runFocused(root), 0);
      assert.equal(report(root).baseline.verdict, "green");
      assert.equal(report(root).results.filter((row) => row.status === "survived").length, 7);
      for (const label of ["baseline", ...ids]) {
        assert.deepEqual(
          JSON.parse(
            readFileSync(
              join(root, `artifacts/mutation-roles-wall-time/${label}.vitest.json`),
              "utf8",
            ),
          ),
          json,
        );
      }
    } finally {
      databaseVars.forEach((name, i) => {
        if (oldEnv[i] === undefined) delete process.env[name];
        else process.env[name] = oldEnv[i];
      });
    }
  });
});

const workflow = parse(
  readFileSync(join(repo, ".github/workflows/mutation-roles-wall-time.yml"), "utf8"),
);

test("workflow is one bounded existing-runner WARN job, with no services, secrets or required consumers", () => {
  assert.deepEqual(Object.keys(workflow.jobs), ["focused-mutation"]);
  const job = workflow.jobs["focused-mutation"];
  assert.equal(job["runs-on"], "ubuntu-latest");
  assert.equal(job["timeout-minutes"], 5);
  assert.equal(job["continue-on-error"], true);
  assert.equal(job.services, undefined);
  assert.equal(job.needs, undefined);
  assert.deepEqual(workflow.permissions, { contents: "read" });
  assert.doesNotMatch(JSON.stringify(workflow), /secrets\./);
  const signal = job.steps.find((step) => step.id === "signal");
  assert.equal(signal.run, "npm run mutation:roles-wall-time");
  assert.equal(signal.if, "always()");
  assert.equal(signal["continue-on-error"], true);
  const harness = job.steps.find((step) => step.id === "harness");
  assert.equal(harness.run, "npm run mutation:roles-wall-time:selftest");
  assert.equal(harness["continue-on-error"], true);
  const upload = job.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.if, "always()");
  assert.equal(upload["continue-on-error"], true);
  assert.equal(upload.with.path, "artifacts/mutation-roles-wall-time/");
  assert.equal(upload.with["retention-days"], 14);
  assert.doesNotMatch(
    readFileSync(join(repo, ".github/workflows/ci.yml"), "utf8"),
    /mutation-roles-wall-time/,
  );
  const deploy = parse(readFileSync(join(repo, ".github/workflows/deploy.yml"), "utf8"));
  assert.deepEqual(deploy.on.workflow_run.workflows, ["ci"]);
});

test("always-run summary preserves a setup/runner failure report without failing the check", () => {
  const summary = workflow.jobs["focused-mutation"].steps.find((step) => step.env?.INSTALL_OUTCOME);
  assert.equal(summary.if, "always()");
  assert.equal(summary["continue-on-error"], true);
  for (const hasReport of [false, true])
    fixture((root) => {
      const dir = join(root, "artifacts/mutation-roles-wall-time");
      if (hasReport) {
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, "report.md"), "Survivors (coverage gaps): 1\n");
        writeFileSync(join(dir, "report.json"), JSON.stringify({ survivors: 1 }));
      }
      const child = spawnSync("bash", ["-e", "-c", summary.run], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          INSTALL_OUTCOME: "failure",
          HARNESS_OUTCOME: "failure",
          SIGNAL_OUTCOME: "failure",
          GITHUB_STEP_SUMMARY: join(root, "summary.md"),
        },
      });
      assert.equal(child.status, 0, child.stderr);
      const md = readFileSync(join(root, "summary.md"), "utf8");
      assert.match(md, /Setup infrastructure: install=failure, harness=failure/);
      assert.match(child.stdout, /::warning::/);
      if (hasReport) assert.equal(report(root).survivors, 1);
      else assert.match(report(root).infrastructureErrors[0], /unavailable/);
      assert.deepEqual(JSON.parse(readFileSync(join(dir, "workflow-status.json"), "utf8")), {
        install: "failure",
        harness: "failure",
        signal: "failure",
      });
    });
});
