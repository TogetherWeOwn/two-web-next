import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { lineCoverage, parseDiff, score } from "./patch-coverage.mjs";

for (const [header, file] of [
  // Real Git appends one TAB terminator to space-containing +++ headers.
  ["b/src/space name.ts\t", "src/space name.ts"],
  [String.raw`"b/src/\303\251.ts"`, "src/é.ts"],
  [String.raw`"b/src/a\tname.ts"`, "src/a\tname.ts"],
  [String.raw`"b/src/a\\name.ts"`, "src/a\\name.ts"],
  [String.raw`"b/src/\303\251 space.ts"` + "\t", "src/é space.ts"],
]) {
  test(`quoted/space path header: ${JSON.stringify(file)}`, () => {
    const added = parseDiff(
      `diff --git a/old b/new\n--- a/old\n+++ ${header}\n@@ -1 +1 @@\n---counter;\n+++counter;\n`,
    );
    assert.deepEqual([...added], [[file, new Set([1])]]);
  });
}

function runStrictJsonOnScratchRepo(t, filename) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "patch-coverage-space-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Coverage Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, env, stdio: "pipe", timeout: 5000 },
    );
  mkdirSync(join(root, "ci"));
  copyFileSync(
    new URL("./patch-coverage.mjs", import.meta.url),
    join(root, "ci/patch-coverage.mjs"),
  );
  git("init", "--quiet");
  git("add", ".");
  git(
    "commit",
    "--quiet",
    "-m",
    "test: fixture base\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  git("branch", "fixture-base");
  mkdirSync(dirname(join(root, filename)), { recursive: true });
  writeFileSync(join(root, filename), "work();\n");
  git("add", ".");
  git(
    "commit",
    "--quiet",
    "-m",
    "test: fixture patch\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  mkdirSync(join(root, "coverage"));
  writeFileSync(join(root, "coverage/coverage-final.json"), "{}");
  const result = spawnSync(
    process.execPath,
    [join(root, "ci/patch-coverage.mjs"), "--strict", "--json", "--base", "fixture-base"],
    { cwd: root, env, encoding: "utf8", timeout: 5000 },
  );
  assert.equal(result.error, undefined);
  return result;
}

for (const filename of ["src/space name.ts", "src/é space.ts"]) {
  test(`real-Git strict CLI scores uncovered space path: ${filename}`, (t) => {
    const result = runStrictJsonOnScratchRepo(t, filename);
    assert.equal(result.status, 1, result.stderr);
    const receipt = JSON.parse(result.stdout);
    assert.equal(receipt.verdict, "FAIL");
    assert.equal(receipt.error_code, null);
    assert.equal(receipt.total, 1);
    assert.equal(receipt.hit, 0);
    assert.deepEqual(receipt.added, [`${filename}:1`]);
    assert.deepEqual(receipt.missed, [`${filename}:1`]);
  });
}

test("only hunk source counts, even when it looks like a new-file header", () => {
  const parsed = parseDiff(
    [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -0,0 +1,2 @@",
      "+++ b/src/not-a-file.ts",
      "+work();",
      "\\ No newline at end of file",
      "diff --git a/src/deleted.ts b/src/deleted.ts",
      "--- a/src/deleted.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-gone();",
      "diff --git a/src/mode-only.ts b/src/mode-only.ts",
      "old mode 100644",
      "new mode 100755",
    ].join("\n"),
  );
  assert.deepEqual([...parsed], [["src/a.ts", new Set([1, 2])]]);
});

test("truncated or contradictory hunk data cannot become a partial green score", () => {
  for (const body of ["@@ -0,0 +1,2 @@\n+onlyOne\n", "@@ -1 +1 @@\n-old\n-oldAgain\n+new\n"]) {
    assert.throws(() => parseDiff(`diff --git a/src/a.ts b/src/a.ts\n+++ b/src/a.ts\n${body}`), {
      message: "git_failed",
    });
  }
});

const location = { start: { line: 1, column: 0 }, end: { line: 1, column: 10 } };
const valid = { path: "src/a.ts", statementMap: { 0: location }, s: { 0: 1 } };

test("relative and absolute evidence keys normalize to the same stable line IDs", () => {
  const coverage = lineCoverage({ "./src/a.ts": valid }, "/fixture");
  assert.deepEqual(score(new Map([["src/a.ts", new Set([1])]]), coverage), {
    total: 1,
    hit: 1,
    pct: 100,
    added: ["src/a.ts:1"],
    missed: [],
    skipped: [],
  });
});

test("empty maps are admitted, not inferred from missing fields", () => {
  const coverage = lineCoverage(
    { "src/a.ts": { path: "src/a.ts", statementMap: {}, s: {} } },
    "/fixture",
  );
  assert.equal(coverage.get("src/a.ts").statements.size, 0);
  for (const entry of [
    { ...valid, path: undefined },
    { ...valid, statementMap: undefined },
    { ...valid, s: undefined },
  ]) {
    assert.throws(() => lineCoverage({ "src/a.ts": entry }, "/fixture"), {
      message: "invalid_coverage",
    });
  }
});

test("nonfinite hits, positions, and ambiguous normalized files are invalid evidence", () => {
  for (const report of [
    { "src/a.ts": { ...valid, s: { 0: Number.POSITIVE_INFINITY } } },
    { "src/a.ts": { ...valid, s: { 0: Number.NaN } } },
    { "src/a.ts": { ...valid, statementMap: { 0: { start: [], end: location.end } } } },
    { "src/a.ts": valid, "./src/a.ts": valid },
    { "../a.ts": { ...valid, path: "../a.ts" } },
  ]) {
    assert.throws(() => lineCoverage(report, "/fixture"), { message: "invalid_coverage" });
  }
});

test("explicit null columns are admitted as unknown v8 positions", () => {
  const coverage = lineCoverage(
    {
      "src/a.ts": {
        path: "src/a.ts",
        statementMap: {
          0: { start: { line: 1, column: 0 }, end: { line: 1, column: null } },
          1: { start: { line: 2, column: null }, end: { line: 3, column: null } },
        },
        s: { 0: 1, 1: 0 },
      },
    },
    "/fixture",
  );
  assert.deepEqual(score(new Map([["src/a.ts", new Set([1, 2])]]), coverage), {
    total: 2,
    hit: 1,
    pct: 50,
    added: ["src/a.ts:1", "src/a.ts:2"],
    missed: ["src/a.ts:2"],
    skipped: [],
  });
});

test("null columns never excuse reversed lines, null lines, or missing fields", () => {
  for (const statementMap of [
    { 0: { start: { line: 2, column: null }, end: { line: 1, column: null } } },
    { 0: { start: { line: 2, column: null }, end: { line: 1, column: 10 } } },
    { 0: { start: { line: null, column: 0 }, end: { line: 2, column: null } } },
    { 0: { start: { line: 2 }, end: { line: 2, column: null } } },
  ]) {
    assert.throws(
      () =>
        lineCoverage({ "src/a.ts": { path: "src/a.ts", statementMap, s: { 0: 1 } } }, "/fixture"),
      { message: "invalid_coverage" },
    );
  }
});

test("human output stays below 8KiB for thirty long multibyte path IDs", (t) => {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "patch-coverage-edge-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = {
    PATH: process.env.PATH,
    HOME: "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Coverage Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      { cwd: root, env, stdio: "pipe", timeout: 5000 },
    );
  mkdirSync(join(root, "ci"));
  copyFileSync(
    new URL("./patch-coverage.mjs", import.meta.url),
    join(root, "ci/patch-coverage.mjs"),
  );
  git("init", "--quiet");
  git("add", ".");
  git(
    "commit",
    "--quiet",
    "-m",
    "test: fixture base\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  git("branch", "fixture-base");
  const file = join("src", ...Array(4).fill("é".repeat(100)), "a.ts");
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), "work();\n".repeat(45));
  git("add", ".");
  git(
    "commit",
    "--quiet",
    "-m",
    "test: fixture patch\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  mkdirSync(join(root, "coverage"));
  writeFileSync(join(root, "coverage/coverage-final.json"), "{}");
  const result = spawnSync(
    process.execPath,
    [join(root, "ci/patch-coverage.mjs"), "--base", "fixture-base"],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5000,
    },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /0\/45 added TS lines covered/);
  assert.equal((result.stdout.match(/^uncovered:/gm) || []).length, 30);
  assert.ok(
    Buffer.byteLength(result.stdout + result.stderr) <= 8192,
    "human diagnostics exceed 8KiB",
  );
});
