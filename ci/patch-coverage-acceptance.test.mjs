// Independent acceptance, fixture-only: node --test ci/patch-coverage-acceptance.test.mjs
// A2.1 hunk numbering; A2.2 evidence admission; A2.3 unchanged coverage policy;
// A2.4 JSON/errors/bounds; A2.5 help and hermetic selftest.
//
// JSON v1 contract (additive --json, stdout is one object, no annotations):
// schema_version: 1; floor: 80; total/hit/pct: existing score semantics;
// added/missed/skipped: sorted repo-relative "file:line" IDs (numeric line order);
// verdict: PASS | WARN | FAIL | ERROR; error_code: null or a fixed code;
// next_action: none | add_tests | fix_coverage_report | generate_coverage |
//              fix_arguments | check_base.
// ERROR uses null counts and empty line arrays, never a successful-looking 100%.
// Codes: invalid_coverage, missing_report, invalid_arguments, git_failed.
// Human errors name the same code, retain ::error::, never echo report data/stacks.
// WARN keeps ::warning:: and exit 0; strict low coverage exits 1.
// These are the test-author-owned expectations, not values derived from the scorer.
// Builder: consume this file unchanged, register this command in the existing CI
// check, and update docs/quality-gates.md. Do not merge the intentionally RED branch.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseDiff } from "./patch-coverage.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CANARY = "COVERAGE_PRIVATE_CANARY_DO_NOT_ECHO";
const missing = Symbol("missing report");
const env = {
  PATH: process.env.PATH,
  HOME: "",
  LANG: "C",
  LC_ALL: "C",
  TZ: "UTC",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Coverage Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Coverage Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z",
  GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z",
};

// Boundary instrumentation only: real filesystem, real git, real shipped CLI.
// No credentials are inherited. All network and non-read-only child commands are
// denied; audit counts survive failures. No timers/retries or fixture writes are
// allowed by the subject. A synchronous subprocess has a 5s/64KiB hard stop.
const guard = String.raw`
import fs from "node:fs";
import fsp from "node:fs/promises";
import cp from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import dnsp from "node:dns/promises";
import dgram from "node:dgram";
import timers from "node:timers";
import timerPromises from "node:timers/promises";
import { syncBuiltinESMExports } from "node:module";
const audit = { network: 0, timers: 0, children: 0, report_reads: 0, forbidden: 0 };
const save = fs.writeFileSync.bind(fs);
const reportPath = process.env.FIXTURE_REPORT;
const recordRead = (path) => {
  if (String(path) === reportPath || String(path) === "file://" + reportPath) audit.report_reads++;
};
for (const [object, method] of [[fs, "readFileSync"], [fs, "readFile"], [fsp, "readFile"]]) {
  const original = object[method].bind(object);
  object[method] = (path, ...args) => { recordRead(path); return original(path, ...args); };
}
const denyNetwork = () => { audit.network++; throw Error("fixture network forbidden"); };
for (const [object, methods] of [
  [http, ["request", "get"]], [https, ["request", "get"]],
  [net, ["connect", "createConnection"]], [tls, ["connect"]],
  [net.Socket.prototype, ["connect"]], [dgram, ["createSocket"]],
  [dns, ["lookup", "resolve", "resolve4", "resolve6"]],
  [dnsp, ["lookup", "resolve", "resolve4", "resolve6"]],
]) for (const method of methods) object[method] = denyNetwork;
globalThis.fetch = denyNetwork;
globalThis.WebSocket = class { constructor() { denyNetwork(); } };
for (const method of ["setTimeout", "setInterval"]) {
  const denyTimer = () => { audit.timers++; throw Error("fixture timer forbidden"); };
  globalThis[method] = timers[method] = timerPromises[method] = denyTimer;
}
for (const method of ["execSync", "exec", "execFileSync", "execFile", "spawnSync", "spawn", "fork"]) {
  const original = cp[method].bind(cp);
  cp[method] = (command, ...args) => {
    audit.children++;
    const shell = method === "execSync" || method === "exec";
    const words = shell ? String(command).split(/\s+/) : [String(command), ...(Array.isArray(args[0]) ? args[0] : [])];
    if (words[0] !== "git" || !["merge-base", "diff", "rev-parse", "status", "show"].includes(words[1]) ||
        words.some(word => /[;&|\x60$<>\n]/.test(word))) {
      audit.forbidden++;
      throw Error("fixture child command forbidden");
    }
    return original(command, ...args);
  };
}
syncBuiltinESMExports();
process.on("exit", () => save(process.env.FIXTURE_AUDIT, JSON.stringify(audit)));
`;

