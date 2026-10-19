#!/usr/bin/env node
// Timeout-ledger ratchet (HARD): every per-test timeout literal below the
// 30 s vitest default in test/** must have a ledger row in
// docs/ci-load-sensitive-tests.md naming the file with an (N× <limit>) count
// pin, plus a "why it stays" justification. Counts pin timeout LOCATIONS
// (trailing it/test arguments, including .each forms), not generated tests.
//
// Scope: test-form timeouts only — a trailing numeric literal (or a direct
// `{ timeout: N }` options object) on an it()/test() call, including .each,
// .skip and .only chains. Hook limits (beforeEach/afterEach/beforeAll/
// afterAll) are explicitly OUT of scope: per-hook limits are a follow-up, not
// this gate. Helper timeouts (setTimeout/setInterval, sql.end, expect.poll,
// vi.waitUntil, Playwright options) are not test-form and are ignored, as are
// elapsed-time asserts and literals at or above the 30 s default.
//
// Exit codes: 0 = ledger covers every flagged literal with exact counts,
// 1 = at least one uncovered file, missing count pin or count mismatch,
// 2 = usage error or an unreadable file (fail closed, like check-doc-links).
import {
  readdirSync,
  readFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LEDGER_REL = "docs/ci-load-sensitive-tests.md";
const DEFAULT_TIMEOUT_MS = 30_000;

// Blank comments, string literals and regex literals with spaces, preserving
// newlines so line numbers survive. The regex heuristic is standard: a `/`
// opens a regex when the previous significant character cannot end an
// expression (so `a / b` and `(x) / y` stay division).
export function blankNonCode(text) {
  const out = text.split("");
  const blank = (from, to) => {
    for (let i = from; i < to; i++) if (out[i] !== "\n") out[i] = " ";
  };
  let i = 0;
  const prevSignificant = (j) => {
    j -= 1;
    while (j >= 0 && (out[j] === " " || out[j] === "\t" || out[j] === "\r" || out[j] === "\n"))
      j -= 1;
    return j >= 0 ? out[j] : "";
  };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") {
      let j = text.indexOf("\n", i);
      if (j === -1) j = text.length;
      blank(i, j);
      i = j;
    } else if (c === "/" && n === "*") {
      const j = text.indexOf("*/", i + 2);
      const end = j === -1 ? text.length : j + 2;
      blank(i, end);
      i = end;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== c) j += text[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      blank(i, Math.min(j + 1, text.length));
      i = Math.min(j + 1, text.length);
    } else if (c === "/") {
      const prev = prevSignificant(i);
      if (/[a-zA-Z0-9_$)\]}]/.test(prev)) {
        i += 1; // Division, not a regex literal.
      } else {
        let j = i + 1;
        let inClass = false;
        while (j < text.length) {
          if (text[j] === "\\") j += 1;
          else if (text[j] === "[") inClass = true;
          else if (text[j] === "]") inClass = false;
          else if (text[j] === "/" && !inClass) break;
          else if (text[j] === "\n") break;
          j += 1;
        }
        if (j < text.length && text[j] === "/") {
          let k = j + 1;
          while (k < text.length && /[a-z]/.test(text[k])) k += 1;
          blank(i, k);
          i = k;
        } else {
          i += 1;
        }
      }
    } else {
      i += 1;
    }
  }
  return out.join("");
}

// Parse the argument list of the call opening at `open` (the index of `(`).
// Returns the raw text between the balanced parens plus the index of the
// closing paren, or null when unbalanced.
function balancedArgs(code, open) {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth += 1;
    else if (code[i] === ")") {
      depth -= 1;
      if (depth === 0) return { text: code.slice(open + 1, i), close: i };
    }
  }
  return null;
}