function git(root, ...args) {
  return execFileSync(
    "git",
    ["-c", "user.name=Coverage Fixture", "-c", "user.email=fixture@example.invalid", ...args],
    {
      cwd: root,
      env,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function tree(root, prefix = "") {
  const hashes = {};
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    if (entry.name === ".git" || entry.name === "boundary-audit.json") continue;
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) Object.assign(hashes, tree(root, name));
    else
      hashes[name] = createHash("sha256")
        .update(readFileSync(join(root, name)))
        .digest("hex");
  }
  return hashes;
}

function fixture(t, { before = {}, after = {}, report = {} } = {}) {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "coverage-acceptance-"),
  );
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Copy the CLI's local module tree so extracting a helper does not break the harness.
  cpSync(join(repo, "ci"), join(root, "ci"), { recursive: true });
  writeFileSync(join(root, "boundary-guard.mjs"), guard);
  const put = (name, value) => {
    mkdirSync(dirname(join(root, name)), { recursive: true });
    writeFileSync(join(root, name), value);
  };
  git(root, "init", "--quiet");
  git(root, "config", "commit.gpgsign", "false");
  git(root, "config", "core.hooksPath", "/dev/null");
  git(root, "config", "core.autocrlf", "false");
  for (const [name, content] of Object.entries(before)) put(name, content);
  git(root, "add", ".");
  git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "test: baseline fixture\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  git(root, "branch", "fixture-base");
  for (const [name, content] of Object.entries(after)) put(name, content);
  git(root, "add", ".");
  git(
    root,
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "test: changed fixture\n\nCo-Authored-By: Paperclip <noreply@paperclip.ing>",
  );
  git(root, "remote", "add", "origin", ".");
  git(root, "update-ref", "refs/remotes/origin/main", "fixture-base");
  if (report !== missing) {
    const value = typeof report === "function" ? report(root) : report;
    put("coverage/coverage-final.json", typeof value === "string" ? value : JSON.stringify(value));
  }
  const baseline = tree(root);
  const refs = git(root, "show-ref");
  return {
    root,
    run(args = []) {
      const result = spawnSync(
        process.execPath,
        [
          "--import",
          join(root, "boundary-guard.mjs"),
          join(root, "ci/patch-coverage.mjs"),
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...env,
            FIXTURE_AUDIT: join(root, "boundary-audit.json"),
            FIXTURE_REPORT: join(root, "coverage/coverage-final.json"),
          },
          encoding: "utf8",
          timeout: 5000,
          maxBuffer: 64 * 1024,
        },
      );
      assert.equal(result.error, undefined, "CLI must terminate within 5s/64KiB");
      assert.equal(result.signal, null, "CLI must exit normally, not be killed");
      assert.ok(
        Buffer.byteLength(result.stdout + result.stderr) <= 8192,
        "diagnostics must fit 8KiB",
      );
      const audit = JSON.parse(readFileSync(join(root, "boundary-audit.json"), "utf8"));
      assert.equal(audit.network, 0, "no attempted network access");
      assert.equal(audit.timers, 0, "no timers or retries");
      assert.equal(audit.forbidden, 0, "no mutating/non-git subprocesses");
      assert.ok(audit.children <= 4, "at most four local read-only git commands");
      assert.ok(audit.report_reads <= 1, "read the report at most once");
      assert.deepEqual(
        tree(root),
        baseline,
        "CLI must not rewrite fixtures or create output files",
      );
      assert.equal(git(root, "show-ref"), refs, "CLI must not change git refs");
      return { ...result, audit };
    },
  };
}

function entry(root, file, statements = [[1, 1]]) {
  return {
    path: join(root, file),
    statementMap: Object.fromEntries(
      statements.map(([line], id) => [
        String(id),
        {
          start: { line, column: 0 },
          end: { line, column: 12 },
        },
      ]),
    ),
    s: Object.fromEntries(statements.map(([, hits], id) => [String(id), hits])),
    fnMap: {},
    f: {},
    branchMap: {},
    b: {},
  };
}

function reportFor(statements, file = "src/counter.ts") {
  return (root) => ({ [join(root, file)]: entry(root, file, statements) });
}

function json(result) {
  let value;
  assert.doesNotThrow(() => {
    value = JSON.parse(result.stdout);
  }, "--json must emit one JSON object, not usage text/annotations");
  assert.equal(value.schema_version, 1);
  assert.equal(value.floor, 80);
  return value;
}

function expectScore(
  result,
  { total, hit, pct, added, missed = [], skipped = [], verdict = "PASS", status = 0 },
) {
  assert.equal(result.status, status);
  const value = json(result);
  for (const [key, expected] of Object.entries({
    total,
    hit,
    pct,
    added,
    missed,
    skipped,
    verdict,
    error_code: null,
    next_action: verdict === "PASS" ? "none" : "add_tests",
  })) {
    assert.deepEqual(value[key], expected, `JSON ${key}`);
  }
  assert.equal(result.audit.report_reads, 1, "scoring consumes the real report once");
}

function expectError(result, code, action, structured) {
  assert.ok(result.status > 0, `${code} must fail closed, not pass/WARN`);
  const output = result.stdout + result.stderr;
  assert.ok(!output.includes(CANARY), "never echo report data, paths, or hostile values");
  assert.doesNotMatch(output, /(?:SyntaxError|TypeError|Error):|\n\s+at /, "no uncaught stack");
  if (structured) {
    const value = json(result);
    for (const [key, expected] of Object.entries({
      verdict: "ERROR",
      error_code: code,
      next_action: action,
      total: null,
      hit: null,
      pct: null,
      added: [],
      missed: [],
      skipped: [],
    })) {
      assert.deepEqual(value[key], expected, `error JSON ${key}`);
    }
  } else {
    assert.match(output, /::error::/);
    assert.ok(output.includes(code), "human errors must name the fixed code");
  }
}

test("A2.1 CONTROL: ordinary headers and mixed changes keep new-side numbers", () => {
  const diff = [
    "diff --git a/src/ordinary.ts b/src/ordinary.ts",
    "index 1111111..2222222 100644",
    "--- a/src/ordinary.ts",
    "+++ b/src/ordinary.ts",
    "@@ -2,3 +2,4 @@",
    " keep();",
    "-removed();",
    "+replacement();",
    "+added();",
    " tail();",
    "@@ -10 +11,0 @@",
    "-gone();",
    "\\ No newline at end of file",
  ].join("\n");
  assert.deepEqual([...parseDiff(diff).get("src/ordinary.ts")], [3, 4]);
});

// A2.1: stripping +++/--- in a hunk loses increment statements and shifts the
// replacement line after a removed decrement. Hand-calculated new-side IDs.
for (const [name, body, expected] of [
  ["increment addition is not a file header", "@@ -0,0 +1 @@\n+++counter;", [1]],
  ["removed decrement consumes no new-side line", "@@ -1 +1 @@\n---counter;\n+work();", [1]],
  [
    "context and no-newline markers consume the correct sides",
    "@@ -2,3 +2,4 @@\n keep();\n---counter;\n+++counter;\n+work();\n tail();\n\\ No newline at end of file",
    [3, 4],
  ],
]) {
  test(`A2.1 parser: ${name}`, () => {
    const diff = `diff --git a/src/counter.ts b/src/counter.ts\nindex 1111111..2222222 100644\n--- a/src/counter.ts\n+++ b/src/counter.ts\n${body}\n`;
    assert.deepEqual([...parseDiff(diff).get("src/counter.ts")], expected);
  });
}