// Split raw argument text on top-level commas (non-code already blanked, so
// every surviving paren/brace/bracket is structural).
function splitTopLevel(args) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < args.length; i++) {
    const c = args[i];
    if (c === "(" || c === "{" || c === "[") depth += 1;
    else if (c === ")" || c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(args.slice(start));
  return parts;
}

const NUMERIC_ARG = /^\s*(\d[\d_]*)\s*$/;

// Scan one test file for test-form timeout literals below the default.
// Returns [{ line, value }] in file order.
export function scanTestTimeouts(source) {
  const code = blankNonCode(source);
  const found = [];
  const callPattern = /(^|[^\w$])(it|test)((?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*\(/g;
  const locate = (spanStart, span, digits) =>
    code.slice(0, spanStart + span.lastIndexOf(digits)).split("\n").length;
  let match;
  while ((match = callPattern.exec(code)) !== null) {
    const open = match.index + match[0].length - 1;
    let parsed = balancedArgs(code, open);
    if (parsed === null) continue;
    let spanStart = open + 1;
    if (/\.each\b/.test(match[3] ?? "")) {
      // it.each(cases)(name, fn, timeout): the timeout lives on the inner call.
      let inner = parsed.close + 1;
      while (inner < code.length && /\s/.test(code[inner])) inner += 1;
      if (code[inner] !== "(") continue;
      const innerParsed = balancedArgs(code, inner);
      if (innerParsed === null) continue;
      parsed = innerParsed;
      spanStart = inner + 1;
    }
    const raw = parsed.text;
    const args = splitTopLevel(raw)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (args.length === 0) continue;
    const last = args[args.length - 1];
    const numeric = NUMERIC_ARG.exec(last ?? "");
    if (numeric) {
      const value = Number(numeric[1].replaceAll("_", ""));
      if (value < DEFAULT_TIMEOUT_MS) {
        // Locate the literal for the diagnostic: its offset is the last
        // occurrence of the digits inside the argument span (the timeout is
        // the trailing argument, so the last occurrence is the literal).
        found.push({ line: locate(spanStart, raw, numeric[1]), value });
      }
      continue;
    }
    // Options form it(name, { timeout: N }, fn): no such call exists today;
    // the gate fails closed so a future one cannot slip past the ledger.
    for (const arg of args) {
      const option = /^\{\s*timeout\s*:\s*(\d[\d_]*)\s*\}$/.exec(arg);
      if (option) {
        const value = Number(option[1].replaceAll("_", ""));
        if (value < DEFAULT_TIMEOUT_MS) {
          found.push({ line: locate(spanStart, raw, option[1]), value });
        }
      }
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function listTestFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const rel = join(dir, entry.name).replaceAll("\\", "/");
      if (entry.isDirectory()) walk(rel);
      else if (/\.test\.(ts|mjs)$/.test(entry.name)) out.push(rel);
    }
  };
  if (existsSync(join(root, "test"))) walk("test");
  return out.sort();
}

// Parse the "Remaining limits" table of the ledger doc. Returns a Map from
// test/ path to the summed (N×) count pins in rows mentioning that file.
export function parseLedgerPins(ledgerText) {
  const lines = ledgerText.split(/\r?\n/);
  const section = lines.findIndex((line) => line.startsWith("## Remaining limits"));
  const pins = new Map();
  const mentioned = new Set();
  for (let i = section === -1 ? 0 : section + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line)) break;
    if (!line.startsWith("|")) continue;
    const files = new Set();
    for (const span of line.matchAll(/`(test\/[^`\s]+)`/g)) {
      const file = span[1].replace(/:\d+(?:[,-]\d+)*$/, "");
      files.add(file);
      mentioned.add(file);
    }
    if (files.size === 0) continue;
    let count = 0;
    for (const pin of line.matchAll(/(\d+)\s*×/g)) count += Number(pin[1]);
    for (const file of files) pins.set(file, (pins.get(file) ?? 0) + count);
  }
  return { pins, mentioned };
}

export function checkLedger(root, output = console) {
  const ledgerPath = join(root, LEDGER_REL);
  if (!existsSync(ledgerPath)) {
    output.error(`timeout ledger: missing ${LEDGER_REL}`);
    return 2;
  }
  let ledgerText;
  try {
    ledgerText = readFileSync(ledgerPath, "utf8");
  } catch (error) {
    output.error(`timeout ledger: cannot read ${LEDGER_REL}: ${error.message}`);
    return 2;
  }
  const { pins, mentioned } = parseLedgerPins(ledgerText);
  const errors = [];
  for (const rel of listTestFiles(root)) {
    let source;
    try {
      source = readFileSync(join(root, rel), "utf8");
    } catch (error) {
      output.error(`timeout ledger: cannot read ${rel}: ${error.message}`);
      return 2;
    }
    const flagged = scanTestTimeouts(source);
    if (flagged.length === 0) continue;
    const at = flagged.map((hit) => `${rel}:${hit.line} (${hit.value} ms)`).join(", ");
    if (!mentioned.has(rel)) {
      errors.push(
        `${rel}: ${flagged.length} sub-default test timeout(s) with no ledger row: ${at}`,
      );
      continue;
    }
    const pinned = pins.get(rel) ?? 0;
    if (pinned === 0) {
      errors.push(`${rel}: ledger row names the file but carries no (N×) count pin: ${at}`);
    } else if (pinned !== flagged.length) {
      errors.push(
        `${rel}: ledger pins ${pinned} timeout(s) but the file holds ${flagged.length}: ${at}`,
      );
    }
  }
  const pretty = errors.sort();
  for (const error of pretty) output.error(`timeout ledger: ${error}`);
  if (pretty.length) {
    output.error(`timeout ledger: ${pretty.length} uncovered file(s).`);
    return 1;
  }
  output.log("timeout ledger: ok.");
  return 0;
}

function selftest() {
  const root = mkdtempSync(
    join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "timeout-ledger-"),
  );
  let cases = 0;
  try {
    const write = (path, content) => {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), content);
    };
    const ledger = (rows) =>
      [
        "# Load-sensitive tests",
        "",
        "## Remaining limits and timing asserts",
        "",
        "| Test | Limit | Why it stays |",
        "| --- | --- | --- |",
        ...rows,
        "",
        "## Other",
        "",
      ].join("\n");
    const check = (name, files, rows, expected, diagnostics = []) => {
      rmSync(join(root, "test"), { recursive: true, force: true });
      for (const [path, content] of Object.entries(files)) write(path, content);
      write(LEDGER_REL, ledger(rows));
      const messages = [];
      const code = checkLedger(root, {
        log() {},
        error(text) {
          messages.push(text);
        },
      });
      assert.equal(code, expected, `${name}: exit ${code}, got ${messages.join("; ")}`);
      for (const diagnostic of diagnostics) {
        assert.ok(
          messages.some((text) => text.includes(diagnostic)),
          `${name}: missing diagnostic ${JSON.stringify(diagnostic)} in ${messages.join("; ")}`,
        );
      }
      cases += 1;
      console.log(`PASS ${name}`);
    };

    check(
      "covered literals pass",
      {
        "test/a.test.ts": 'it("fast", async () => {\n  expect(1).toBe(1);\n}, 10_000);\n',
        "test/b.test.ts": 'it.each([1, 2])(\n  "mode %s",\n  async () => {},\n  3000,\n);\n',
      },
      [
        "| `test/a.test.ts` (1× 10 s) | 10 s per test | Bounds the probe |",
        "| `test/b.test.ts` (1× 3 s) | 3 s per test | Bounds disposal |",
      ],
      0,
    );

    check(
      "uncovered timeout fails with file, line and value",
      { "test/a.test.ts": 'it("fast", async () => {}, 15_000);\n' },
      [],
      1,
      ["test/a.test.ts", "test/a.test.ts:1", "15000"],
    );

    check(
      "count mismatch fails",
      {
        "test/a.test.ts":
          'it("one", async () => {}, 15_000);\nit("two", async () => {}, 15_000);\n',
      },
      ["| `test/a.test.ts` (1× 15 s) | 15 s per test | Bounds both |"],
      1,
      ["pins 1 timeout(s) but the file holds 2"],
    );

    check(
      "named file without a count pin fails",
      { "test/a.test.ts": 'it("fast", async () => {}, 15_000);\n' },
      ["| `test/a.test.ts` | 15 s per test | Bounds the race |"],
      1,
      ["carries no (N×) count pin"],
    );

    check(
      "hooks, helpers and default-scale literals are out of scope",
      {
        "test/a.test.ts": [
          "beforeEach(async () => {}, 15_000);",
          "afterAll(async () => { await sql.end({ timeout: 1 }); });",
          'it("slow", async () => { await new Promise((r) => setTimeout(r, 3000)); }, 30_000);',
          'it("slower", async () => {}, 60_000);',
          'it("polls", async () => { await expect.poll(() => probe(), { timeout: 4000 }); });',
          'it("regex", async () => { expect(s).toMatch(/foo(bar)+/); });',
          "",
        ].join("\n"),
      },
      [],
      0,
    );

    check(
      "regex with parens does not swallow the timeout",
      {
        "test/a.test.ts":
          'it("parens", async () => {\n  expect(s).toMatch(/a(b|c)+\\d/);\n}, 10_000);\n',
      },
      [],
      1,
      ["test/a.test.ts:3", "10000"],
    );

    check(
      "options-form timeout is flagged",
      { "test/a.test.ts": 'it("opt", { timeout: 5000 }, async () => {});\n' },
      [],
      1,
      ["test/a.test.ts:1", "5000"],
    );

    check(
      "trailing-comma timeout forms are flagged",
      {
        "test/a.test.ts": 'it.each(modes)(\n  "mode %s",\n  async () => {},\n  3000,\n);\n',
        "test/b.test.ts": 'it("slow",\n  async () => {},\n  20000,\n);\n',
      },
      [],
      1,
      ["test/a.test.ts:4", "3000", "test/b.test.ts:3", "20000"],
    );

    check(
      "line-anchored cites match by file",
      { "test/a.test.ts": 'it("fast", async () => {}, 20_000);\n' },
      ["| `test/a.test.ts:220` (1× 20 s) | 20 s per test | Bounds the replay |"],
      0,
    );

    cases += 1;
    console.log("PASS timeout ledger selftest suite");
    console.log(`timeout ledger selftest: ${cases} cases passed.`);
    return 0;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length > 3 || (process.argv[2] && process.argv[2] !== "--selftest")) {
    console.error("Usage: node ci/check-test-timeout-ledger.mjs [--selftest]");
    process.exitCode = 2;
  } else if (process.argv[2] === "--selftest") {
    process.exitCode = selftest();
  } else {
    process.exitCode = checkLedger(repoRoot);
  }
}