test("A2.1 parser: multiple files, deletion-only hunks and new-file headers reset numbering", () => {
  const diff = [
    "diff --git a/src/first.ts b/src/first.ts",
    "--- a/src/first.ts",
    "+++ b/src/first.ts",
    "@@ -1,2 +1,2 @@",
    "---counter;",
    "+first();",
    "-old();",
    "+++counter;",
    "@@ -10 +9,0 @@",
    "-gone();",
    "@@ -20 +19 @@",
    "-old();",
    "+later();",
    "diff --git a/src/new.tsx b/src/new.tsx",
    "new file mode 100644",
    "--- /dev/null",
    "+++ b/src/new.tsx",
    "@@ -0,0 +1,2 @@",
    "+<main>ok</main>;",
    "+next();",
    "\\ No newline at end of file",
  ].join("\n");
  const parsed = parseDiff(diff);
  assert.deepEqual([...parsed.get("src/first.ts")], [1, 2, 19]);
  assert.deepEqual([...parsed.get("src/new.tsx")], [1, 2]);
});

for (const [name, before, after] of [
  ["increment", "old();\n", "++counter;\n"],
  ["decrement replacement", "--counter;\n", "work();\n"],
  ["no newline", "--counter;", "++counter;"],
]) {
  test(`A2.1 CLI: real git ${name} patch counts uncovered line 1`, (t) => {
    const f = fixture(t, {
      before: { "src/counter.ts": before },
      after: { "src/counter.ts": after },
      report: reportFor([[1, 0]]),
    });
    const human = f.run(["--strict"]);
    assert.equal(
      human.status,
      1,
      "a real uncovered statement cannot disappear or shift out of the denominator",
    );
    assert.match(human.stdout, /0\/1 added TS lines covered \(0\.0%, floor 80%\)/);
    assert.match(human.stdout, /uncovered: src\/counter\.ts:1\b/);
    expectScore(f.run(["--json", "--strict"]), {
      total: 1,
      hit: 0,
      pct: 0,
      added: ["src/counter.ts:1"],
      missed: ["src/counter.ts:1"],
      verdict: "FAIL",
      status: 1,
    });
  });
}

test("A2.1/A2.4 CLI: multi-hunk/file IDs are stable, numerically sorted, and include TSX and tail", (t) => {
  const original = Array.from({ length: 14 }, (_, i) => `keep${i + 1}();`);
  original[1] = "--counter;";
  const changed = [...original];
  changed[1] = "++counter;";
  changed[11] = "changed();";
  const f = fixture(t, {
    before: { "src/z.ts": original.join("\n") },
    after: {
      "src/z.ts": changed.join("\n"),
      "src/a.tsx": "<main>ok</main>;\n",
      "tail/trace.ts": "trace();\n",
      "src/ignore.js": "ignored();\n",
    },
    report: (root) => ({
      [join(root, "tail/trace.ts")]: entry(root, "tail/trace.ts", [[1, 0]]),
      [join(root, "src/z.ts")]: entry(root, "src/z.ts", [
        [2, 1],
        [12, 0],
      ]),
      [join(root, "src/a.tsx")]: entry(root, "src/a.tsx", [[1, 1]]),
    }),
  });
  const first = f.run(["--json"]);
  expectScore(first, {
    total: 4,
    hit: 2,
    pct: 50,
    added: ["src/a.tsx:1", "src/z.ts:2", "src/z.ts:12", "tail/trace.ts:1"],
    missed: ["src/z.ts:12", "tail/trace.ts:1"],
    verdict: "WARN",
  });
  assert.equal(f.run(["--json"]).stdout, first.stdout, "identical reruns must be byte-identical");
});

// A2.2: every malformed fixture retains one valid covered statement, wherever
// possible. Rejecting only wholly-bad reports would silently erase bad records.
const invalidReports = [
  ["null report", () => null],
  ["array report", () => []],
  ["scalar report", () => 4],
  ["string report", () => JSON.stringify(CANARY)],
  ["invalid JSON", () => `{"${CANARY}":`],
  ["empty input", () => ""],
  ...[null, [], true, CANARY].map((value) => [
    `non-object file ${JSON.stringify(value)}`,
    (root) => ({ [join(root, "src/counter.ts")]: value }),
  ]),
  ...["statementMap", "s"].flatMap((field) => [
    [
      `missing ${field}`,
      (root, valid) => {
        delete valid[field];
        return { [join(root, "src/counter.ts")]: valid };
      },
    ],
    ...[null, [], CANARY].map((value) => [
      `invalid ${field} ${JSON.stringify(value)}`,
      (root, valid) => {
        valid[field] = value;
        return { [join(root, "src/counter.ts")]: valid };
      },
    ]),
  ]),
  ...[
    ["null location", null],
    ["missing start", { end: { line: 2, column: 10 } }],
    ["missing end", { start: { line: 2, column: 0 } }],
    ["zero line", { start: { line: 0, column: 0 }, end: { line: 2, column: 10 } }],
    ["negative line", { start: { line: -2, column: 0 }, end: { line: 2, column: 10 } }],
    ["fractional line", { start: { line: 2.5, column: 0 }, end: { line: 3, column: 10 } }],
    ["string line", { start: { line: "2", column: 0 }, end: { line: 2, column: 10 } }],
    ["missing column", { start: { line: 2 }, end: { line: 2, column: 10 } }],
    ["invalid end line", { start: { line: 2, column: 0 }, end: { line: "2", column: 10 } }],
    ["missing end column", { start: { line: 2, column: 0 }, end: { line: 2 } }],
    ["string column", { start: { line: 2, column: "0" }, end: { line: 2, column: 10 } }],
    ["negative column", { start: { line: 2, column: -1 }, end: { line: 2, column: 10 } }],
    ["fractional column", { start: { line: 2, column: 0.5 }, end: { line: 2, column: 10 } }],
    ["reversed lines", { start: { line: 2, column: 0 }, end: { line: 1, column: 10 } }],
    ["reversed columns", { start: { line: 2, column: 10 }, end: { line: 2, column: 0 } }],
    [
      "unsafe line integer",
      { start: { line: 9007199254740992, column: 0 }, end: { line: 9007199254740992, column: 10 } },
    ],
  ].map(([label, loc]) => [
    label,
    (root, valid) => {
      valid.statementMap["1"] = loc;
      return { [join(root, "src/counter.ts")]: valid };
    },
  ]),
  ...[-1, 0.5, "1", null, true, 9007199254740992].map((value) => [
    `invalid hit ${JSON.stringify(value)}`,
    (root, valid) => {
      valid.s["1"] = value;
      return { [join(root, "src/counter.ts")]: valid };
    },
  ]),
  [
    "missing hit ID",
    (root, valid) => {
      delete valid.s["1"];
      return { [join(root, "src/counter.ts")]: valid };
    },
  ],
  [
    "orphan hit ID",
    (root, valid) => {
      valid.s["99"] = 1;
      return { [join(root, "src/counter.ts")]: valid };
    },
  ],
  [
    "path contradicts file key",
    (root, valid) => {
      valid.path = join(root, `${CANARY}.ts`);
      return { [join(root, "src/counter.ts")]: valid };
    },
  ],
  [
    "conflicting normalized duplicate file",
    (root, valid) => ({
      [join(root, "src/counter.ts")]: valid,
      "src/counter.ts": entry(root, "src/counter.ts", [
        [1, 0],
        [2, 0],
      ]),
    }),
  ],
  [
    "malformed unchanged file",
    (root, valid) => ({
      [join(root, "src/counter.ts")]: valid,
      [join(root, `${CANARY}.ts`)]: { statementMap: null, s: {} },
    }),
  ],
];

for (const [name, make] of invalidReports) {
  test(`A2.2 evidence: ${name} fails closed in human/JSON WARN/strict modes`, async (t) => {
    const f = fixture(t, {
      after: { "src/counter.ts": "covered();\nuncovered();\n" },
      report: (root) =>
        make(
          root,
          entry(root, "src/counter.ts", [
            [1, 1],
            [2, 0],
          ]),
        ),
    });
    for (const args of [[], ["--strict"], ["--json"], ["--json", "--strict"]]) {
      await t.test(args.join(" ") || "default WARN", () => {
        expectError(
          f.run(args),
          "invalid_coverage",
          "fix_coverage_report",
          args.includes("--json"),
        );
      });
    }
  });
}

test("A2.2/A2.4 hostile report errors are bounded and never echo raw values or annotation commands", (t) => {
  const f = fixture(t, {
    after: { "src/counter.ts": "work();\n" },
    report: {
      [`${CANARY}${"x".repeat(20000)}\n::error::injected`]: {
        statementMap: { 0: { start: { line: CANARY }, end: null } },
        s: {},
      },
    },
  });
  for (const args of [[], ["--strict"], ["--json"], ["--json", "--strict"]]) {
    const result = f.run(args);
    expectError(result, "invalid_coverage", "fix_coverage_report", args.includes("--json"));
    assert.ok(!(result.stdout + result.stderr).includes("::error::injected"));
  }
});

for (const [name, after, report, total, hit, skipped, added] of [
  ["empty diff", {}, {}, 0, 0, [], []],
  [
    "type-only statements",
    { "src/counter.ts": "type Counter = number;\n\n" },
    reportFor([]),
    0,
    0,
    ["src/counter.ts:1", "src/counter.ts:2"],
    ["src/counter.ts:1", "src/counter.ts:2"],
  ],
  [
    "non-TS paths",
    { "src/counter.js": "work();\n", "tail/readme.md": "notes\n" },
    {},
    0,
    0,
    [],
    [],
  ],
  [
    "statement start not whole span",
    { "src/counter.ts": "work(\n  1,\n);\n" },
    (root) => {
      const value = entry(root, "src/counter.ts", [[1, 1]]);
      value.statementMap["0"].end = { line: 3, column: 2 };
      return { [join(root, "src/counter.ts")]: value };
    },
    1,
    1,
    ["src/counter.ts:2", "src/counter.ts:3"],
    ["src/counter.ts:1", "src/counter.ts:2", "src/counter.ts:3"],
  ],
  [
    "any statement on line can cover it",
    { "src/counter.ts": "first(); second();\n" },
    reportFor([
      [1, 0],
      [1, 2],
    ]),
    1,
    1,
    [],
    ["src/counter.ts:1"],
  ],
]) {
  for (const structured of [false, true]) {
    test(`A2.3 ${structured ? "JSON" : "CONTROL human"}: ${name} preserves valid no-statement semantics`, (t) => {
      const f = fixture(t, { after, report });
      if (structured) {
        expectScore(f.run(["--json", "--strict"]), { total, hit, pct: 100, skipped, added });
      } else {
        const human = f.run(["--strict"]);
        assert.equal(human.status, 0);
        assert.match(
          human.stdout,
          new RegExp(`${hit}/${total} added TS lines covered \\(100\\.0%, floor 80%\\)`),
        );
      }
    });
  }
}

for (const [name, statements, total, hit, pct, missed, warn, strictStatus] of [
  [
    "exactly 80%",
    [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 0],
    ],
    5,
    4,
    80,
    ["src/counter.ts:5"],
    false,
    0,
  ],
  [
    "75%",
    [
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 0],
    ],
    4,
    3,
    75,
    ["src/counter.ts:4"],
    true,
    1,
  ],
  [
    "missing file remains uncovered",
    null,
    2,
    0,
    0,
    ["src/counter.ts:1", "src/counter.ts:2"],
    true,
    1,
  ],
]) {
  for (const structured of [false, true]) {
    test(`A2.3 ${structured ? "JSON" : "CONTROL human"}: ${name} keeps the 80% floor and WARN/strict exits`, (t) => {
      const f = fixture(t, {
        after: {
          "src/counter.ts":
            Array.from({ length: total }, (_, i) => `line${i + 1}();`).join("\n") + "\n",
        },
        report: statements ? reportFor(statements) : {},
      });
      for (const strict of [false, true]) {
        const args = strict ? ["--strict"] : [];
        if (structured) {
          expectScore(f.run([...args, "--json"]), {
            total,
            hit,
            pct,
            added: Array.from({ length: total }, (_, i) => `src/counter.ts:${i + 1}`),
            missed,
            verdict: warn ? (strict ? "FAIL" : "WARN") : "PASS",
            status: strict ? strictStatus : 0,
          });
        } else {
          const result = f.run(args);
          assert.equal(result.status, strict ? strictStatus : 0);
          assert.match(
            result.stdout,
            new RegExp(`${hit}/${total} added TS lines covered \\(${pct}\\.0%, floor 80%\\)`),
          );
          assert.equal(result.stdout.includes("::warning::"), warn);
          for (const id of missed) assert.ok(result.stdout.includes(`uncovered: ${id}`));
        }
      }
    });
  }
}

test("A2.3 CONTROL: human low-coverage diagnostics stop at thirty uncovered lines", (t) => {
  const f = fixture(t, { after: { "src/counter.ts": "work();\n".repeat(45) }, report: {} });
  const result = f.run();
  assert.equal(result.status, 0);
  assert.equal((result.stdout.match(/^uncovered:/gm) || []).length, 30);
  assert.match(result.stdout, /15 more uncovered lines/);
});

test("A2.2 empty diff does not excuse malformed evidence", (t) => {
  const f = fixture(t, { report: { [CANARY]: null } });
  for (const args of [[], ["--json"]])
    expectError(f.run(args), "invalid_coverage", "fix_coverage_report", args.includes("--json"));
});

test("A2.3 CONTROL: legacy human missing-report behavior is an error, never a warning", (t) => {
  const f = fixture(t, { report: missing });
  for (const args of [[], ["--strict"]]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /::error::patch coverage missing input/);
    assert.doesNotMatch(result.stdout + result.stderr, /::warning::/);
    assert.equal(result.audit.report_reads, 0);
  }
});

test("A2.3/A2.4 missing report fails even on an empty diff, in both policy/output modes", (t) => {
  const f = fixture(t, { report: missing });
  for (const args of [[], ["--strict"], ["--json"], ["--json", "--strict"]]) {
    const result = f.run(args);
    assert.equal(result.status, 1);
    expectError(result, "missing_report", "generate_coverage", args.includes("--json"));
    if (!args.includes("--json"))
      assert.match(result.stderr, /::error::patch coverage missing input/);
    assert.equal(result.audit.report_reads, 0);
  }
});

for (const args of [
  ["--unknown"],
  ["unexpected"],
  ["--base"],
  ["--base", ""],
  ["--base", "--strict"],
  ["--base", "fixture-base", "--base", "fixture-base"],
  ["--dry-run"],
]) {
  test(`A2.4 wrong flags fail safely before input reads: ${JSON.stringify(args)}`, (t) => {
    const f = fixture(t, { report: missing });
    for (const structured of [false, true]) {
      const result = f.run(structured ? ["--json", ...args] : args);
      assert.equal(result.status, 2);
      expectError(result, "invalid_arguments", "fix_arguments", structured);
      assert.equal(result.audit.report_reads, 0);
      assert.equal(result.audit.children, 0);
    }
  });
}

test("A2.4 unknown base reports a recoverable git error without an uncaught stack", (t) => {
  const f = fixture(t);
  for (const args of [
    ["--base", "missing-branch"],
    ["--json", "--base", "missing-branch"],
  ]) {
    expectError(f.run(args), "git_failed", "check_base", args.includes("--json"));
  }
});

test("A2.4 explicit base remains supported and JSON is deterministic", (t) => {
  const f = fixture(t, { after: { "src/counter.ts": "work();\n" }, report: reportFor([[1, 1]]) });
  const first = f.run(["--base", "fixture-base", "--json"]);
  expectScore(first, { total: 1, hit: 1, pct: 100, added: ["src/counter.ts:1"] });
  assert.equal(f.run(["--json", "--base", "fixture-base"]).stdout, first.stdout);
});

test("A2.5 --help discovers JSON, policy, docs and the hermetic acceptance command without inputs", (t) => {
  const f = fixture(t, { report: missing });
  const result = f.run(["--help"]);
  assert.equal(result.status, 0);
  const help = result.stdout + result.stderr;
  assert.ok(help.length <= 2000, "short help, not a manual dump");
  for (const flag of ["--json", "--strict", "--base", "--selftest"]) assert.ok(help.includes(flag));
  assert.ok(help.includes("docs/quality-gates.md"));
  assert.ok(help.includes("node --test ci/patch-coverage-acceptance.test.mjs"));
  assert.equal(result.audit.report_reads, 0);
  assert.equal(result.audit.children, 0);
});

test("A2.5 CONTROL: existing --selftest is repeatable, offline and independent of report/git reads", (t) => {
  const f = fixture(t, { report: missing });
  const first = f.run(["--selftest"]);
  assert.equal(first.status, 0);
  assert.match(first.stdout, /patch coverage selftest: \d+ cases passed\./);
  assert.equal(first.audit.report_reads, 0);
  assert.equal(first.audit.children, 0);
  assert.equal(f.run(["--selftest"]).stdout, first.stdout);
});
