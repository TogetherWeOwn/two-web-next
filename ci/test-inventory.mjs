// CI-inventory check (HARD): every *.test.ts / *.test.mjs must be reachable
// from a CI job. A test file nobody runs is worse than no test: it claims
// coverage the suite never verifies.
//
// Reachability rules (vitest.config.ts + package.json + workflows):
// - test/** matches the vitest `include` globs, except the files the config
//   `exclude`s (parsed live from vitest.config.ts, never mirrored by hand:
//   literals plus `*`/`**` globs expanded against the files on disk; any
//   other glob magic or non-canonical paths fail loudly instead of reading
//   as reachable; matches on ancestor directories prune their descendants).
//   An excluded file runs via `npm run test:smoke` instead, and counts as
//   reachable only while that command still names it (a mention anywhere
//   else is not a run).
// - tier0/** matches the Tier-0 config (`tier0/vitest.config.ts`, run via
//   `npm run test:tier0`); reachable only while that wiring names it.
// - ci/** and e2e/** have no glob runner: each file must be named in a
//   package.json script or a .github/workflows/*.yml step.
// - Non-*.test.* files are fixtures, not tests.
//
// Modes: default prints ::warning:: per orphan and exits 0 (triage runs).
// --strict exits 1 on any orphan; CI runs --strict (HARD).
// --root <dir> checks that tree instead of the repo (triage, selftest).
// --json prints the Playwright summary as one JSON object (checkId, code,
// orphans, next_action) instead of human lines; the exit code still reflects
// every gate under --strict.
// --selftest runs the fixture suite below and exits 0/1 on pass/fail.
import {
  readdirSync,
  readFileSync,
  existsSync,
  statSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { parseDocument, visit, isScalar } from "yaml";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VITEST_TEST_DIRS = ["test"];

// Keep two offset-aligned views: comments become whitespace in both, and
// quoted strings become whitespace only in `code`. Key/bracket discovery
// uses code; the entry parser gets the original strings without comments.
// This also prevents removing a comment from joining two separate tokens.
function excludeArrayBody(text, configPath) {
  let clean = "";
  let code = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      clean += c;
      code += " ";
      if (c === "\\" && i + 1 < text.length) {
        clean += text[++i];
        code += " ";
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      let end;
      if (text[i + 1] === "/") {
        end = i + 2;
        while (end < text.length && ![10, 13, 0x2028, 0x2029].includes(text.charCodeAt(end)))
          end += 1;
      } else {
        const close = text.indexOf("*/", i + 2);
        assert.ok(close !== -1, `${configPath} exclude block has an unclosed comment`);
        end = close + 2;
      }
      const blank = " ".repeat(end - i);
      clean += blank;
      code += blank;
      i = end - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      clean += c;
      code += " ";
    } else {
      clean += c;
      code += c;
    }
  }
  assert.ok(quote === null, `${configPath} has an unclosed string`);
  const keys = [...code.matchAll(/\bexclude\s*:/g)];
  assert.equal(keys.length, 1, `${configPath} must have exactly one unquoted exclude block`);
  const start = keys[0].index + keys[0][0].length;
  const gap = code.slice(start).match(/^\s*/)[0].length;
  const open = start + gap;
  assert.equal(code[open], "[", `${configPath} exclude block must be an array`);
  let depth = 1;
  for (let i = open + 1; i < code.length; i += 1) {
    if (code[i] === "[") depth += 1;
    else if (code[i] === "]") depth -= 1;
    if (depth === 0) return clean.slice(open + 1, i);
  }
  assert.fail(`${configPath} exclude block never closes`);
}

// Consume complete comma-separated entries, not just quoted substrings:
// concatenation, variables, calls and unknown spreads can exclude files too.
// Only plain strings (no escapes/interpolation) and the known defaults spread
// are supported; everything else fails closed instead of hiding an orphan.
function rawVitestExcludes(root) {
  const configPath = join(root, "vitest.config.ts");
  if (!existsSync(configPath)) return [];
  const text = readFileSync(configPath, "utf8");
  let rest = excludeArrayBody(text, configPath).trim();
  const entries = [];
  const error = `${configPath} has an exclude this gate cannot parse: use plain strings or ...configDefaults.exclude`;
  while (rest) {
    const literal = rest.match(/^(['"`])([^\\\r\n]*?)\1/);
    const token = literal ?? rest.match(/^\.\.\.\s*configDefaults\s*\.\s*exclude\b/);
    assert.ok(token, error);
    rest = rest.slice(token[0].length).trimStart();
    assert.ok(!rest || rest.startsWith(","), error);
    if (literal) entries.push(literal[2]);
    rest = rest.slice(1).trimStart();
  }
  return entries;
}

// Fail closed on exclude entries this gate cannot expand. Vitest honors the
// full picomatch grammar (`?`, braces, character classes, negation,
// extglobs), while globToRegExp understands only `*`/`**`: an unexpanded
// entry would read as vitest-reachable although nothing runs it. A denylist
// of magic characters keeps missing forms, so this is an allowlist of
// exactly the grammar globToRegExp expands (word characters, dash, dot,
// slash, star). Crash loudly instead, like the missing-exclude asserts
// above, so the author rewrites the entry as a literal or a `*`/`**` glob
// (or teaches this gate the new form).
function assertSupportedExcludes(entries, root) {
  for (const e of entries) {
    assert.ok(
      /^[\w\-./*]+$/.test(e),
      `${join(root, "vitest.config.ts")} has an exclude this gate cannot expand (${e}): use a literal or a * / ** glob`,
    );
    // tinyglobby normalizes patterns before matching. Rather than partially
    // reimplement normalization (especially around glob/.. segments), reject
    // non-canonical spellings before either literal or glob expansion.
    assert.ok(
      e.split("/").every((part) => part && part !== "." && part !== ".."),
      `${join(root, "vitest.config.ts")} has a non-canonical exclude (${e}): use root-relative paths without empty, . or .. segments`,
    );
  }
}

// The test/** files vitest skips, derived from the live exclude array.
// tinyglobby prunes directories matching an ignore pattern, so literals
// and globs must match both the file and each ancestor directory. Entries
// matching nothing (node_modules, dist) expand to the empty set.
export function vitestExcludedTests(root = repoRoot) {
  const entries = rawVitestExcludes(root);
  assertSupportedExcludes(entries, root);
  const patterns = entries.map(globToRegExp);
  return new Set(
    listTestFiles(root, "test").filter((file) => {
      const parts = file.split("/");
      while (parts.length) {
        const path = parts.join("/");
        if (patterns.some((pattern) => pattern.test(path))) return true;
        parts.pop();
      }
      return false;
    }),
  );
}

function listTestFiles(root, dir) {
  const out = [];
  const walk = (d) => {
    for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
      const rel = join(d, e.name);
      if (e.isDirectory()) walk(rel);
      else if (/\.test\.(ts|mjs)$/.test(e.name)) out.push(rel.replaceAll("\\", "/"));
    }
  };
  if (existsSync(join(root, dir))) walk(dir);
  return out;
}

function collectHaystack(root) {
  const parts = [];
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  parts.push(Object.values(pkg.scripts ?? {}).join("\n"));
  const wfDir = join(root, ".github", "workflows");
  if (existsSync(wfDir)) {
    for (const e of readdirSync(wfDir)) {
      if (e.endsWith(".yml") || e.endsWith(".yaml"))
        parts.push(readFileSync(join(wfDir, e), "utf8"));
    }
  }
  return parts.join("\n");
}

// A file outside test/ is reachable when some script or workflow step names
// its full relative path, or a `*`-glob covering it (e.g. the check job runs
// `node --test ci/a11y-*.test.mjs`, which covers the whole a11y family).
function globToRegExp(glob) {
  // `*` stays inside one path segment, `**` crosses directories (`**/`
  // also matches zero directories, so `test/**` covers `test/a.test.ts`).
  let out = "";
  for (let i = 0; i < glob.length; ) {
    if (glob.startsWith("**/", i)) {
      out += "(.*/)?";
      i += 3;
    } else if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else {
      out += /[.+^${}()|[\]\\]/.test(glob[i]) ? `\\${glob[i]}` : glob[i];
      i += 1;
    }
  }
  return new RegExp(`^${out}$`);
}

function referencedInCi(file, haystack) {
  if (haystack.includes(file)) return true;
  const tokens = haystack.match(/[A-Za-z0-9_./-]*\*[^ \t\n"'`]*\.test\.mjs/g) ?? [];
  return tokens.some((t) => globToRegExp(t).test(file));
}

// The exact command CI runs for vitest-excluded suites. A smokeExcluded file
// is reachable only when THIS command names it: a mention in any other
// script, or in a workflow comment, is not a run.
function smokeCommand(root) {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  return pkg.scripts?.["test:smoke"] ?? "";
}

// Playwright spec reachability (HARD): every e2e/**/*.spec.ts and
// e2e/**/*.visual.ts must run somewhere in CI. A spec nobody runs claims
// coverage the suite never verifies — the same failure mode as an orphaned
// *.test.* file, but through Playwright's testDir/testMatch/testIgnore
// selection instead of vitest's.
//
// Reachability rules (workflows + invoked scripts + configs, all parsed live):
// - A Playwright config is CI-referenced when a workflow step or a
//   transitively workflow-invoked package.json script runs `playwright test`
//   with `--config <path>` naming it, or runs bare `playwright test` (the
//   default playwright.config.ts). Unused scripts do not count: an
//   `e2e:kit-parity` script naming the kit-parity config without filters
//   must not mark it unfiltered when CI only ever runs that config with
//   explicit file filters — counting unused scripts would hide orphans.
// - A spec is directly reachable when it sits under a CI-referenced
//   config's testDir, matches that config's testMatch, matches no
//   testIgnore, and survives the config's CLI file filters (when every CI
//   invocation of the config names files, only those files run; a single
//   unfiltered invocation runs every match). Project-level
//   testDir/testMatch/testIgnore override the top level for that project; a
//   file matching any project runs.
// - A spec is indirectly reachable when a reachable spec imports it,
//   transitively through relative ESM/CJS static imports (the Kit visual
//   entrypoint imports its member-board-viewer suite this way). Edges are
//   side-effect imports, re-exports and require calls: named import
//   bindings of a spec fail closed, because Playwright's Babel elides
//   bindings never used as values and the gate cannot verify usage.
//
// Config parsing is static and fail-closed, like the vitest exclude parser
// above: plain string literals (or arrays of them) for
// testDir/testMatch/testIgnore, single-level `{a,b}` brace expansion,
// `...base` spreads that resolve to a default-imported relative config, and
// per-project overrides. RegExp testMatch, unknown `playwright test` flags
// and non-canonical paths crash loudly instead of reading as reachable;
// dynamic import specifiers are ignored as edges (a spec reachable only
// through one is reported as an orphan).
const PLAYWRIGHT_CHECK_ID = "playwright-spec-reachability";
const PLAYWRIGHT_CODE_OK = "OK";
const PLAYWRIGHT_CODE_ORPHAN = "PLAYWRIGHT_SPEC_ORPHAN";
const PLAYWRIGHT_NEXT_ACTION_OK = "No action needed: every Playwright spec is reachable from CI.";
const PLAYWRIGHT_NEXT_ACTION_ORPHAN =
  "Add each orphan to a CI Playwright config's testDir/testMatch (or a workflow file filter), or import it from a reachable spec; see docs/quality-gates.md Test inventory.";

function listPlaywrightSpecs(root) {
  const out = [];
  const walk = (d) => {
    const abs = join(root, d);
    if (!existsSync(abs)) return;
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const rel = join(d, e.name).replaceAll("\\", "/");
      if (e.isDirectory()) walk(rel);
      else if (/\.spec\.ts$/.test(e.name) || /\.visual\.ts$/.test(e.name)) out.push(rel);
    }
  };
  walk("e2e");
  return [...new Set(out)].sort();
}

// Let YAML decode run scalars before any shell scan: folded, plain and
// quoted multiline values can all join a script name or forwarded arguments
// across physical lines. Re-express each decoded value as a literal block so
// every existing scanner sees the same shell text and step/default ancestry.
// Only this in-memory view changes; files on disk remain untouched.
function workflowShellView(text, name) {
  const doc = parseDocument(text);
  assert.equal(doc.errors.length, 0, `${name} is not valid YAML: ${doc.errors[0]?.message}`);
  const edits = [];
  visit(doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== "run" || !isScalar(pair.value)) return;
      const node = pair.value;
      if (typeof node.value !== "string") return;
      const lineStart = text.lastIndexOf("\n", pair.key.range[0] - 1) + 1;
      const indent = " ".repeat(pair.key.range[0] - lineStart + 2);
      // Chomping does not affect command arguments; retain internal newlines,
      // including blank lines and more-indented folded content, exactly.
      const script = node.value.replace(/\n+$/, "");
      // Explicit indentation prevents a more-indented first shell command
      // from setting the YAML block threshold above subsequent commands.
      const replacement = `|2\n${script
        .split("\n")
        .map((line) => `${indent}${line}`)
        .join("\n")}\n`;
      edits.push({ start: node.range[0], end: node.range[2], replacement });
    },
  });
  for (const { start, end, replacement } of edits.sort((a, b) => b.start - a.start))
    text = text.slice(0, start) + replacement + text.slice(end);
  return text;
}

function collectWorkflowFiles(root) {
  const out = [];
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return out;
  for (const e of readdirSync(wfDir)) {
    if (e.endsWith(".yml") || e.endsWith(".yaml")) {
      const name = `.github/workflows/${e}`;
      out.push({ name, text: workflowShellView(readFileSync(join(wfDir, e), "utf8"), name) });
    }
  }
  return out;
}

// Script names CI actually runs, transitively: a workflow `npm run a` marks
// `a` invoked, and `a`'s own `npm run b` marks `b`. Anything else in
// package.json is a local helper, not a CI run. Workflow text is scanned
// comment-stripped (a commented-out step is not a run). Occurrences are
// tokenized, not regex-matched, because npm config flags sit around the
// script name: `npm run b --silent -- x` and `npm run --silent b` both run
// `b`, and a bare `--` after any flags still forwards file filters. An
// `npm run` with forwarded arguments fails closed when the target runs
// `playwright test` (the gate cannot expand forwarded file filters) —
// whether the forwarding sits in the workflow or in an invoked script body
// (`"a": "npm run b -- e2e/x.spec.ts"` is the same filter). Forwarding is
// any post-name positional, not just `--`: oracle shows npm forwards bare
// positionals (`npm run b e2e/x.spec.ts`) while the shell strips output
// redirection first (`2>/dev/null` never reaches npm), so redirect operators
// and their targets are skipped. Past the first bare `--` npm forwards
// everything literally, so later `--prefix` forms are filters, not
// redirects. `--prefix` and `--workspace`/`-w` before any `--` redirect the
// run into another package directory, which the gate cannot model, so they
// fail closed on Playwright targets too (the live `npm run check --prefix
// web` idiom targets non-Playwright scripts and stays green); `--prefix=.`
// is the same directory and is allowed. Bundled short flags (`-sw`) and
// other unmodelable tokens fail closed when the target could run Playwright.
// A workflow step that runs Playwright (directly, or via `npm run`) must run
// at the repo root: `working-directory:` (step level or an inherited job or
// workflow `defaults:`) and the step's own `cd` resolve configs, filters and
// (for npm) the script itself against another directory, so anything but a
// provable root fails closed.

// npm config flags that consume the following token as their value when
// written without `=` (oracle: npm 11.19.1; `--prefix web b` reads package
// json from web/, `--omit dev b` and `--include dev b` run b). Names
// normalize like npm's parser (dash/case-insensitive), so `--log-level`
// matches `loglevel`. Every other well-formed `--flag` is boolean: npm
// leaves the next token alone (oracle: `--bogus b` and `--workspaces b`
// never consume b; the latter fails on workspaces, not on scripts). `-w`
// is npm's only value-taking short flag.
const NPM_RUN_VALUE_FLAGS = new Set([
  "prefix",
  "workspace",
  "scriptshell",
  "loglevel",
  "cache",
  "userconfig",
  "location",
  "registry",
  "omit",
  "include",
]);

function npmFlagKind(token) {
  if (token === "--") return "sep";
  if (token === "-") return "other";
  if (token.startsWith("--")) {
    const body = token.slice(2);
    if (body === "" || body.startsWith("=")) return "unknown";
    if (body.includes("=")) return "flag";
    const norm = body.replace(/-/g, "").toLowerCase();
    return NPM_RUN_VALUE_FLAGS.has(norm) ? "value" : "flag";
  }
  if (token.startsWith("-") && token.length > 1) {
    const body = token.slice(1);
    if (/^[A-Za-z]$/.test(body)) return body === "w" ? "value" : "flag";
    return "unknown";
  }
  return "other";
}

// Split shell text into tokens: whitespace-separated, cut at the first
// unquoted `&`/`|`/`;` (a chained command is a separate occurrence), quotes
// stripped. An unterminated quote runs to the cut, which can only add a
// spurious token, never hide a `--` (loud, never a silent miss).
function splitShellTokens(segment) {
  const tokens = [];
  let cur = "";
  let quote = null;
  const push = () => {
    if (cur !== "") tokens.push(cur);
    cur = "";
  };
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "&" || c === "|" || c === ";") {
      break;
    } else if (/\s/.test(c)) {
      push();
    } else {
      cur += c;
    }
  }
  push();
  return tokens;
}

// Every `npm run ...` occurrence in shell text: the script name npm resolves
// (first non-flag token, with value-flags consuming the next), whether a
// bare `--` after the name forwards arguments, whether `--prefix` or
// `--workspace`/`-w` redirects into another package directory, and whether
// an unmodelable token makes the parse uncertain. Backslash-newline
// continuations join first (the shell removes them), so a `--` on the next
// line still counts. A bare `--` before the name is skipped: oracle shows
// `npm run -- b` still runs b.
function parseNpmRunOccurrences(text) {
  const out = [];
  const joined = text.replace(/\\\r?\n/g, " ");
  for (const m of joined.matchAll(/\bnpm\s+run(?:-script)?\b/g)) {
    const lineEnd = joined.indexOf("\n", m.index);
    const segment = joined.slice(m.index + m[0].length, lineEnd === -1 ? undefined : lineEnd);
    const tokens = splitShellTokens(segment);
    const kinds = tokens.map(npmFlagKind);
    let name = null;
    let forwarding = false;
    let redirect = null;
    let unknown = false;
    const redirectAt = (idx) => {
      let flag = tokens[idx];
      let value;
      const eq = flag.indexOf("=");
      if (eq !== -1) {
        value = flag.slice(eq + 1);
        flag = flag.slice(0, eq);
      } else if (idx + 1 < tokens.length && tokens[idx + 1] !== "--") {
        value = tokens[idx + 1];
      }
      let norm = flag.replace(/^-+/, "").replace(/-/g, "").toLowerCase();
      if (norm === "w") norm = "workspace";
      if (norm !== "prefix" && norm !== "workspace") return;
      if (norm === "prefix" && (value === "." || value === "./")) return;
      redirect = { flag, value };
    };
    let i = 0;
    for (; i < tokens.length; i++) {
      const kind = kinds[i];
      if (kind === "other") {
        name = tokens[i];
        i++;
        break;
      }
      if (kind === "sep") continue;
      if (kind === "unknown") {
        unknown = true;
        continue;
      }
      if (kind === "value") {
        redirectAt(i);
        i++;
      }
    }
    // Past the name, any positional forwards (oracle: npm 11.19.1 passes
    // bare positionals to the script; boolean flags consume nothing). Shell
    // redirection never reaches npm, so operators and their targets are
    // skipped; past the first bare `--` everything is a literal forwarded
    // argument, never a redirect. Post-name unmodelable tokens stay ignored:
    // oracle shows npm either errors loudly (`-sw`, exit 1) or warns and
    // runs clean with no forwarding and no redirect (`-wweb`, `-x=y`).
    let seenSep = false;
    for (; i < tokens.length; i++) {
      if (kinds[i] === "sep") {
        forwarding = true;
        seenSep = true;
      } else if (seenSep) {
        continue;
      } else if (kinds[i] === "value") {
        redirectAt(i);
        i++;
      } else if (/^\d*[<>]/.test(tokens[i])) {
        if (/^\d*[<>]+$/.test(tokens[i])) i++; // bare operator: skip its target
      } else if (kinds[i] === "other") {
        forwarding = true;
      }
    }
    out.push({ name, forwarding, redirect, unknown, index: m.index });
  }
  return out;
}

// Whether a script reaches `playwright test`, directly or through nested
// `npm run` occurrences. `unknown` is set when a nested occurrence has an
// unmodelable token, so its target is uncertain: callers fail closed on
// unknown instead of reading it as clean.
function scriptRunsPlaywright(scripts, name, seen = new Set()) {
  if (seen.has(name)) return { runs: false, unknown: false };
  seen.add(name);
  const body = scripts[name] ?? "";
  if (/\bplaywright\s+test\b/.test(body)) return { runs: true, unknown: false };
  let unknown = false;
  for (const occ of parseNpmRunOccurrences(body)) {
    if (occ.name === null || !Object.hasOwn(scripts, occ.name)) continue;
    const nested = scriptRunsPlaywright(scripts, occ.name, seen);
    if (nested.runs) return { runs: true, unknown: false };
    if (occ.unknown || nested.unknown) unknown = true;
  }
  return { runs: false, unknown };
}

function invokedScriptNames(scripts, workflowText) {
  const invoked = new Set();
  const queue = [];
  const scan = (text, where) => {
    for (const occ of parseNpmRunOccurrences(text)) {
      if (occ.name === null || !Object.hasOwn(scripts, occ.name)) continue;
      if (occ.unknown) {
        const target = scriptRunsPlaywright(scripts, occ.name);
        if (target.runs || target.unknown) {
          assert.fail(
            `CI runs ${where} with an npm flag form this gate cannot parse (npm run ... ${occ.name} ...): bundled short flags and -x=y forms hide the script name; use one flag per token or teach ci/test-inventory.mjs the new form`,
          );
        }
      }
      if (!invoked.has(occ.name)) {
        invoked.add(occ.name);
        queue.push(occ.name);
      }
    }
  };
  const stripped = workflowText.split("\n").map(stripYamlComment).join("\n");
  scan(stripped, "a workflow step");
  while (queue.length) {
    const next = queue.shift();
    scan(scripts[next] ?? "", `script "${next}"`);
  }
  const forwardSources = [
    [stripped, "a workflow step"],
    ...[...invoked].map((n) => [scripts[n] ?? "", `script "${n}"`]),
  ];
  for (const [text, where] of forwardSources) {
    for (const occ of parseNpmRunOccurrences(text)) {
      if (occ.name === null || !Object.hasOwn(scripts, occ.name)) continue;
      const target = scriptRunsPlaywright(scripts, occ.name);
      if (occ.redirect && (target.runs || target.unknown)) {
        assert.fail(
          `CI runs ${where} with ${occ.redirect.flag} (npm run ... ${occ.name}): this gate cannot model cross-directory npm runs; run the package's own script graph or teach ci/test-inventory.mjs the new form`,
        );
      }
      if (occ.forwarding) {
        if (target.runs) {
          assert.fail(
            `CI forwards arguments to ${occ.name} (npm run ${occ.name} <forwarded args>): this gate cannot expand forwarded playwright filters; invoke playwright test directly or teach ci/test-inventory.mjs the new form`,
          );
        }
        if (target.unknown) {
          assert.fail(
            `CI forwards arguments to ${occ.name} (npm run ${occ.name} <forwarded args>) and this gate cannot determine whether it runs playwright (unknown npm flag form in its script graph); disambiguate the flags or teach ci/test-inventory.mjs the new form`,
          );
        }
      }
    }
  }
  return invoked;
}

function stripYamlComment(line) {
  if (/^\s*#/.test(line)) return "";
  const hash = line.indexOf(" #");
  return hash === -1 ? line : line.slice(0, hash);
}

// A workflow file's `run: |` script lines: literal blocks are shell, not YAML
// keys, so structural scans skip them (a heredoc can hold `- ` or
// `working-directory:` lines that mean nothing to Actions) while the `cd`
// scan reads only them. `run: ">"` and `run: foo | bar` are inline values,
// not blocks, and never match.
function literalScriptLines(lines) {
  const content = new Set();
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)(-\s+)?run\s*:\s*[|>]([1-9])?.*$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length + (m[2]?.length ?? 0);
    // Honor explicit indentation relative to the mapping key, including a
    // same-line sequence marker. Otherwise YAML detects it from the first
    // content line. A more-indented first command must not hide later lines.
    let threshold = m[3] ? indent + Number(m[3]) : null;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === "") continue;
      if (threshold === null) {
        if (indentOf(lines[j]) <= indent) break; // empty block
        threshold = indentOf(lines[j]);
      }
      if (indentOf(lines[j]) < threshold) break;
      content.add(j);
    }
  }
  return content;
}

function indentOf(line) {
  return /^\s*/.exec(line)[0].length;
}

// First non-blank line at or above `indent`, starting at `from`.
function blockEnd(lines, from, indent) {
  let end = from;
  while (end < lines.length) {
    if (lines[end].trim() !== "") {
      if (indentOf(lines[end]) <= indent) break;
    }
    end += 1;
  }
  return end;
}

// Step items GitHub Actions allows: only these shapes open a step block, so
// a `- ` shell or heredoc line never mis-attributes one.
const STEP_ITEM_RE =
  /^\s*-\s*($|run\s*:|name\s*:|uses\s*:|id\s*:|if\s*:|working-directory\s*:|shell\s*:|env\s*:|with\s*:|continue-on-error\s*:|timeout-minutes\s*:)/;

// The step block containing lines[idx]: step keys above and below `run:` (a
// `working-directory:` may follow the command), bounded by indentation.
// Null when no step item opens above the line.
function stepBlockBounds(lines, idx, content) {
  let start;
  if (!content.has(idx) && STEP_ITEM_RE.test(lines[idx])) start = idx;
  else {
    const occIndent = indentOf(lines[idx]);
    start = idx - 1;
    while (
      start >= 0 &&
      (content.has(start) ||
        !STEP_ITEM_RE.test(lines[start]) ||
        indentOf(lines[start]) >= occIndent)
    )
      start -= 1;
    if (start < 0) return null;
  }
  return { start, end: blockEnd(lines, idx + 1, indentOf(lines[start])) };
}

// The job block enclosing a step: hop from the step to its `steps:` list,
// then to the job id, verified as a direct child of `jobs:`. Null when the
// ancestry is not a normal job (failing closed at the caller).
function jobBlockBounds(lines, stepStart, stepIndent, content) {
  let list = stepStart - 1;
  while (
    list >= 0 &&
    (content.has(list) ||
      indentOf(lines[list]) >= stepIndent ||
      !/^\s*steps\s*:\s*(#.*)?$/.test(lines[list]))
  )
    list -= 1;
  if (list < 0) return null;
  const listIndent = indentOf(lines[list]);
  let job = list - 1;
  while (
    job >= 0 &&
    (content.has(job) ||
      lines[job].trim() === "" ||
      indentOf(lines[job]) >= listIndent ||
      /^\s*-/.test(lines[job]) ||
      !/^\s*\S[^:]*:\s*(#.*)?$/.test(lines[job]))
  )
    job -= 1;
  if (job < 0) return null;
  const jobIndent = indentOf(lines[job]);
  let jobs = job - 1;
  while (
    jobs >= 0 &&
    (content.has(jobs) || lines[jobs].trim() === "" || indentOf(lines[jobs]) >= jobIndent)
  )
    jobs -= 1;
  if (jobs < 0 || !/^\s*jobs\s*:\s*(#.*)?$/.test(lines[jobs])) return null;
  return { start: job, end: blockEnd(lines, job + 1, jobIndent) };
}

// Nearest structural line above idx (skipping blanks and run-script
// content): the parent key, or -1 at the top level.
function parentLine(lines, idx, content) {
  const indent = indentOf(lines[idx]);
  let p = idx - 1;
  while (p >= 0 && (lines[p].trim() === "" || content.has(p) || indentOf(lines[p]) >= indent))
    p -= 1;
  return p;
}

// `key:` lines in [from, to) whose parent is parentIdx (-1 for top level).
function childKeys(lines, from, to, parentIdx, key, content) {
  const found = [];
  const re = new RegExp(`^\\s*${key}\\s*:(.*)$`);
  for (let i = from; i < to; i++) {
    if (content.has(i)) continue;
    const m = re.exec(lines[i]);
    if (!m) continue;
    if (parentLine(lines, i, content) !== parentIdx) continue;
    found.push({ idx: i, rest: m[1] });
  }
  return found;
}

// `working-directory:` values that still mean the repo root (mirrors the
// `--prefix=.` exemption: `.` is the same directory, not a redirect).
function isRootCwd(value) {
  const v = value
    .trim()
    .replace(/^(['"])([\s\S]*)\1$/, "$2")
    .trim();
  return (
    v === "." || v === "./" || v === "${{ github.workspace }}" || v === "${{ github.workspace }}/"
  );
}

// `working-directory:` under a `defaults:` key parented at parentIdx: the
// `defaults: { run: { working-directory: X } }` chain. Inline flow values
// fail closed only when they carry working-directory (a `shell:`-only flow
// changes nothing about the directory).
function defaultsCwdAt(lines, from, to, parentIdx, content, where, tail) {
  for (const d of childKeys(lines, from, to, parentIdx, "defaults", content)) {
    const rest = d.rest.trim();
    if (rest !== "") {
      if (!rest.includes("working-directory")) continue;
      assert.fail(`${where} uses an inline \`defaults:\` carrying working-directory: ${tail}`);
    }
    for (const r of childKeys(lines, d.idx + 1, to, d.idx, "run", content)) {
      const rRest = r.rest.trim();
      if (rRest !== "") {
        if (!rRest.includes("working-directory")) continue;
        assert.fail(
          `${where} uses an inline \`run:\` under \`defaults:\` carrying working-directory: ${tail}`,
        );
      }
      for (const w of childKeys(lines, r.idx + 1, to, r.idx, "working-directory", content)) {
        return w.rest.trim();
      }
    }
  }
  return null;
}

// `run:` script slices of a step block: the inline command plus literal-block
// content lines. Each slice is scanned from `from` (past the `run:` key).
function stepScriptSlices(lines, start, end, content) {
  const slices = [];
  for (let i = start; i < end; i++) {
    if (content.has(i)) {
      slices.push({ idx: i, from: 0 });
      continue;
    }
    const m = /^\s*(?:-\s+)?run\s*:\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    if (/^[|>][1-9]?[+-]?\s*(#.*)?$/.test(m[1])) continue; // block header: no script here
    slices.push({ idx: i, from: lines[i].length - m[1].length });
  }
  return slices;
}

// Read whole shell words, including empty/concatenated quoted assignment
// values and escaped spaces. Quoted separators are data, not command starts.
const CWD_SHELL_WORD_RE = /(?:[^\s;&|()'"`\\]+|'[^']*'|"(?:\\.|[^"\\])*"|`(?:\\.|[^`\\])*`|\\.)+/y;

// Only recognize cwd commands and their prefixes, not arbitrary shell code.
// Repeated command/builtin wrappers still run in the same shell. Reject cwd
// changes conservatively even if a branch might not execute.
function shellChangesCwd(line) {
  let commandStart = true;
  let options = null;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (";&|(){}".includes(c)) {
      commandStart = c !== "(" || line[i - 1] !== "$";
      options = null;
      i++;
      continue;
    }
    CWD_SHELL_WORD_RE.lastIndex = i;
    const match = CWD_SHELL_WORD_RE.exec(line);
    if (!match) {
      i++;
      continue;
    }
    i = CWD_SHELL_WORD_RE.lastIndex;
    if (!commandStart) continue;
    const raw = match[0];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(raw)) continue;
    const word = raw.replace(
      /\\(.)|'([^']*)'|"((?:\\.|[^"\\])*)"/g,
      (_match, escaped, single, double) =>
        escaped ?? single ?? double.replace(/\\([$`"\\])/g, "$1"),
    );
    if (/^(?:if|then|elif|else|do|while|until|!|time)$/.test(word)) {
      options = word === "time" ? "time" : null;
      continue;
    }
    if (word === "command" || word === "builtin") {
      options = word;
      continue;
    }
    if (options && (word === "--" || (options !== "builtin" && /^-p+$/.test(word)))) {
      if (word === "--") options = null;
      continue;
    }
    if (word === "cd" || word === "pushd" || word === "popd") return true;
    commandStart = false;
    options = null;
  }
  return false;
}
const ROOT_CWD_REMEDIATION =
  "this gate cannot resolve playwright runs outside the repo root; run the step or script at the root or teach ci/test-inventory.mjs the new form";

// Heredoc opener (`<<EOF`, `<<'EOF'`, `<<-EOF`): body lines up to the marker
// are data, so a bare `cd` line inside one is not a directory change. The
// `<<` must sit outside quotes (`<<<` herestrings are single-line and never
// match); the marker itself may be quoted.
function heredocMarker(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === "\\" && quote !== "'") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "<" && line[i + 1] === "<" && line[i + 2] !== "<") {
      const m = /^<<-?\s*\\?['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/.exec(line.slice(i));
      return m ? m[1] : null;
    }
  }
  return null;
}

// Apply the same cwd guard to workflow shells and package scripts. Only the
// prefix before an invocation matters. Heredoc data and command substitutions
// do not move the caller; directory-stack builtins do, just like cd.
function assertRootShellCwd(prefix, where) {
  let heredoc = null;
  for (const line of prefix.replace(/\\\r?\n/g, " ").split("\n")) {
    if (heredoc !== null) {
      if (line.trim() === heredoc) heredoc = null;
      continue;
    }
    assert.ok(
      !shellChangesCwd(line),
      `${where} runs after a shell directory change: ${ROOT_CWD_REMEDIATION}`,
    );
    heredoc = heredocMarker(line);
  }
}

// A workflow Playwright execution runs where its step says: the step's own
// `working-directory:`, else the job's `defaults:`, else the workflow's
// `defaults:`, else the repo root — unless the step's shell `cd`s first. An
// explicit root (`.` or the workspace) overrides any defaults. Anything but
// a provable root fails closed: anywhere else npm resolves another
// package.json and playwright resolves other configs. Multiline quoted
// strings are not tracked: a bare `cd` line inside one fails closed (rewrite
// it or teach the gate).
function assertRootStepCwd(ctx, idx, at, what) {
  const { file, lines, content } = ctx;
  const where = `${file} runs ${what}`;
  const tail = ROOT_CWD_REMEDIATION;
  const step = stepBlockBounds(lines, idx, content);
  assert.ok(step, `${where} outside any run step: ${tail}`);
  let stepValue = null;
  for (let k = step.start; k < step.end; k++) {
    if (content.has(k)) continue;
    const m = /^\s*working-directory\s*:\s*(.+?)\s*(#.*)?$/.exec(lines[k]);
    if (m) stepValue = m[1];
  }
  if (stepValue !== null) {
    assert.ok(
      isRootCwd(stepValue),
      `${where} sets working-directory: ${stepValue.trim()}: ${tail}`,
    );
  } else {
    const job = jobBlockBounds(lines, step.start, indentOf(lines[step.start]), content);
    assert.ok(job, `${where} sits outside any job: ${tail}`);
    const jobCwd = defaultsCwdAt(lines, job.start, job.end, job.start, content, where, tail);
    if (jobCwd !== null) {
      assert.ok(
        isRootCwd(jobCwd),
        `${where} inherits working-directory: ${jobCwd} from job defaults: ${tail}`,
      );
    } else {
      const topCwd = defaultsCwdAt(lines, 0, lines.length, -1, content, where, tail);
      if (topCwd !== null) {
        assert.ok(
          isRootCwd(topCwd),
          `${where} inherits working-directory: ${topCwd} from workflow defaults: ${tail}`,
        );
      }
    }
  }
  const prefix = stepScriptSlices(lines, step.start, step.end, content)
    .filter(({ idx: sIdx }) => sIdx <= idx)
    .map(({ idx: sIdx, from }) => lines[sIdx].slice(from, sIdx === idx ? at : undefined))
    .join("\n");
  assertRootShellCwd(prefix, where);
}

// Workflow `npm run` occurrences that reach a Playwright script must run at
// the repo root: anywhere else npm resolves another package.json. The
// invocation scan is whole-text, so this re-scans per line for attribution
// (the script name sits on the occurrence's first line; continuations only
// add arguments, which the forwarding check already covers).
function auditWorkflowNpmRunCwd(workflowFiles, scripts) {
  for (const { name, text } of workflowFiles) {
    const lines = text.split("\n").map(stripYamlComment);
    if (!lines.some((l) => l.includes("npm") && l.includes("run"))) continue;
    const ctx = { file: name, lines, content: literalScriptLines(lines) };
    lines.forEach((line, idx) => {
      for (const occ of parseNpmRunOccurrences(line)) {
        if (occ.name === null || !Object.hasOwn(scripts, occ.name)) continue;
        const target = scriptRunsPlaywright(scripts, occ.name);
        if (!target.runs && !target.unknown) continue;
        assertRootStepCwd(ctx, idx, occ.index, `npm run ${occ.name}`);
      }
    });
  }
}

// npm starts each package script in its own shell. A cwd change inside that
// shell can narrow a direct Playwright run or redirect a nested npm run, even
// though the workflow step itself still runs at the root. Audit only scripts
// CI invokes and only prefixes of commands that can reach Playwright.
function auditScriptCwd(scripts, invoked) {
  for (const name of invoked) {
    const body = (scripts[name] ?? "").replace(/\\\r?\n/g, " ");
    for (const match of body.matchAll(/\bplaywright\s+test\b/g))
      assertRootShellCwd(body.slice(0, match.index), `script "${name}" runs playwright test`);
    for (const occ of parseNpmRunOccurrences(body)) {
      if (occ.name === null || !Object.hasOwn(scripts, occ.name)) continue;
      const target = scriptRunsPlaywright(scripts, occ.name);
      if (target.runs || target.unknown)
        assertRootShellCwd(body.slice(0, occ.index), `script "${name}" runs npm run ${occ.name}`);
    }
  }
}

// Split an argument string on whitespace, respecting single/double quotes.
// Anything fancier (escapes, nested quotes) fails closed: the invocation is
// rewritten as plain tokens or the gate learns the new form.
function tokenizeArgs(text, source) {
  const tokens = text.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens.map((t) => {
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
      const inner = t.slice(1, -1);
      assert.ok(
        !inner.includes('"') && !inner.includes("'"),
        `${source} has a playwright invocation this gate cannot parse (${t})`,
      );
      return inner;
    }
    assert.ok(
      !t.includes('"') && !t.includes("'"),
      `${source} has a playwright invocation this gate cannot parse (${t})`,
    );
    return t;
  });
}

function normalizeConfigRef(ref, source) {
  let p = ref;
  if (p.startsWith("./")) p = p.slice(2);
  assert.ok(
    p.length > 0 && !p.startsWith("/") && !p.split("/").includes(".."),
    `${source} names a playwright config outside the repo (${ref})`,
  );
  return p;
}

function normalizeFilterRef(ref, source) {
  assert.ok(!ref.includes(":"), `${source} uses a :line filter this gate cannot expand (${ref})`);
  assert.ok(!ref.includes("*"), `${source} uses a glob filter this gate cannot expand (${ref})`);
  let p = ref;
  if (p.startsWith("./")) p = p.slice(2);
  assert.ok(
    p.length > 0 && !p.startsWith("/") && !p.split("/").includes(".."),
    `${source} names a playwright filter outside the repo (${ref})`,
  );
  return p;
}

// Every `playwright test` CI runs, with its config and file filters. Returns
// Map configRel -> { unfiltered: boolean, files: Set<string> (exact files),
// dirs: Set<string> (dir prefixes with trailing slash) }. A config with any
// unfiltered invocation runs every match; otherwise only the union runs.
function parsePlaywrightInvocations(root, workflowFiles, scripts, invoked) {
  const found = new Map();
  const record = (config, files, source) => {
    const entry = found.get(config) ?? { unfiltered: false, files: new Set(), dirs: new Set() };
    if (files === null) entry.unfiltered = true;
    else {
      for (const f of files) {
        const abs = join(root, f);
        assert.ok(existsSync(abs), `${source} filters a missing playwright path (${f})`);
        if (statSync(abs).isDirectory()) entry.dirs.add(f.endsWith("/") ? f : `${f}/`);
        else entry.files.add(f);
      }
    }
    found.set(config, entry);
  };
  const parseTokens = (tokens, source) => {
    let config = null;
    const positionals = [];
    for (let i = 0; i < tokens.length; i += 1) {
      const t = tokens[i];
      if (t === "--config") {
        assert.ok(i + 1 < tokens.length, `${source} has a --config with no value`);
        assert.ok(config === null, `${source} names two playwright configs`);
        config = normalizeConfigRef(tokens[i + 1], source);
        i += 1;
      } else if (t.startsWith("-")) {
        assert.fail(
          `${source} passes a playwright flag this gate cannot expand (${t}): use --config and file paths only, or teach ci/test-inventory.mjs the new flag`,
        );
      } else {
        positionals.push(normalizeFilterRef(t, source));
      }
    }
    if (config === null) config = "playwright.config.ts";
    assert.ok(
      existsSync(join(root, config)),
      `${source} references a missing playwright config (${config})`,
    );
    record(config, positionals.length ? positionals : null, source);
  };
  // Workflow steps: `playwright test` plus YAML `>-` continuation lines (the
  // kit-parity file filters live on the next line). Continuation stops at the
  // next step, key, or blank line so a following `run:` never bleeds in.
  // Each occurrence must run at the repo root (see assertRootStepCwd).
  for (const { name, text } of workflowFiles) {
    const lines = text.split("\n");
    const stripped = lines.map(stripYamlComment);
    const ctx = { file: name, lines: stripped, content: literalScriptLines(stripped) };
    for (let i = 0; i < lines.length; i += 1) {
      const line = stripped[i];
      const at = line.search(/\bplaywright\s+test\b/);
      if (at === -1) continue;
      assertRootStepCwd(ctx, i, at, "playwright test");
      let rest = line.slice(at).replace(/^\bplaywright\s+test\b/, "");
      for (let j = i + 1; j < lines.length; j += 1) {
        const next = stripYamlComment(lines[j]);
        if (!next.trim() || /^\s*(-\s|[A-Za-z0-9_-]+\s*:)/.test(next)) break;
        rest += ` ${next.trim()}`;
      }
      parseTokens(tokenizeArgs(rest, name), name);
    }
  }
  // Invoked scripts only (see invokedScriptNames): each `playwright test`
  // runs to the next shell chain separator, never into a following command.
  for (const name of invoked) {
    const body = scripts[name] ?? "";
    for (const m of body.matchAll(/\bplaywright\s+test\b/g)) {
      const tail = body.slice(m.index + m[0].length);
      const end = tail.search(/&&|\|\||;/);
      parseTokens(
        tokenizeArgs(end === -1 ? tail : tail.slice(0, end), `script ${name}`),
        `script ${name}`,
      );
    }
  }
  return found;
}

// Offset-aligned views like excludeArrayBody: comments become whitespace in
// both, quoted strings become whitespace only in `code`. Structure discovery
// uses code; literal values are read from clean.
function splitCodeViews(text, label) {
  let clean = "";
  let code = "";
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote) {
      clean += c;
      code += " ";
      if (c === "\\" && i + 1 < text.length) {
        clean += text[++i];
        code += " ";
      } else if (c === quote) {
        quote = null;
      }
    } else if (c === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      let end;
      if (text[i + 1] === "/") {
        end = i + 2;
        while (end < text.length && ![10, 13, 0x2028, 0x2029].includes(text.charCodeAt(end)))
          end += 1;
      } else {
        const close = text.indexOf("*/", i + 2);
        assert.ok(close !== -1, `${label} has an unclosed comment`);
        end = close + 2;
      }
      const blank = " ".repeat(end - i);
      clean += blank;
      code += blank;
      i = end - 1;
    } else if (c === '"' || c === "'" || c === "`") {
      quote = c;
      clean += c;
      code += " ";
    } else {
      clean += c;
      code += c;
    }
  }
  assert.ok(quote === null, `${label} has an unclosed string`);
  return { clean, code };
}

function matchBracket(code, open, label) {
  const pairs = { "{": "}", "[": "]", "(": ")" };
  const close = pairs[code[open]];
  assert.ok(close, `${label} expected an opening bracket`);
  let depth = 1;
  for (let i = open + 1; i < code.length; i += 1) {
    if (code[i] === code[open]) depth += 1;
    else if (code[i] === close) depth -= 1;
    if (depth === 0) return i;
  }
  assert.fail(`${label} never closes`);
}

function findDefineConfigBody(text, configPath) {
  const { clean, code } = splitCodeViews(text, configPath);
  const calls = [...code.matchAll(/defineConfig\s*\(\s*\{/g)];
  assert.equal(calls.length, 1, `${configPath} must call defineConfig once with an object literal`);
  const open = calls[0].index + calls[0][0].length - 1;
  const end = matchBracket(code, open, `${configPath} defineConfig object`);
  return { clean: clean.slice(open + 1, end), code: code.slice(open + 1, end) };
}

// Split an object/array body on top-level commas (depth counts `{`/`[` in
// the string-blind view, so commas in strings never split).
function splitTopLevel(bodyCode) {
  const parts = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < bodyCode.length; i += 1) {
    const c = bodyCode[i];
    if (c === "{" || c === "[") depth += 1;
    else if (c === "}" || c === "]") depth -= 1;
    else if (c === "," && depth === 0) {
      parts.push({ start, end: i });
      start = i + 1;
    }
  }
  parts.push({ start, end: bodyCode.length });
  return parts;
}

function parsePlainString(valueClean, configPath, what) {
  const m = valueClean.trim().match(/^(['"`])([^\\\r\n]*?)\1$/);
  assert.ok(m, `${configPath} has a ${what} this gate cannot parse: use a plain string literal`);
  assert.ok(
    !m[1].includes("`") || !m[2].includes("${"),
    `${configPath} has a ${what} this gate cannot parse: no template interpolation`,
  );
  return m[2];
}

function parseStringArray(valueClean, valueCode, configPath, what) {
  const trimmedCode = valueCode.trim();
  const open = valueCode.indexOf("[");
  assert.ok(
    open !== -1 && trimmedCode.startsWith("["),
    `${configPath} has a ${what} this gate cannot parse: use a string or an array of strings`,
  );
  const end = matchBracket(valueCode, open, `${configPath} ${what}`);
  assert.ok(
    valueCode.slice(end + 1).trim() === "",
    `${configPath} has a ${what} this gate cannot parse: trailing content after the array`,
  );
  const innerClean = valueClean.slice(open + 1, end);
  const innerCode = valueCode.slice(open + 1, end);
  const out = [];
  for (const { start, end: e } of splitTopLevel(innerCode)) {
    const entry = innerClean.slice(start, e).trim();
    if (!entry) continue; // trailing comma
    out.push(parsePlainString(entry, configPath, what));
  }
  return out;
}

function parseTestMatchValue(valueClean, valueCode, configPath, what) {
  if (valueCode.trim().startsWith("["))
    return parseStringArray(valueClean, valueCode, configPath, what);
  return [parsePlainString(valueClean, configPath, what)];
}

function parseConfigImports(text, configPath) {
  const { clean } = splitCodeViews(text, configPath);
  const imports = new Map();
  for (const m of clean.matchAll(
    /import\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*(['"])([^'"]+)\2/g,
  )) {
    imports.set(m[1], m[3]);
  }
  for (const m of clean.matchAll(
    /import\s+\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*)\s+from\s*(['"])([^'"]+)\2/g,
  )) {
    imports.set(m[1], m[3]);
  }
  return imports;
}

// A selection key spelled any way but a plain identifier fails closed. The
// key above is read from the string-blind code view, where `"testDir"` is
// blank space and `["testDir"]` is brackets around blank space, so both
// would otherwise skip silently and fall back to wider defaults. Quoted
// non-selection keys (`"name"`) are known-safe and stay ignored; any
// computed `[...]` key fails because its runtime name is unknowable.
function failOnNonPlainSelectionKey(keyClean, configPath) {
  const quoted = keyClean.match(/^(['"`])\s*(testDir|testMatch|testIgnore|projects)\s*\1$/);
  if (quoted) {
    assert.fail(
      `${configPath} has a quoted ${quoted[2]} key this gate cannot parse (${keyClean}): use a plain identifier, not a quoted or computed key`,
    );
  }
  if (/^\[.*\]$/.test(keyClean)) {
    assert.fail(
      `${configPath} has a computed selection key this gate cannot parse (${keyClean}): use a plain identifier, not a quoted or computed key`,
    );
  }
}

// Parse one project's top-level testDir/testMatch/testIgnore. A spread at
// project top level fails closed (it could carry selection keys); spreads
// inside nested `use:` blocks are ignored with the rest of `use`.
function parseProjectObject(objClean, objCode, configPath) {
  const out = {};
  for (const { start, end } of splitTopLevel(objCode)) {
    const entryCode = objCode.slice(start, end);
    if (!entryCode.trim()) continue;
    assert.ok(
      !entryCode.trim().startsWith("..."),
      `${configPath} has a project spread this gate cannot expand: name testDir/testMatch/testIgnore explicitly`,
    );
    const colon = entryCode.indexOf(":");
    if (colon === -1) {
      const shorthand = entryCode.trim();
      if (shorthand === "testDir")
        assert.fail(
          `${configPath} has a project testDir this gate cannot parse: use a plain string literal`,
        );
      if (shorthand === "testMatch" || shorthand === "testIgnore")
        assert.fail(
          `${configPath} has a project ${shorthand} this gate cannot parse: use a string or an array of strings`,
        );
      continue;
    }
    const key = entryCode.slice(0, colon).trim();
    if (key !== "testDir" && key !== "testMatch" && key !== "testIgnore") {
      failOnNonPlainSelectionKey(objClean.slice(start, end).slice(0, colon).trim(), configPath);
      continue;
    }
    const valueClean = objClean.slice(start, end).slice(colon + 1);
    const valueCode = entryCode.slice(colon + 1);
    if (key === "testDir")
      out.testDir = parsePlainString(valueClean, configPath, "project testDir");
    else out[key] = parseTestMatchValue(valueClean, valueCode, configPath, `project ${key}`);
  }
  return out;
}

// Static Playwright config parse with `...base` inheritance. Returns
// { testDir: string|null, testMatch: string[]|null,
//   testIgnore: string[]|null, projects: Array<...> } where null means
// absent (inherited from spreads, else the Playwright default).
function parsePlaywrightConfig(root, configRel, seen = new Set()) {
  const configPath = configRel;
  assert.ok(!seen.has(configRel), `${configPath} has a cyclic config spread`);
  seen.add(configRel);
  const text = readFileSync(join(root, configRel), "utf8");
  const imports = parseConfigImports(text, configPath);
  const { clean, code } = findDefineConfigBody(text, configPath);
  // Source-ordered ops: spreads and explicit keys apply in the order they
  // appear, like the object literal Playwright evaluates (`{...base, k: v}`
  // differs from `{k: v, ...base}` when base sets k).
  const ops = [];
  for (const { start, end } of splitTopLevel(code)) {
    const entryCode = code.slice(start, end);
    if (!entryCode.trim()) continue;
    const spread = entryCode.trim().match(/^\.\.\.\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*$/);
    if (spread) {
      const id = spread[1];
      assert.ok(imports.has(id), `${configPath} spreads ...${id} without importing it`);
      const rel = imports.get(id);
      assert.ok(
        rel.startsWith("."),
        `${configPath} spreads ...${id} from a package import (${rel}): only relative configs`,
      );
      const resolved = posixJoin(dirname(configRel).replaceAll("\\", "/"), rel);
      const candidate = [resolved, `${resolved}.ts`].find((c) => existsSync(join(root, c)));
      assert.ok(candidate, `${configPath} spreads ...${id} from a missing file (${rel})`);
      assert.ok(
        candidate.endsWith(".config.ts"),
        `${configPath} spreads ...${id} from a non-config file (${candidate})`,
      );
      ops.push({ kind: "spread", parsed: parsePlaywrightConfig(root, candidate, seen) });
      continue;
    }
    const colon = entryCode.indexOf(":");
    if (colon === -1) {
      const shorthand = entryCode.trim();
      if (shorthand === "testDir")
        assert.fail(
          `${configPath} has a testDir this gate cannot parse: use a plain string literal`,
        );
      if (shorthand === "testMatch" || shorthand === "testIgnore")
        assert.fail(
          `${configPath} has a ${shorthand} this gate cannot parse: use a string or an array of strings`,
        );
      if (shorthand === "projects")
        assert.fail(`${configPath} has projects this gate cannot parse: use an array of objects`);
      continue;
    }
    const key = entryCode.slice(0, colon).trim();
    if (key !== "testDir" && key !== "testMatch" && key !== "testIgnore" && key !== "projects") {
      failOnNonPlainSelectionKey(clean.slice(start, end).slice(0, colon).trim(), configPath);
      continue;
    }
    const valueClean = clean.slice(start, end).slice(colon + 1);
    const valueCode = entryCode.slice(colon + 1);
    if (key === "testDir")
      ops.push({
        kind: "key",
        key,
        value: parsePlainString(valueClean, configPath, "testDir"),
      });
    else if (key === "projects") {
      const open = valueCode.indexOf("[");
      assert.ok(
        open !== -1 && valueCode.trim().startsWith("["),
        `${configPath} has projects this gate cannot parse: use an array of objects`,
      );
      const close = matchBracket(valueCode, open, `${configPath} projects`);
      assert.ok(
        valueCode.slice(close + 1).trim() === "",
        `${configPath} has projects this gate cannot parse: trailing content after the array`,
      );
      const parsedProjects = [];
      for (const part of splitTopLevel(valueCode.slice(open + 1, close))) {
        const pCode = valueCode.slice(open + 1, close).slice(part.start, part.end);
        if (!pCode.trim()) continue;
        const pOpen = pCode.indexOf("{");
        assert.ok(
          pOpen !== -1 && pCode.trim().startsWith("{"),
          `${configPath} has a project this gate cannot parse: use an object literal`,
        );
        const pClose = matchBracket(pCode, pOpen, `${configPath} project`);
        const pClean = valueClean.slice(open + 1, close).slice(part.start, part.end);
        parsedProjects.push(
          parseProjectObject(
            pClean.slice(pOpen + 1, pClose),
            pCode.slice(pOpen + 1, pClose),
            configPath,
          ),
        );
      }
      ops.push({ kind: "key", key, value: parsedProjects });
    } else {
      ops.push({
        kind: "key",
        key,
        value: parseTestMatchValue(valueClean, valueCode, configPath, key),
      });
    }
  }
  const merged = { testDir: null, testMatch: null, testIgnore: null, projects: null };
  for (const op of ops) {
    if (op.kind === "spread") {
      if (op.parsed.testDir !== null) merged.testDir = op.parsed.testDir;
      if (op.parsed.testMatch !== null) merged.testMatch = op.parsed.testMatch;
      if (op.parsed.testIgnore !== null) merged.testIgnore = op.parsed.testIgnore;
      if (op.parsed.projects !== null) merged.projects = op.parsed.projects;
    } else {
      merged[op.key] = op.value;
    }
  }
  seen.delete(configRel);
  return merged;
}

function posixJoin(dir, rel) {
  const parts = [...(dir === "." ? [] : dir.split("/")), ...rel.split("/")].filter(
    (p) => p !== "" && p !== ".",
  );
  const stack = [];
  for (const p of parts) {
    if (p === "..") stack.pop();
    else stack.push(p);
  }
  return stack.join("/") || ".";
}

// Single-level `{a,b}` brace expansion. Nested, empty or unbalanced braces
// fail closed instead of silently matching nothing.
function expandBraces(pattern, configPath) {
  let out = [pattern];
  for (let i = 0; i < out.length; i += 1) {
    const p = out[i];
    const open = p.indexOf("{");
    if (open === -1) continue;
    const close = p.indexOf("}", open);
    assert.ok(close !== -1, `${configPath} has an unbalanced brace (${p})`);
    const inner = p.slice(open + 1, close);
    assert.ok(
      !inner.includes("{") && !inner.includes("}"),
      `${configPath} has nested braces this gate cannot expand (${p})`,
    );
    const alts = inner.split(",");
    assert.ok(
      alts.length > 1 && alts.every((a) => a.length > 0),
      `${configPath} has an empty brace alternative (${p})`,
    );
    out.splice(i, 1, ...alts.map((a) => `${p.slice(0, open)}${a}${p.slice(close + 1)}`));
    i -= 1;
    assert.ok(out.length < 100, `${configPath} brace expansion exploded (${pattern})`);
  }
  return out;
}

// Same fail-closed grammar as vitest excludes: after brace expansion every
// pattern must be exactly what globToRegExp expands (word characters, dash,
// dot, slash, star), spelled canonically.
function assertSupportedPlaywrightPatterns(patterns, configPath) {
  for (const p of patterns) {
    assert.ok(
      /^[\w\-./*]+$/.test(p),
      `${configPath} has a pattern this gate cannot expand (${p}): use literals, * / ** globs or single-level {a,b} braces`,
    );
    const segments = p.split("/");
    assert.ok(
      segments.every((part) => part && part !== "." && part !== ".."),
      `${configPath} has a non-canonical pattern (${p}): use paths without empty, . or .. segments`,
    );
    // Playwright's minimatch treats `**` inside a segment as segment-local
    // while this gate's `.*` crosses `/` (verified against the 1.64.1
    // oracle: testMatch `a**` matches `e2e/a/b.spec.ts` here, never runs
    // there), so a mid-segment `**` fails closed instead of over-matching.
    assert.ok(
      segments.every((part) => !part.includes("**") || part === "**"),
      `${configPath} has a pattern this gate cannot expand (${p}): ** must be a whole path segment`,
    );
    // Playwright matches against the absolute path, so leading bare-`*`
    // segments can be satisfied by the checkout prefix this gate cannot see
    // (oracle: `*/*/x.spec.ts` and `**/*/*/x.spec.ts` both match
    // `<root>/e2e/x.spec.ts`, which the repo-relative match misses). A
    // literal or `**` first segment anchors the match, so only a leading
    // bare `*` fails closed.
    const rest = [...segments];
    while (rest.length && rest[0] === "**") rest.shift();
    assert.ok(
      rest.length === 0 || rest[0] !== "*",
      `${configPath} has a pattern this gate cannot expand (${p}): a leading */ depends on the absolute checkout path; use **/ or literal segments instead`,
    );
  }
}

// Repo-relative testDir for a config, resolved against the config's own
// directory. Playwright defaults testDir to the config directory; every repo
// config names it explicitly, so a missing testDir reads as the config dir.
function normalizeTestDir(testDir, configRel) {
  assert.ok(!testDir.includes("\\"), `${configRel} testDir must use forward slashes (${testDir})`);
  assert.ok(
    !testDir.startsWith("/"),
    `${configRel} testDir must be relative to the config (${testDir})`,
  );
  const dir = dirname(configRel).replaceAll("\\", "/");
  const joined = testDir === "." || testDir === "./" ? dir : posixJoin(dir, testDir);
  const rel = joined === "" ? "." : joined;
  if (rel !== ".") {
    assert.ok(
      rel.split("/").every((part) => part && part !== "." && part !== ".."),
      `${configRel} has a non-canonical testDir (${testDir})`,
    );
  }
  return rel;
}

function isFileUnderDir(file, dir) {
  return dir === "." || file === dir || file.startsWith(`${dir}/`);
}

// Playwright's createFileMatcher (1.64.1 pin) prefixes `**/` to any string
// pattern not starting with it and matches with minimatch
// `{ nocase: true, dot: true }` against the absolute path. The repo-relative
// path stands in for the absolute (`**/` absorbs the repo prefix); matching
// is case-insensitive. `*` already matches dots via `[^/]*`, so no dot-flag
// equivalent is needed.
function patternMatchesFile(patterns, file) {
  return patterns.some((p) => {
    const effective = p.startsWith("**/") ? p : `**/${p}`;
    const re = new RegExp(globToRegExp(effective).source, "i");
    return re.test(file);
  });
}

function configMatchesFile(parsed, configRel, file) {
  const contexts = parsed.projects && parsed.projects.length ? parsed.projects : [{}];
  return contexts.some((project) => {
    const testDir = normalizeTestDir(project.testDir ?? parsed.testDir ?? ".", configRel);
    if (!isFileUnderDir(file, testDir)) return false;
    const testMatch = project.testMatch ?? parsed.testMatch;
    assert.ok(
      testMatch !== null && testMatch !== undefined,
      `${configRel} names no testMatch this gate can expand: use a plain string or array of strings (the Playwright RegExp default is not expandable)`,
    );
    const matchPatterns = testMatch.flatMap((p) => expandBraces(p, configRel));
    assertSupportedPlaywrightPatterns(matchPatterns, configRel);
    if (!patternMatchesFile(matchPatterns, file)) return false;
    const testIgnore = project.testIgnore ?? parsed.testIgnore ?? [];
    if (!testIgnore.length) return true;
    const ignorePatterns = testIgnore.flatMap((p) => expandBraces(p, configRel));
    assertSupportedPlaywrightPatterns(ignorePatterns, configRel);
    return !patternMatchesFile(ignorePatterns, file);
  });
}

// Resolve one relative import specifier to a repo-relative path under e2e/,
// or null when it points elsewhere or nowhere (a broken import is the
// typechecker's finding, not this gate's).
function resolveRelativeImport(spec, importer, root) {
  if (!spec.startsWith(".")) return null;
  const base = dirname(importer).replaceAll("\\", "/");
  const joined = posixJoin(base, spec);
  const candidates = [joined];
  if (spec.endsWith(".js")) candidates.push(`${joined.slice(0, -3)}.ts`);
  // A trailing `.visual` (as in `./member-board-viewer.visual`) is a
  // basename, not an extension: only known extensions suppress probing.
  if (!/\.(ts|mts|cts|js|mjs|cjs|json)$/.test(joined)) {
    candidates.push(
      `${joined}.ts`,
      `${joined}.mts`,
      `${joined}.cts`,
      `${joined}.mjs`,
      `${joined}.js`,
    );
  }
  for (const c of candidates) {
    if (c.startsWith("..") || c.startsWith("/")) continue;
    if (c === "e2e" || c.startsWith("e2e/")) {
      try {
        if (existsSync(join(root, c)) && statSync(join(root, c)).isFile()) return c;
      } catch {
        // A file that vanishes mid-check is not an edge; the next gate run rereads.
      }
    }
  }
  return null;
}

// Static import edges out of one file: ESM `from`/`import`/`export from`,
// plus CJS/ESM `require(`/`import(` with plain string literals. A dynamic
// (non-literal) specifier is not an edge: generated-asset loads such as
// `await import(pathToFileURL(...).href)` are legitimate spec code, and the
// gate stays fail-closed because a spec reachable only through a dynamic
// import is reported as an orphan, not as reachable.
//
// Deliberately line-based with naive comment stripping, not the
// string-aware scanner above: spec bodies hold regex literals containing
// quotes (`/class="([^"]+)"/`), which a quote-tracking scanner misreads as
// string delimiters. Import specifiers never contain `//` (relative
// `./...` or package paths), so cutting a line at `//` can only truncate
// non-import code — and a truncated non-import line is simply ignored.
function collectSpecImports(root, file) {
  const text = readFileSync(join(root, file), "utf8");
  const noBlock = text.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const lines = noBlock.split("\n").map((line) => {
    let cut = -1;
    for (let i = line.indexOf("//"); i !== -1; i = line.indexOf("//", i + 1)) {
      const prev = i === 0 ? "" : line[i - 1];
      if (prev !== ":") {
        cut = i;
        break;
      }
    }
    return cut === -1 ? line : line.slice(0, cut);
  });
  const specs = new Set();
  const ambiguous = new Set();
  // Type-only imports are erased at compile time and load nothing, so they
  // are not reachability edges — but only the type-only part is skipped. A
  // local `export type Alias = ...` is not an import at all and scans
  // normally; a complete type-only from-clause scans its remainder (a
  // runtime import sharing the line is still an edge); only an unterminated
  // multiline `import type { ...` / `export type { ...` skips forward to
  // its closing `from` (or `}` for a multiline local export). Inline
  // `{ type X }` specifiers are erased too and skipped (oracle: Playwright
  // 1.64.1 transforms with `onlyRemoveTypeImports: false`, so Babel drops
  // inline type specifiers and any named import whose bindings are never
  // used as values — `import { a } from "./s.visual"` with `a` unused loads
  // nothing). Named/default/namespace `import ... from` bindings are
  // therefore ambiguous without usage analysis: they fail closed when they
  // resolve to a spec file, unless a side-effect import, re-export or
  // require of the same file in this spec loads it for sure. Unmarked
  // `export ... from` and `export * from` are kept by Babel (oracle) and
  // stay edges, as do side-effect imports and require/dynamic-import calls.
  // (Transitive caveat: an ambiguous import of a *helper* keeps its edge —
  // specs import named helpers everywhere, so failing closed there would
  // forbid ordinary code. A phantom edge needs that import to be elided AND
  // the helper to import a spec; no helper in the tree imports a spec.)
  const fromClause = (s) => s.match(/\bfrom\s*(['"])[^'"]+\1/);
  const stripQuotedSpans = (s) => s.replace(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`/g, " ");
  let inTypeImport = false;
  let inTypeReexport = false;
  let stmtTail = "";
  for (const line of lines) {
    let scan = line;
    if (!inTypeImport && !inTypeReexport) {
      const typeImport = /^\s*import\s+type\b/.exec(scan);
      const typeExport = !typeImport && /^\s*export\s+type\b/.exec(scan);
      if (typeImport) {
        const from = fromClause(scan);
        if (from) {
          scan = scan.slice(from.index + from[0].length);
        } else if (/=/.test(scan)) {
          // `import type X = ...` (import-equals): complete and type-only.
          const semi = scan.indexOf(";");
          scan = semi === -1 ? "" : scan.slice(semi + 1);
        } else {
          inTypeImport = true;
          continue;
        }
      } else if (typeExport) {
        const rest = scan.slice(typeExport[0].length);
        const from = fromClause(rest);
        if (from) {
          scan = rest.slice(from.index + from[0].length);
        } else if (/^\s*[{*]/.test(rest)) {
          if (rest.includes("}")) {
            // Terminated local `export type { X };`: scan the remainder.
            scan = rest.slice(rest.indexOf("}") + 1);
          } else {
            inTypeReexport = true;
            continue;
          }
        }
        // else: `export type Alias = ...` is a local alias, not an import;
        // fall through and scan the whole line.
      }
    } else if (inTypeImport) {
      const from = fromClause(scan);
      if (!from) continue;
      inTypeImport = false;
      scan = scan.slice(from.index + from[0].length);
    } else {
      const from = fromClause(scan);
      if (from) {
        inTypeReexport = false;
        scan = scan.slice(from.index + from[0].length);
      } else if (scan.includes("}")) {
        inTypeReexport = false;
        scan = scan.slice(scan.indexOf("}") + 1);
      } else {
        continue;
      }
    }
    const tailBefore = stmtTail;
    // Every `from "..."` belongs to the nearest preceding `import`/`export`
    // (strings stripped, so a keyword inside a path or literal cannot
    // misattribute the leader). With no leader the clause is unclassifiable
    // and keeps current behavior (an edge).
    for (const m of scan.matchAll(/\bfrom\s*(['"])([^'"]+)\1/g)) {
      const context = stripQuotedSpans(`${tailBefore}\n${scan.slice(0, m.index)}`);
      const leaders = [...context.matchAll(/\b(import|export)\b/g)];
      if (!leaders.length) {
        specs.add(m[2]);
        continue;
      }
      const last = leaders[leaders.length - 1];
      const bindings = context.slice(last.index + last[0].length);
      // Statement-level `import/export type ... from` (mid-line, where the
      // line-start skipper above cannot see it): the `type` modifier erases
      // the whole clause. A bare `type` alone is a value named `type`.
      if (/^\s*type\b/.test(bindings) && !/^\s*type\s*$/.test(bindings)) continue;
      const hasStar = bindings.includes("*");
      const rest = bindings
        .replace(/\btype\s+[\w$]+(?:\s+as\s+[\w$]+)?/g, "")
        .replace(/[,{}*\s]/g, "");
      if (!hasStar && !/[\w$]/.test(rest)) continue; // all inline-`type`: erased.
      if (last[1] === "import") ambiguous.add(m[2]);
      else specs.add(m[2]);
    }
    for (const m of scan.matchAll(/\bimport\s*(['"])([^'"]+)\1/g)) specs.add(m[2]);
    for (const m of scan.matchAll(/\brequire\s*\(\s*(['"])([^'"]+)\1/g)) {
      // `import X = require("./s")` loads only when X is used (oracle), so
      // it is ambiguous like a named import; a bare require() call is an edge.
      const context = stripQuotedSpans(`${tailBefore}\n${scan.slice(0, m.index)}`);
      if (/import\s+(?!type\b)[\w$]+\s*=\s*$/.test(context)) ambiguous.add(m[2]);
      else specs.add(m[2]);
    }
    for (const m of scan.matchAll(/\bimport\s*\(\s*(['"])([^'"]+)\1/g)) specs.add(m[2]);
    stmtTail = `${tailBefore}\n${scan}`;
    const semi = stmtTail.lastIndexOf(";");
    if (semi !== -1) stmtTail = stmtTail.slice(semi + 1);
  }
  const out = [];
  for (const spec of specs) {
    const resolved = resolveRelativeImport(spec, file, root);
    if (resolved) out.push(resolved);
  }
  const genuine = new Set(out);
  for (const spec of ambiguous) {
    const resolved = resolveRelativeImport(spec, file, root);
    if (!resolved || genuine.has(resolved)) continue;
    if (!/\.spec\.ts$/.test(resolved) && !/\.visual\.ts$/.test(resolved)) {
      out.push(resolved); // helper targets keep current behavior (see above).
      continue;
    }
    assert.fail(
      `${file} ambiguously imports ${resolved}: named import bindings are not side-effect edges (Playwright's Babel removes bindings never used as values); import the spec for its side effects or teach ci/test-inventory.mjs the new form`,
    );
  }
  return out;
}

export function inventory(root = repoRoot) {
  const haystack = collectHaystack(root);
  const smokeCmd = smokeCommand(root);
  const testFiles = VITEST_TEST_DIRS.flatMap((d) => listTestFiles(root, d));
  const smokeExcluded = vitestExcludedTests(root);
  const files = [
    ...testFiles,
    ...listTestFiles(root, "tier0"),
    ...listTestFiles(root, "ci"),
    ...listTestFiles(root, "e2e"),
  ].sort();
  const orphans = [];
  const reachable = [];
  for (const file of files) {
    let via = null;
    if (file.startsWith("test/")) {
      via = smokeExcluded.has(file) ? "npm run test:smoke" : "vitest include (test/**/*.test.*)";
      // A vitest-excluded file is reachable only when the test:smoke
      // command itself still names it.
      if (smokeExcluded.has(file) && !referencedInCi(file, smokeCmd)) via = null;
    } else if (file.startsWith("tier0/")) {
      // Tier-0 suites run only from the report-only step via their own
      // config: reachable only while that wiring still names the config or
      // the script (the haystack holds script bodies, not names, so match
      // the config path the script invokes).
      via = "npm run test:tier0";
      if (!haystack.includes("tier0/vitest.config.ts") && !haystack.includes("test:tier0"))
        via = null;
    } else if (referencedInCi(file, haystack)) {
      // ci/** and e2e/** test files need an explicit CI reference.
      // Playwright *.spec.ts / *.visual.ts are outside this gate's scope.
      via = "named (or globbed) in package.json or workflow";
    }
    if (via) reachable.push({ file, via });
    else orphans.push(file);
  }
  return { files, reachable, orphans };
}

export function playwrightInventory(root = repoRoot) {
  const files = listPlaywrightSpecs(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const scripts = pkg.scripts ?? {};
  const workflowFiles = collectWorkflowFiles(root);
  const workflowText = workflowFiles.map((w) => w.text).join("\n");
  const invoked = invokedScriptNames(scripts, workflowText);
  auditWorkflowNpmRunCwd(workflowFiles, scripts);
  auditScriptCwd(scripts, invoked);
  const refs = parsePlaywrightInvocations(root, workflowFiles, scripts, invoked);
  const parsed = new Map();
  for (const config of refs.keys()) parsed.set(config, parsePlaywrightConfig(root, config));
  const direct = new Map();
  for (const file of files) {
    for (const [config, ref] of refs) {
      if (!configMatchesFile(parsed.get(config), config, file)) continue;
      if (!ref.unfiltered) {
        const inFiles = ref.files.has(file);
        const inDirs = [...ref.dirs].some((d) => file.startsWith(d));
        if (!inFiles && !inDirs) continue;
      }
      direct.set(file, `playwright ${config} (testMatch)`);
      break;
    }
  }
  // Transitive import closure: a matched spec's relative imports run with
  // it, and their imports with them. Helpers are traversed but only
  // spec/visual files join the reachable set.
  const fileSet = new Set(files);
  const reachable = [];
  const via = new Map(direct);
  const visited = new Set();
  const queue = [...direct.keys()];
  for (const [file, how] of direct) reachable.push({ file, via: how });
  while (queue.length) {
    const importer = queue.shift();
    if (visited.has(importer)) continue;
    visited.add(importer);
    for (const next of collectSpecImports(root, importer)) {
      if (visited.has(next)) continue;
      if (!via.has(next) && fileSet.has(next)) {
        const how = `imported by ${importer} (${via.get(importer)})`;
        via.set(next, how);
        reachable.push({ file: next, via: how });
      }
      queue.push(next);
    }
  }
  reachable.sort((a, b) => (a.file < b.file ? -1 : 1));
  const orphans = files.filter((f) => !via.has(f));
  return { files, reachable, orphans };
}

export function playwrightJsonSummary(root = repoRoot) {
  const { files, reachable, orphans } = playwrightInventory(root);
  const ok = orphans.length === 0;
  return {
    checkId: PLAYWRIGHT_CHECK_ID,
    ok,
    code: ok ? PLAYWRIGHT_CODE_OK : PLAYWRIGHT_CODE_ORPHAN,
    total: files.length,
    reachable: reachable.length,
    orphans: [...orphans].sort(),
    next_action: ok ? PLAYWRIGHT_NEXT_ACTION_OK : PLAYWRIGHT_NEXT_ACTION_ORPHAN,
  };
}

function selftest() {
  let cases = 0;
  const check = (name, fn) => {
    fn();
    cases += 1;
    console.log(`ok: ${name}`);
  };

  // Hermetic by design: --selftest must pass on any tree, including one with
  // a genuinely orphaned file. The repoRoot cases below assert only that the
  // derived exclude set parses and stays wired (never that the tree has zero
  // orphans); the plain `npm run test:inventory -- --strict` run in the same
  // CI step is the check that fails the job on orphans (HARD).
  check("clean fixture tree reports no orphans", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { check: "node --test ci/wired.test.mjs" } }),
      );
      mkdirSync(join(dir, "ci"), { recursive: true });
      writeFileSync(join(dir, "ci", "wired.test.mjs"), "node:test placeholder\n");
      const { orphans, files } = inventory(dir);
      assert.deepEqual(files, ["ci/wired.test.mjs"]);
      assert.deepEqual(orphans, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("inventory derives the vitest exclude list (no hand mirror)", () => {
    const excluded = [...vitestExcludedTests(repoRoot)].sort();
    assert.deepEqual(excluded, [
      "test/json-smoke.test.mjs",
      "test/promotion-smoke-identity-acceptance.test.mjs",
      "test/revision-check.test.mjs",
      "test/smoke-ordinary-traffic-identity-acceptance.test.mjs",
      "test/smoke-public-api-acceptance.test.mjs",
      "test/smoke.test.mjs",
    ]);
  });

  check("multiple unquoted exclude keys fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { coverage: { exclude: [] }, test: { exclude: ["test/ghost.test.mjs"] } };\n',
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "ghost.test.mjs"), "vitest placeholder\n");
      assert.throws(() => inventory(dir), /exactly one unquoted exclude block/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("vitest-excluded smoke files resolve via test:smoke", () => {
    const { reachable } = inventory(repoRoot);
    const excluded = vitestExcludedTests(repoRoot);
    assert.ok(excluded.size > 0, "expected vitest to exclude at least one smoke file");
    for (const f of excluded) {
      const hit = reachable.find((r) => r.file === f);
      assert.ok(hit, `${f} should be reachable`);
      assert.match(hit.via, /test:smoke/);
    }
  });

  check("vitest-excluded test file named in no script is an orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { "test:smoke": "node --test test/wired.test.mjs" } }),
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { test: { exclude: ["**/node_modules/**", "test/wired.test.mjs", "test/ghost.test.mjs"] } };\n',
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "wired.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "ghost.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "plain.test.ts"), "vitest placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, ["test/ghost.test.mjs"]);
      const wired = reachable.find((r) => r.file === "test/wired.test.mjs");
      assert.ok(wired, "wired smoke file should be reachable");
      assert.match(wired.via, /test:smoke/);
      const plain = reachable.find((r) => r.file === "test/plain.test.ts");
      assert.ok(plain, "non-excluded test file should be reachable");
      assert.match(plain.via, /vitest include/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("glob vitest excludes expand against discovered files", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { "test:smoke": "node --test test/smoke-wired.test.mjs" } }),
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { test: { exclude: ["**/node_modules/**", "test/smoke-wired.test.mjs", "test/smoke-*.test.mjs", "test/nested/**", "**/legacy-*.test.mjs"] } };\n',
      );
      mkdirSync(join(dir, "test", "nested"), { recursive: true });
      writeFileSync(join(dir, "test", "smoke-wired.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "smoke-new-thing.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "legacy-thing.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "nested", "deep.test.ts"), "vitest placeholder\n");
      writeFileSync(join(dir, "test", "plain.test.ts"), "vitest placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, [
        "test/legacy-thing.test.mjs",
        "test/nested/deep.test.ts",
        "test/smoke-new-thing.test.mjs",
      ]);
      const wired = reachable.find((r) => r.file === "test/smoke-wired.test.mjs");
      assert.ok(wired, "literal-excluded wired file should be reachable");
      assert.match(wired.via, /test:smoke/);
      const plain = reachable.find((r) => r.file === "test/plain.test.ts");
      assert.ok(plain, "non-excluded file should be reachable");
      assert.match(plain.via, /vitest include/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("excluded file mentioned outside test:smoke is still an orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: {
            "test:smoke": "node --test test/wired.test.mjs",
            "local-only": "echo test/script-ghost.test.mjs",
          },
        }),
      );
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "# runs test/comment-ghost.test.mjs\nname: ci\n",
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { test: { exclude: ["test/wired.test.mjs", "test/script-ghost.test.mjs", "test/comment-ghost.test.mjs"] } };\n',
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "wired.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "script-ghost.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "comment-ghost.test.mjs"), "node:test placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, ["test/comment-ghost.test.mjs", "test/script-ghost.test.mjs"]);
      const wired = reachable.find((r) => r.file === "test/wired.test.mjs");
      assert.ok(wired, "file named by test:smoke should be reachable");
      assert.match(wired.via, /test:smoke/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("single-quoted vitest excludes are parsed (literal and glob)", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { "test:smoke": "node --test test/wired.test.mjs" } }),
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        "export default { test: { exclude: ['test/wired.test.mjs', 'test/ghost.test.mjs', 'test/smoke-*.test.mjs'] } };\n",
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "wired.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "ghost.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "smoke-new.test.mjs"), "node:test placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, ["test/ghost.test.mjs", "test/smoke-new.test.mjs"]);
      const wired = reachable.find((r) => r.file === "test/wired.test.mjs");
      assert.ok(wired, "single-quoted wired file should be reachable");
      assert.match(wired.via, /test:smoke/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("unsupported vitest exclude magic fails closed", () => {
    const cases = [
      ["question", "test/q-?.test.mjs", "test/q-a.test.mjs"],
      ["brace", "test/brace-*.test.{mjs,js}", "test/brace-a.test.mjs"],
      ["char-class", "test/[ab]-class.test.mjs", "test/a-class.test.mjs"],
      ["negation", "!test/neg.test.mjs", "test/neg.test.mjs"],
      ["extglob-plus", "test/ext-+(a|b).test.mjs", "test/ext-ab.test.mjs"],
      ["extglob-at", "test/at-@(x|y).test.mjs", "test/at-x.test.mjs"],
      ["extglob-star", "test/star-*(a|b).test.mjs", "test/star-ab.test.mjs"],
    ];
    for (const [name, exclude, file] of cases) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        writeFileSync(
          join(dir, "vitest.config.ts"),
          `export default { test: { exclude: ["${exclude}"] } };\n`,
        );
        mkdirSync(join(dir, "test"), { recursive: true });
        writeFileSync(join(dir, file), "node:test placeholder\n");
        assert.throws(() => inventory(dir), /cannot expand/, `${name} exclude should fail closed`);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("exclude expressions fail closed in the strict CLI", () => {
    const expressions = [
      '"test/" + "ghost.test.mjs"',
      '...["test/ghost.test.mjs"]',
      "...extraExcludes",
      "extraExclude",
      "`test/${name}.test.mjs`",
      '"test/ghost.test.mjs".replace("ghost", "ghost")',
      '"test/ghost.test.mjs" "test/other.test.mjs"',
      '"test/gh\\u006fst.test.mjs"',
      "...configDefaults.exclude.filter(keep)",
    ];
    for (const expression of expressions) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        writeFileSync(
          join(dir, "vitest.config.ts"),
          `export default { test: { exclude: [...configDefaults.exclude, ${expression}] } };\n`,
        );
        mkdirSync(join(dir, "test"), { recursive: true });
        writeFileSync(join(dir, "test", "ghost.test.mjs"), "node:test placeholder\n");
        const result = spawnSync(
          process.execPath,
          [fileURLToPath(import.meta.url), "--root", dir, "--strict"],
          { encoding: "utf8" },
        );
        assert.equal(result.status, 1, `${expression} must fail closed`);
        assert.match(result.stderr, /cannot (?:parse|expand)/, expression);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("plain excludes accept all quote styles and the default spread", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(
        join(dir, "vitest.config.ts"),
        "export default { test: { exclude: [...configDefaults.exclude, \"test/double.test.mjs\", 'test/single.test.mjs', `test/backtick.test.mjs`,] } };\n",
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      for (const name of ["double", "single", "backtick"]) {
        writeFileSync(join(dir, "test", `${name}.test.mjs`), "node:test placeholder\n");
      }
      assert.deepEqual(inventory(dir).orphans, [
        "test/backtick.test.mjs",
        "test/double.test.mjs",
        "test/single.test.mjs",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("line comment with apostrophe does not break exclude parsing", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { "test:smoke": "node --test test/g1.test.mjs test/g2.test.mjs" },
        }),
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { test: { exclude: [\n"test/g1.test.mjs", // don\'t run these locally\n"test/g2.test.mjs",\n] } };\n',
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "g1.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "g2.test.mjs"), "node:test placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, []);
      for (const f of ["test/g1.test.mjs", "test/g2.test.mjs"]) {
        const hit = reachable.find((r) => r.file === f);
        assert.ok(hit, `${f} should be reachable`);
        assert.match(hit.via, /test:smoke/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("commented-out exclude entry is not an exclude", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({ scripts: { "test:smoke": "node --test test/wired.test.mjs" } }),
      );
      writeFileSync(
        join(dir, "vitest.config.ts"),
        'export default { test: { exclude: [/* "test/ghost2.test.mjs", */ "test/wired.test.mjs"] } };\n',
      );
      mkdirSync(join(dir, "test"), { recursive: true });
      writeFileSync(join(dir, "test", "wired.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test", "ghost2.test.mjs"), "node:test placeholder\n");
      const { orphans, reachable } = inventory(dir);
      assert.deepEqual(orphans, []);
      const ghost = reachable.find((r) => r.file === "test/ghost2.test.mjs");
      assert.ok(ghost, "commented-out file should be vitest-reachable");
      assert.match(ghost.via, /vitest include/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Each fixture keeps a non-excluded sibling to catch over-broad directory
  // matching as well as a silently reachable excluded suite.
  const excludeFixture = (config, error) => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      writeFileSync(join(dir, "vitest.config.ts"), config);
      mkdirSync(join(dir, "test", "helpers", "unit"), { recursive: true });
      writeFileSync(join(dir, "test/helpers/unit/ghost.test.mjs"), "node:test placeholder\n");
      writeFileSync(join(dir, "test/plain.test.ts"), "vitest placeholder\n");
      if (error) {
        assert.throws(() => inventory(dir), error);
      } else {
        const { orphans, reachable } = inventory(dir);
        assert.deepEqual(orphans, ["test/helpers/unit/ghost.test.mjs"]);
        assert.match(reachable.find((r) => r.file === "test/plain.test.ts").via, /vitest include/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  check("non-canonical vitest exclude paths fail closed", () => {
    for (const entry of [
      "./test/helpers/unit/ghost.test.mjs",
      "test//helpers/unit/ghost.test.mjs",
      "test/./helpers/unit/ghost.test.mjs",
      "test/../test/helpers/unit/ghost.test.mjs",
      "test/helpers/unit/ghost.test.mjs/",
      "./test/**/*.test.mjs",
      "test/helpers/",
    ]) {
      excludeFixture(
        `export default { test: { exclude: [${JSON.stringify(entry)}] } };`,
        /non-canonical/,
      );
    }
  });

  check("directory excludes prune descendants but not siblings", () => {
    for (const entry of ["test/helpers", "**/helpers", "test/helpers/*", "test/*/unit"]) {
      excludeFixture(`export default { test: { exclude: [${JSON.stringify(entry)}] } };`);
    }
  });

  check("exclude key search skips comments and strings", () => {
    for (const prefix of [
      "/* exclude: [] */\n",
      "// exclude: []\n",
      'const note = "exclude: []";\n',
      "const note = 'exclude: []';\n",
      "const note = `exclude: []`;\n",
      "const notexclude = [];\n",
    ]) {
      excludeFixture(
        `${prefix}export default { test: { exclude: ["test/helpers/unit/ghost.test.mjs"] } };`,
      );
    }
  });

  check("line comments end at every ECMAScript line terminator", () => {
    for (const end of ["\n", "\r", String.fromCodePoint(0x2028), String.fromCodePoint(0x2029)]) {
      excludeFixture(
        `export default { test: { exclude: [// note${end}"test/helpers/unit/ghost.test.mjs",\n] } };`,
      );
    }
  });

  check("unreferenced ci file is an orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, "ci"), { recursive: true });
      writeFileSync(join(dir, "ci", "never-wired.test.mjs"), "node:test placeholder\n");
      const { orphans } = inventory(dir);
      assert.deepEqual(orphans, ["ci/never-wired.test.mjs"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("tier0 files resolve via test:tier0, orphans without it", () => {
    for (const wired of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({
            scripts: wired ? { "test:tier0": "vitest run --config tier0/vitest.config.ts" } : {},
          }),
        );
        mkdirSync(join(dir, "tier0"), { recursive: true });
        writeFileSync(join(dir, "tier0", "a.test.ts"), "vitest placeholder\n");
        const { orphans, reachable } = inventory(dir);
        if (wired) {
          assert.deepEqual(orphans, []);
          assert.equal(reachable[0].via, "npm run test:tier0");
        } else {
          assert.deepEqual(orphans, ["tier0/a.test.ts"]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("CLI --strict exits 1 naming a fixture orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, "ci"), { recursive: true });
      writeFileSync(join(dir, "ci", "never-wired.test.mjs"), "node:test placeholder\n");
      const self = fileURLToPath(import.meta.url);
      const strict = spawnSync(process.execPath, [self, "--root", dir, "--strict"], {
        encoding: "utf8",
      });
      assert.equal(strict.status, 1);
      assert.match(strict.stdout, /never-wired/);
      const warn = spawnSync(process.execPath, [self, "--root", dir], { encoding: "utf8" });
      assert.equal(warn.status, 0);
      assert.match(warn.stdout, /never-wired/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright matched spec reachable, ignored spec orphan", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.foo.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.foo.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", testIgnore: "**/ignored/**" });\n',
      );
      mkdirSync(join(dir, "e2e", "ignored"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "ignored", "b.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans, reachable } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/ignored/b.spec.ts"]);
      assert.equal(reachable[0].file, "e2e/a.spec.ts");
      assert.match(reachable[0].via, /playwright\.foo\.config\.ts/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The events-index → member-board-viewer pattern, fixture-level: the
  // entrypoint is pinned by testMatch, the suite runs only through its
  // import. Cutting the import (second fixture) must orphan the suite.
  // Never proved by touching the real import.
  check("playwright import edge marks visual reachable; cut edge orphans it", () => {
    const setup = (dir, withEdge) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.entry.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.entry.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e/entry", testMatch: "entry.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e", "entry"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "entry", "entry.spec.ts"),
        `${withEdge ? 'import "./suite.visual";\n' : ""}import { test } from "@playwright/test";\ntest("x", async () => {});\n`,
      );
      writeFileSync(
        join(dir, "e2e", "entry", "suite.visual.ts"),
        'import { test } from "@playwright/test";\ntest("y", async () => {});\n',
      );
    };
    for (const withEdge of [true, false]) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        setup(dir, withEdge);
        const { orphans, reachable } = playwrightInventory(dir);
        if (withEdge) {
          assert.deepEqual(orphans, []);
          const suite = reachable.find((r) => r.file === "e2e/entry/suite.visual.ts");
          assert.ok(suite, "imported suite should be reachable");
          assert.match(suite.via, /imported by e2e\/entry\/entry\.spec\.ts/);
        } else {
          assert.deepEqual(orphans, ["e2e/entry/suite.visual.ts"]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // The kit-parity filtered run: every invocation names files, so only the
  // union runs. A spec matching testMatch but named nowhere is an orphan.
  check("playwright CLI file filter restricts reachability", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: >-\n          npx playwright test --config playwright.filt.config.ts\n          e2e/a.spec.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.filt.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "b.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans, reachable } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/b.spec.ts"]);
      assert.deepEqual(
        reachable.map((r) => r.file),
        ["e2e/a.spec.ts"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright testIgnore brace expansion prunes each alternative", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.br.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.br.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", testIgnore: "**/{staging,watch}/**" });\n',
      );
      mkdirSync(join(dir, "e2e", "staging"), { recursive: true });
      mkdirSync(join(dir, "e2e", "watch"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "staging", "b.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "watch", "c.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/staging/b.spec.ts", "e2e/watch/c.spec.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright ...base spread inherits testMatch", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.derived.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.base.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      writeFileSync(
        join(dir, "playwright.derived.config.ts"),
        'import { defineConfig } from "@playwright/test";\nimport base from "./playwright.base.config";\nexport default defineConfig({ ...base, testDir: "./e2e/sub" });\n',
      );
      mkdirSync(join(dir, "e2e", "sub"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "sub", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "top.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans, reachable } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/top.spec.ts"]);
      assert.deepEqual(
        reachable.map((r) => r.file),
        ["e2e/sub/a.spec.ts"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright project testMatch override reaches beyond the top level", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.proj.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.proj.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "visual", testMatch: "**/*.visual.ts" }] });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.visual.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans } = playwrightInventory(dir);
      assert.deepEqual(orphans, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright unused script does not reference its config", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { "e2e:unused": "playwright test --config playwright.unused.config.ts" },
        }),
      );
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.used.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.used.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e/used", testMatch: "**/*.spec.ts" });\n',
      );
      writeFileSync(
        join(dir, "playwright.unused.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e", "used"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "used", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "ghost.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/ghost.spec.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright JSON pins checkId, codes and next_action", () => {
    const setup = (dir, withOrphan) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.js.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.js.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "a.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      if (withOrphan)
        writeFileSync(
          join(dir, "e2e", "ghost.spec.ts"),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
    };
    for (const withOrphan of [false, true]) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        setup(dir, withOrphan);
        const summary = playwrightJsonSummary(dir);
        assert.equal(summary.checkId, "playwright-spec-reachability");
        if (withOrphan) {
          assert.equal(summary.ok, false);
          assert.equal(summary.code, "PLAYWRIGHT_SPEC_ORPHAN");
          assert.deepEqual(summary.orphans, ["e2e/ghost.spec.ts"]);
          assert.equal(summary.total, 2);
          assert.equal(summary.reachable, 1);
          assert.match(summary.next_action, /workflow file filter/);
          assert.match(summary.next_action, /quality-gates\.md/);
        } else {
          assert.equal(summary.ok, true);
          assert.equal(summary.code, "OK");
          assert.deepEqual(summary.orphans, []);
          assert.equal(summary.total, 1);
          assert.equal(summary.reachable, 1);
          assert.match(summary.next_action, /No action needed/);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright RegExp testMatch fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.rx.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.rx.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: /.*spec/ });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      assert.throws(() => playwrightInventory(dir), /cannot parse/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright unknown flag fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.fl.config.ts --project chromium\n",
      );
      writeFileSync(
        join(dir, "playwright.fl.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      assert.throws(() => playwrightInventory(dir), /flag this gate cannot expand/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // A dynamic specifier is not an edge: the matched entry stays reachable
  // (generated-asset loads are legitimate spec code), while a suite named
  // only through a dynamic import is reported as an orphan, not reachable.
  check("playwright dynamic import fails closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.dy.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.dy.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\nconst suitePath = "./suite.visual";\ntest("x", async () => { await import(suitePath); require(other); });\n',
      );
      writeFileSync(
        join(dir, "e2e", "suite.visual.ts"),
        'import { test } from "@playwright/test";\ntest("y", async () => {});\n',
      );
      const { orphans, reachable } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/suite.visual.ts"]);
      assert.ok(
        reachable.some((r) => r.file === "e2e/a.spec.ts"),
        "matched entry with a dynamic import should stay reachable",
      );
      assert.equal(playwrightJsonSummary(dir).code, "PLAYWRIGHT_SPEC_ORPHAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("CLI --json prints one Playwright summary object", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.cli.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.cli.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "a.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "ghost.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const self = fileURLToPath(import.meta.url);
      const loose = spawnSync(process.execPath, [self, "--root", dir, "--json"], {
        encoding: "utf8",
      });
      assert.equal(loose.status, 0);
      const summary = JSON.parse(loose.stdout);
      assert.equal(summary.checkId, "playwright-spec-reachability");
      assert.equal(summary.code, "PLAYWRIGHT_SPEC_ORPHAN");
      assert.deepEqual(summary.orphans, ["e2e/ghost.spec.ts"]);
      const strict = spawnSync(process.execPath, [self, "--root", dir, "--json", "--strict"], {
        encoding: "utf8",
      });
      assert.equal(strict.status, 1);
      assert.equal(JSON.parse(strict.stdout).code, "PLAYWRIGHT_SPEC_ORPHAN");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright commented-out npm run step does not invoke its script", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { "e2e:cmt": "playwright test --config playwright.cmt.config.ts" },
        }),
      );
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      # - run: npm run e2e:cmt\n",
      );
      writeFileSync(
        join(dir, "playwright.cmt.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/a.spec.ts"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Playwright createFileMatcher parity: `**/` is prefixed when absent and
  // matching is case-insensitive. A nested `staging/**` ignore must prune,
  // a differently-cased ignore must prune, and a basename testMatch must
  // reach a nested file.
  check("playwright matcher prefixes **/ and ignores case", () => {
    const setup = (dir, configBody, files) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.m.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.m.config.ts"),
        `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ ${configBody} });\n`,
      );
      for (const f of files) {
        mkdirSync(join(dir, dirname(f)), { recursive: true });
        writeFileSync(
          join(dir, f),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
      }
    };
    const cases = [
      {
        name: "nested staging ignore",
        config: 'testDir: "./e2e", testMatch: "**/*.spec.ts", testIgnore: "staging/**"',
        files: ["e2e/a.spec.ts", "e2e/kit/staging/x.spec.ts"],
        orphans: ["e2e/kit/staging/x.spec.ts"],
      },
      {
        name: "cased ignore",
        config: 'testDir: "./e2e", testMatch: "**/*.spec.ts", testIgnore: "**/Staging/**"',
        files: ["e2e/a.spec.ts", "e2e/staging/x.spec.ts"],
        orphans: ["e2e/staging/x.spec.ts"],
      },
      {
        name: "basename match",
        config: 'testDir: "./e2e", testMatch: "a.spec.ts"',
        files: ["e2e/sub/a.spec.ts", "e2e/other.spec.ts"],
        orphans: ["e2e/other.spec.ts"],
      },
    ];
    for (const c of cases) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        setup(dir, c.config, c.files);
        assert.deepEqual(playwrightInventory(dir).orphans, c.orphans, c.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright shorthand selection keys fail closed", () => {
    const bodies = [
      'const testDir = "./e2e/only";\nexport default defineConfig({ testDir, testMatch: "**/*.spec.ts" })',
      'export default defineConfig({ testDir: "./e2e", testMatch })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", testIgnore })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "p", testDir }] })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "p", testMatch }] })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "p", testIgnore }] })',
    ];
    for (const body of bodies) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.sh.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.sh.config.ts"),
          `import { defineConfig } from "@playwright/test";\n${body};\n`,
        );
        mkdirSync(join(dir, "e2e"), { recursive: true });
        writeFileSync(
          join(dir, "e2e", "a.spec.ts"),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
        assert.throws(() => playwrightInventory(dir), /cannot parse/, body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // A spread after an explicit key wins in JavaScript, so the gate applies
  // entries in source order: here base's visual-only testMatch overwrites
  // the earlier spec-only one.
  check("playwright spread after explicit key applies in source order", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.ord.config.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.base2.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.visual.ts" });\n',
      );
      writeFileSync(
        join(dir, "playwright.ord.config.ts"),
        'import { defineConfig } from "@playwright/test";\nimport base from "./playwright.base2.config";\nexport default defineConfig({ testMatch: "**/*.spec.ts", ...base });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      writeFileSync(
        join(dir, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      writeFileSync(
        join(dir, "e2e", "b.visual.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      const { orphans, reachable } = playwrightInventory(dir);
      assert.deepEqual(orphans, ["e2e/a.spec.ts"]);
      assert.deepEqual(
        reachable.map((r) => r.file),
        ["e2e/b.visual.ts"],
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  check("playwright type-only imports are not reachability edges", () => {
    const typeLines = [
      'import type { X } from "./suite.visual";',
      'export type { X } from "./suite.visual";',
      'import type {\n X\n} from "./suite.visual";',
    ];
    for (const typeLine of typeLines) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.ty.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.ty.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e/entry", testMatch: "entry.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e", "entry"), { recursive: true });
        writeFileSync(
          join(dir, "e2e", "entry", "entry.spec.ts"),
          `${typeLine}\nimport { test } from "@playwright/test";\ntest("x", async () => {});\n`,
        );
        writeFileSync(
          join(dir, "e2e", "entry", "suite.visual.ts"),
          'import { test } from "@playwright/test";\ntest("y", async () => {});\n',
        );
        assert.deepEqual(playwrightInventory(dir).orphans, ["e2e/entry/suite.visual.ts"], typeLine);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright npm run -- forwarded args fail closed", () => {
    const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(dir, "package.json"),
        JSON.stringify({
          scripts: { e2e: "playwright test --config playwright.fwd.config.ts" },
        }),
      );
      mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(dir, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npm run e2e -- e2e/a.spec.ts\n",
      );
      writeFileSync(
        join(dir, "playwright.fwd.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(dir, "e2e"), { recursive: true });
      for (const name of ["a", "b"]) {
        writeFileSync(
          join(dir, "e2e", `${name}.spec.ts`),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
      }
      assert.throws(() => playwrightInventory(dir), /cannot expand/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    // The same forwarding nested in an invoked script body fails closed too:
    // without the scan, `b` reads as an unfiltered run and `y` as reachable.
    const nested = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(nested, "package.json"),
        JSON.stringify({
          scripts: {
            a: "npm run b -- e2e/x.spec.ts",
            b: "playwright test --config playwright.fwd3.config.ts",
          },
        }),
      );
      mkdirSync(join(nested, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(nested, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npm run a\n",
      );
      writeFileSync(
        join(nested, "playwright.fwd3.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(nested, "e2e"), { recursive: true });
      for (const name of ["x", "y"]) {
        writeFileSync(
          join(nested, "e2e", `${name}.spec.ts`),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
      }
      assert.throws(() => playwrightInventory(nested), /cannot expand/);
    } finally {
      rmSync(nested, { recursive: true, force: true });
    }
    // Control: forwarded args to a non-Playwright script stay out of scope.
    const control = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(control, "package.json"),
        JSON.stringify({ scripts: { lint: "eslint ." } }),
      );
      mkdirSync(join(control, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(control, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npm run lint -- --fix\n      - run: npx playwright test --config playwright.fwd2.config.ts\n",
      );
      writeFileSync(
        join(control, "playwright.fwd2.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(control, "e2e"), { recursive: true });
      writeFileSync(
        join(control, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      assert.deepEqual(playwrightInventory(control).orphans, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(control, { recursive: true, force: true });
    }
    // Control: nested forwarding to a non-Playwright script stays in scope.
    const nestedControl = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(
        join(nestedControl, "package.json"),
        JSON.stringify({
          scripts: { a: "npm run lint -- --fix", lint: "eslint ." },
        }),
      );
      mkdirSync(join(nestedControl, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(nestedControl, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npm run a\n      - run: npx playwright test --config playwright.fwd4.config.ts\n",
      );
      writeFileSync(
        join(nestedControl, "playwright.fwd4.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
      );
      mkdirSync(join(nestedControl, "e2e"), { recursive: true });
      writeFileSync(
        join(nestedControl, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      assert.deepEqual(playwrightInventory(nestedControl).orphans, []);
    } finally {
      rmSync(nestedControl, { recursive: true, force: true });
    }
  });

  check("playwright quoted or computed selection keys fail closed", () => {
    const bodies = [
      'export default defineConfig({ "testDir": "./e2e/only", testMatch: "**/*.spec.ts" })',
      'export default defineConfig({ [\'testDir\']: "./e2e/only", testMatch: "**/*.spec.ts" })',
      'export default defineConfig({ [testDir]: "./e2e/only", testMatch: "**/*.spec.ts" })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "p", "testDir": "./e2e/only" }] })',
      'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ name: "p", ["testMatch"]: "**/*.spec.ts" }] })',
    ];
    for (const body of bodies) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.qk.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.qk.config.ts"),
          `import { defineConfig } from "@playwright/test";\n${body};\n`,
        );
        mkdirSync(join(dir, "e2e"), { recursive: true });
        writeFileSync(
          join(dir, "e2e", "a.spec.ts"),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
        assert.throws(() => playwrightInventory(dir), /cannot parse/, body);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // Control: a quoted non-selection key stays ignored, not fatal.
    const control = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
    try {
      writeFileSync(join(control, "package.json"), JSON.stringify({ scripts: {} }));
      mkdirSync(join(control, ".github", "workflows"), { recursive: true });
      writeFileSync(
        join(control, ".github", "workflows", "ci.yml"),
        "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.qk2.config.ts\n",
      );
      writeFileSync(
        join(control, "playwright.qk2.config.ts"),
        'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts", projects: [{ "name": "p" }] });\n',
      );
      mkdirSync(join(control, "e2e"), { recursive: true });
      writeFileSync(
        join(control, "e2e", "a.spec.ts"),
        'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
      );
      assert.deepEqual(playwrightInventory(control).orphans, []);
    } finally {
      rmSync(control, { recursive: true, force: true });
    }
  });

  // Oracle-verified divergences from Playwright 1.64.1 createFileMatcher: a
  // mid-segment `**` over-matches across `/`, and leading bare-`*` segments
  // match the absolute checkout path the gate cannot see. Both fail closed.
  check("playwright unsupported matcher classes fail closed", () => {
    const patterns = ["a**", "*/*/x.spec.ts", "**/*/*/x.spec.ts", "**/*/x.spec.ts"];
    for (const pattern of patterns) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.mc.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.mc.config.ts"),
          `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "${pattern}" });\n`,
        );
        mkdirSync(join(dir, "e2e", "a"), { recursive: true });
        writeFileSync(
          join(dir, "e2e", "a", "b.spec.ts"),
          'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
        );
        assert.throws(() => playwrightInventory(dir), /cannot expand/, pattern);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
    // Control: a literal-anchored star the oracle agrees on stays allowed.
    const controls = [
      {
        name: "literal-anchored star",
        config: 'testDir: "./e2e", testMatch: "e2e/*/x.spec.ts"',
        files: ["e2e/a/x.spec.ts", "e2e/x.spec.ts"],
        orphans: ["e2e/x.spec.ts"],
      },
    ];
    for (const c of controls) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.mc2.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.mc2.config.ts"),
          `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ ${c.config} });\n`,
        );
        for (const f of c.files) {
          mkdirSync(join(dir, dirname(f)), { recursive: true });
          writeFileSync(
            join(dir, f),
            'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
          );
        }
        assert.deepEqual(playwrightInventory(dir).orphans, c.orphans, c.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  // Local type syntax must not swallow a following runtime import edge: an
  // alias, a terminated local export, and a shared-line type import all leave
  // the entry's `./suite.visual` edge (and the type-only target orphaned).
  check("playwright local type syntax keeps import edges", () => {
    const entries = [
      {
        name: "alias",
        head: "export type Alias = { a: number };",
        typed: null,
      },
      {
        name: "local export",
        head: "export type { X };",
        typed: null,
      },
      {
        name: "multiline local export",
        head: "export type {\n X\n};",
        typed: null,
      },
      {
        name: "shared-line type import",
        head: 'import type { X } from "./other.visual"; import "./suite.visual";',
        typed: "other",
      },
      {
        name: "multiline re-export",
        head: 'export type {\n X\n} from "./other.visual";',
        typed: "other",
      },
      {
        name: "import-equals",
        head: 'import type X = require("./other.visual");',
        typed: "other",
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.te.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.te.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e/entry", testMatch: "entry.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e", "entry"), { recursive: true });
        const edgeLine = e.name === "shared-line type import" ? "" : 'import "./suite.visual";\n';
        writeFileSync(
          join(dir, "e2e", "entry", "entry.spec.ts"),
          `${e.head}\n${edgeLine}import { test } from "@playwright/test";\ntest("x", async () => {});\n`,
        );
        writeFileSync(
          join(dir, "e2e", "entry", "suite.visual.ts"),
          'import { test } from "@playwright/test";\ntest("y", async () => {});\n',
        );
        if (e.typed) {
          writeFileSync(
            join(dir, "e2e", "entry", "other.visual.ts"),
            'import { test } from "@playwright/test";\ntest("z", async () => {});\n',
          );
        }
        const expected = e.typed ? ["e2e/entry/other.visual.ts"] : [];
        assert.deepEqual(playwrightInventory(dir).orphans, expected, e.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright npm run flags around the script name", () => {
    const pw = "playwright test --config playwright.fl.config.ts";
    const entries = [
      // A flag between the script name and `--` must not defeat the
      // forwarding check: npm consumes its own flags and forwards the rest.
      {
        name: "bool flag",
        scripts: { b: pw },
        run: "npm run b --silent -- e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      {
        name: "equals flag",
        scripts: { b: pw },
        run: "npm run b --prefix=. -- e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      {
        name: "two flags",
        scripts: { b: pw },
        run: "npm run b --silent --ignore-scripts -- e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      {
        name: "nested forwarding with flags",
        scripts: { a: "npm run b --silent -- e2e/x.spec.ts", b: pw },
        run: "npm run a",
        throws: /cannot expand/,
      },
      // Separate-value flags (`--prefix .`) consume the next token, before
      // and after the name; `--prefix=.` is the same directory, so only the
      // forwarding fails closed here, not the redirect.
      {
        name: "separate value after name",
        scripts: { b: pw },
        run: "npm run b --prefix . -- e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      {
        name: "separate value before name",
        scripts: { b: pw },
        run: "npm run --prefix=. b -- e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      // `--prefix`/`--workspace` run another package's script, which the gate
      // cannot model: fail closed on Playwright targets.
      {
        name: "prefix redirect",
        scripts: { b: pw },
        run: "npm run b --prefix web",
        throws: /cannot model/,
      },
      {
        name: "prefix redirect before name",
        scripts: { b: pw },
        run: "npm run --prefix web b",
        throws: /cannot model/,
      },
      {
        name: "workspace redirect",
        scripts: { b: pw },
        run: "npm run b --workspace web",
        throws: /cannot model/,
      },
      // Controls: flags before the name still invoke it, a redirect of a
      // non-Playwright script stays out of scope, and bundled short flags
      // fail closed instead of misreading the script name.
      {
        name: "flag before name invokes",
        scripts: { b: pw },
        run: "npm run --silent b",
        orphans: [],
      },
      {
        name: "prefix redirect of non-playwright script",
        scripts: { lint: "eslint ." },
        run: "npm run lint --prefix web",
        orphans: ["e2e/x.spec.ts", "e2e/y.spec.ts"],
      },
      {
        name: "bundled short flags",
        scripts: { b: pw },
        run: "npm run -sw b",
        throws: /cannot parse/,
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: e.scripts }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          `name: ci\njobs:\n  t:\n    steps:\n      - run: ${e.run}\n`,
        );
        writeFileSync(
          join(dir, "playwright.fl.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e"), { recursive: true });
        for (const name of ["x", "y"]) {
          writeFileSync(
            join(dir, `e2e/${name}.spec.ts`),
            'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
          );
        }
        if (e.throws) assert.throws(() => playwrightInventory(dir), e.throws, e.name);
        else assert.deepEqual(playwrightInventory(dir).orphans, e.orphans, e.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright npm run positional args forward without --", () => {
    const pw = "playwright test --config playwright.pos.config.ts";
    const entries = [
      // Oracle (npm 11.19.1): bare positionals reach the script without any
      // `--`, so they are forwarded filters, in workflows and script bodies.
      {
        name: "bare positional",
        scripts: { b: pw },
        run: "npm run b e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      {
        name: "nested positional",
        scripts: { a: "npm run b e2e/x.spec.ts", b: pw },
        run: "npm run a",
        throws: /cannot expand/,
      },
      {
        name: "positional after boolean flag",
        scripts: { b: pw },
        run: "npm run b --silent e2e/x.spec.ts",
        throws: /cannot expand/,
      },
      // Past the first bare `--` npm forwards everything literally: a
      // `--prefix` there is a filter, never a redirect.
      {
        name: "post-separator prefix is forwarding",
        scripts: { b: pw },
        run: "npm run b -- --prefix web",
        throws: /cannot expand/,
      },
      // Controls: the shell strips redirection before npm runs, so attached
      // and bare operators (plus the bare target) never forward.
      {
        name: "attached redirect target",
        scripts: { b: pw },
        run: "npm run b 2>/dev/null",
        orphans: [],
      },
      {
        name: "bare redirect skips its target",
        scripts: { b: pw },
        run: "npm run b > log.txt",
        orphans: [],
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: e.scripts }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          `name: ci\njobs:\n  t:\n    steps:\n      - run: ${e.run}\n`,
        );
        writeFileSync(
          join(dir, "playwright.pos.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e"), { recursive: true });
        for (const name of ["x", "y"]) {
          writeFileSync(
            join(dir, `e2e/${name}.spec.ts`),
            'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
          );
        }
        if (e.throws) assert.throws(() => playwrightInventory(dir), e.throws, e.name);
        else assert.deepEqual(playwrightInventory(dir).orphans, e.orphans, e.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright workflow steps run at the repo root", () => {
    const pwRun = "npx playwright test --config playwright.rt.config.ts";
    const pwScript = "playwright test --config playwright.rt.config.ts";
    const stdJob = (steps) => `name: ci\njobs:\n  t:\n    steps:\n${steps}`;
    const entries = [
      // Step-level working-directory, before or after the run key, on direct
      // and npm-run executions.
      {
        name: "step working-directory before run",
        workflow: stdJob(
          `      - name: pw\n        working-directory: web\n        run: ${pwRun}\n`,
        ),
        throws: /cannot resolve/,
      },
      {
        name: "step working-directory after run",
        workflow: stdJob(
          `      - name: pw\n        run: ${pwRun}\n        working-directory: web\n`,
        ),
        throws: /cannot resolve/,
      },
      {
        name: "step working-directory with npm run",
        workflow: stdJob(`      - run: npm run e2e\n        working-directory: web\n`),
        throws: /cannot resolve/,
      },
      {
        name: "step working-directory after run block",
        workflow: stdJob(
          `      - run: |\n          echo hi\n          ${pwRun}\n        working-directory: web\n`,
        ),
        throws: /cannot resolve/,
      },
      // Inherited job and workflow defaults move the step too.
      {
        name: "job defaults",
        workflow:
          "name: ci\njobs:\n  t:\n    defaults:\n      run:\n        working-directory: web\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        throws: /cannot resolve/,
      },
      {
        name: "workflow defaults",
        workflow:
          "name: ci\ndefaults:\n  run:\n    working-directory: web\njobs:\n  t:\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        throws: /cannot resolve/,
      },
      {
        name: "inline flow defaults carrying working-directory",
        workflow:
          "name: ci\ndefaults: {run: {working-directory: web}}\njobs:\n  t:\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        throws: /cannot resolve/,
      },
      {
        name: "inline flow run under defaults",
        workflow:
          "name: ci\ndefaults:\n  run: {working-directory: web}\njobs:\n  t:\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        throws: /cannot resolve/,
      },
      // The step's own shell: same-line, earlier-line, subshell, env-prefixed
      // and `command`-prefixed cds all move the run.
      {
        name: "same-line cd",
        workflow: stdJob(`      - run: cd web && ${pwRun}\n`),
        throws: /cannot resolve/,
      },
      {
        name: "earlier-line cd",
        workflow: stdJob(`      - run: |\n          cd web\n          ${pwRun}\n`),
        throws: /cannot resolve/,
      },
      {
        name: "subshell cd wraps the run",
        workflow: stdJob(`      - run: (cd web && ${pwRun})\n`),
        throws: /cannot resolve/,
      },
      {
        name: "env-prefixed cd",
        workflow: stdJob(`      - run: FOO=1 cd web && ${pwRun}\n`),
        throws: /cannot resolve/,
      },
      {
        name: "command-prefixed cd",
        workflow: stdJob(`      - run: command cd web && ${pwRun}\n`),
        throws: /cannot resolve/,
      },
      // A quoted `<<EOF` is not a heredoc opener: the real cd below it is
      // still found.
      {
        name: "quoted heredoc opener does not hide cd",
        workflow: stdJob(
          `      - run: |\n          echo "see <<EOF marker"\n          cd web\n          ${pwRun}\n`,
        ),
        throws: /cannot resolve/,
      },
      // A cd after the heredoc closes is a real directory change.
      {
        name: "cd after closed heredoc",
        workflow: stdJob(
          `      - run: |\n          cat > run.sh <<'EOF'\n          cd web\n          EOF\n          cd web\n          ${pwRun}\n`,
        ),
        throws: /cannot resolve/,
      },
      // A `- ` line inside a non-run literal is not a step item: the walk
      // skips it by shape and still finds the step's working-directory.
      // (`uses:` + `run:` together is GitHub-invalid, but the gate reads
      // text, not Actions semantics.)
      {
        name: "dash line in with-block does not stop the walk",
        workflow: stdJob(
          "      - uses: actions/x\n        working-directory: web\n        with:\n          text: |\n            - not-a-step\n" +
            `        run: ${pwRun}\n`,
        ),
        throws: /cannot resolve/,
      },
      // Unattributable executions fail closed instead of reading as root.
      {
        name: "step outside any job",
        workflow: `- run: ${pwRun}\n`,
        throws: /cannot resolve/,
      },
      {
        name: "npm run outside any step",
        workflow: "name: ci\nenv:\n  X: npm run e2e\n",
        throws: /cannot resolve/,
      },
      // Controls: explicit roots, overrides, and precise attribution.
      {
        name: "step working-directory dot is root",
        workflow: stdJob(`      - run: ${pwRun}\n        working-directory: .\n`),
        orphans: [],
      },
      {
        name: "step working-directory workspace is root",
        workflow: stdJob(
          `      - run: ${pwRun}\n        working-directory: \${{ github.workspace }}\n`,
        ),
        orphans: [],
      },
      {
        name: "quoted step working-directory dot is root",
        workflow: stdJob(`      - run: ${pwRun}\n        working-directory: "."\n`),
        orphans: [],
      },
      {
        name: "job root overrides workflow defaults",
        workflow:
          "name: ci\ndefaults:\n  run:\n    working-directory: web\njobs:\n  t:\n    defaults:\n      run:\n        working-directory: .\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        orphans: [],
      },
      {
        name: "cd on a later line is out of scope",
        workflow: stdJob(`      - run: |\n          ${pwRun}\n\n          cd web\n`),
        orphans: [],
      },
      {
        name: "cd after npm run is out of scope",
        workflow: stdJob(`      - run: npm run e2e && cd web\n`),
        orphans: [],
      },
      {
        name: "step root overrides workflow defaults",
        workflow:
          "name: ci\ndefaults:\n  run:\n    working-directory: web\njobs:\n  t:\n    steps:\n" +
          `      - run: ${pwRun}\n        working-directory: .\n`,
        orphans: [],
      },
      {
        name: "job defaults do not leak across jobs",
        workflow:
          "name: ci\njobs:\n  a:\n    defaults:\n      run:\n        working-directory: web\n    steps:\n" +
          "      - run: echo hi\n  b:\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        orphans: [],
      },
      {
        name: "unrelated step working-directory is out of scope",
        workflow: stdJob(
          `      - run: echo hi\n        working-directory: web\n      - run: ${pwRun}\n`,
        ),
        orphans: [],
      },
      {
        name: "command substitution cd does not persist",
        workflow: stdJob(`      - run: ROOT=$(cd .. && pwd) && ${pwRun}\n`),
        orphans: [],
      },
      {
        name: "backtick cd does not persist",
        workflow: stdJob("      - run: echo `cd web` && " + `${pwRun}\n`),
        orphans: [],
      },
      {
        name: "mid-line cd word is not a command",
        workflow: stdJob(`      - run: echo cd web && ${pwRun}\n`),
        orphans: [],
      },
      {
        name: "heredoc cd is data",
        workflow: stdJob(
          `      - run: |\n          cat > run.sh <<'EOF'\n          cd web\n          EOF\n          ${pwRun}\n`,
        ),
        orphans: [],
      },
      {
        name: "commented working-directory is not a run",
        workflow: stdJob(`      - run: ${pwRun}\n      # working-directory: web\n`),
        orphans: [],
      },
      {
        name: "flow defaults without working-directory",
        workflow:
          "name: ci\ndefaults: {run: {shell: bash}}\njobs:\n  t:\n    steps:\n" +
          `      - run: ${pwRun}\n`,
        orphans: [],
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { e2e: pwScript } }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(join(dir, ".github", "workflows", "ci.yml"), e.workflow);
        writeFileSync(
          join(dir, "playwright.rt.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e"), { recursive: true });
        for (const name of ["x", "y"]) {
          writeFileSync(
            join(dir, `e2e/${name}.spec.ts`),
            'import { test } from "@playwright/test";\ntest("x", async () => {});\n',
          );
        }
        if (e.throws) assert.throws(() => playwrightInventory(dir), e.throws, e.name);
        else assert.deepEqual(playwrightInventory(dir).orphans, e.orphans, e.name);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("workflow shell view preserves decoded run scalars and is idempotent", () => {
    const runs = [
      ">-\n          npm run\n          b",
      "npm run\n          b",
      "|\n          npm run b\n          echo separate-command",
      ">+\n          npm run b\n\n          echo separate-command\n",
      ">2-\n          npm run b\n            more-indented\n          echo next",
      '"npm run b\\n echo next" # YAML comment',
      '"  echo setup\\ncd e2e/sub\\nnpx playwright test"',
      '"\\n  echo setup\\ncd e2e/sub\\nnpm run b"',
      "|2-\n            echo setup\n          cd e2e/sub\n          npm run b",
      ">2-\n            echo setup\n          cd e2e/sub\n\n          npm run b",
      "'npm run b\n          --silent'",
      "|\n          cat <<'EOF'\n          working-directory: web\n          - run: not-a-step\n          EOF\n          npm run b",
    ];
    for (const run of runs) {
      const text = `jobs:\n  t:\n    steps:\n      - run: ${run}\n        working-directory: .\n      - run: echo next-step\n`;
      const expected = parseDocument(text).toJS().jobs.t.steps;
      const view = workflowShellView(text, "fixture");
      const decoded = parseDocument(view);
      assert.equal(decoded.errors.length, 0, run);
      const actual = decoded.toJS().jobs.t.steps;
      assert.equal(actual.length, 2, run);
      for (let i = 0; i < actual.length; i++) {
        assert.equal(actual[i].run.trimEnd(), expected[i].run.trimEnd(), run);
        assert.equal(actual[i]["working-directory"], expected[i]["working-directory"], run);
      }
      assert.equal(workflowShellView(view, "fixture"), view, run);
    }
    assert.throws(() => workflowShellView("jobs: [unclosed", "fixture"), /not valid YAML/);
  });

  check("playwright YAML scalar folding cannot hide npm forwarding", () => {
    const entries = [
      ["folded separator", ">-\n          npm run b\n          -- e2e/x.spec.ts"],
      ["folded positional", ">\n          npm run b\n          e2e/x.spec.ts"],
      ["plain separator", "npm run b\n          -- e2e/x.spec.ts"],
      ["plain positional", "npm run b\n          e2e/x.spec.ts"],
      ["double-quoted separator", '"npm run b\n          -- e2e/x.spec.ts"'],
      ["single-quoted positional", "'npm run b\n          e2e/x.spec.ts'"],
      ["folded flags", ">-\n          npm run b --silent\n          -- e2e/x.spec.ts"],
      ["folded script name", ">-\n          npm run\n          b -- e2e/x.spec.ts"],
    ];
    for (const [name, run] of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(
          join(dir, "package.json"),
          JSON.stringify({ scripts: { b: "playwright test" } }),
        );
        mkdirSync(join(dir, ".github/workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github/workflows/ci.yml"),
          `name: ci\njobs:\n  t:\n    steps:\n      - run: ${run}\n`,
        );
        writeFileSync(
          join(dir, "playwright.config.ts"),
          'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e"));
        for (const spec of ["x", "y"]) writeFileSync(join(dir, `e2e/${spec}.spec.ts`), "");
        assert.throws(
          () => playwrightInventory(dir),
          /cannot expand forwarded playwright filters/,
          name,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright directory stack commands and invoked script cwd fail closed", () => {
    const entries = [
      ...["npx playwright test", "npm run b"].flatMap((invocation) =>
        [
          '"  echo setup\\ncd e2e/sub\\nINVOCATION"',
          '"\\n  echo setup\\ncd e2e/sub\\nINVOCATION"',
          "|2-\n            echo setup\n          cd e2e/sub\n          INVOCATION",
          ">2-\n            echo setup\n          cd e2e/sub\n\n          INVOCATION",
        ].map((run) => ({
          name: `indented first command before ${invocation}: ${run}`,
          run: run.replace("INVOCATION", invocation),
          scripts: { b: "playwright test" },
        })),
      ),
      ...[
        "if true; then cd e2e/sub; fi;",
        "{ cd e2e/sub; };",
        "if cd e2e/sub; then :; fi;",
        "if false; then :; elif cd e2e/sub; then :; fi;",
        "if false; then :; else cd e2e/sub; fi;",
        "for dir in e2e/sub; do cd $dir; done;",
        "while cd e2e/sub; do break; done;",
        "until cd e2e/sub; do break; done;",
        "! cd e2e/sub;",
        "case sub in sub) cd e2e/sub;; esac;",
        "if true; then builtin pushd e2e/sub; fi;",
        "{ command cd e2e/sub; };",
        "if true; then { X=y builtin cd e2e/sub; }; fi;",
        "if true; then popd; fi;",
        "time cd e2e/sub;",
        "time -p cd e2e/sub;",
        "if time cd e2e/sub; then :; fi;",
        "time -- cd e2e/sub;",
        "time -p -- cd e2e/sub;",
        "time ! cd e2e/sub;",
        "! time cd e2e/sub;",
        "time time cd e2e/sub;",
        "if true; then time -p builtin cd e2e/sub; fi;",
        "{ time cd e2e/sub; };",
        "time pushd e2e/sub;",
        "time -p popd;",
        "time \\\ncd e2e/sub;",
        "time -p X=y command cd e2e/sub;",
        'time LABEL="two words" cd e2e/sub;',
        "time LABEL='two words' cd e2e/sub;",
        "time LABEL= cd e2e/sub;",
        'time -p -- LABEL= NEXT="two words" cd e2e/sub;',
        'time LABEL=two" mixed "words cd e2e/sub;',
        "time LABEL=two\\ words cd e2e/sub;",
        'time LABEL="semi; colon" cd e2e/sub;',
        'time LABEL="a \\"quoted\\" value" cd e2e/sub;',
        'time LABEL="" cd e2e/sub;',
        "time LABEL='' cd e2e/sub;",
        'LABEL="two words" cd e2e/sub;',
        "LABEL= cd e2e/sub;",
        "time command builtin cd e2e/sub;",
        "time builtin command cd e2e/sub;",
        "time command command cd e2e/sub;",
        "time builtin builtin cd e2e/sub;",
        "time command -- builtin -- cd e2e/sub;",
        "time command -p builtin cd e2e/sub;",
        'time LABEL="two words" command builtin cd e2e/sub;',
        "time LABEL= command builtin cd e2e/sub;",
        'if time LABEL="two words" cd e2e/sub; then :; fi;',
        'if true; then time LABEL="two words" command builtin cd e2e/sub; fi;',
        '{ time LABEL="two words" cd e2e/sub; };',
        'case sub in sub) time LABEL="two words" cd e2e/sub;; esac;',
        'time LABEL="two words" command builtin pushd e2e/sub;',
        "time LABEL= command builtin popd;",
        'time\tLABEL="two words"\tcommand\tbuiltin\tcd e2e/sub;',
        'time LABEL="two words" "command" builtin c"d" e2e/sub;',
        'time LABEL="two words" command builtin c\\d e2e/sub;',
      ].flatMap((prefix) => [
        {
          name: `workflow compound: ${prefix}`,
          run: JSON.stringify(`${prefix} npx playwright test`),
        },
        {
          name: `workflow compound npm: ${prefix}`,
          run: JSON.stringify(`${prefix} npm run b`),
          scripts: { b: "playwright test" },
        },
        {
          name: `script compound: ${prefix}`,
          run: "npm run b",
          scripts: { b: `${prefix} playwright test` },
        },
        {
          name: `nested script compound: ${prefix}`,
          run: "npm run a",
          scripts: { a: `${prefix} npm run b`, b: "playwright test" },
        },
      ]),
      { name: "inline pushd", run: "pushd e2e/sub && npx playwright test" },
      { name: "literal pushd", run: "|\n          pushd e2e/sub\n          npx playwright test" },
      {
        name: "folded pushd",
        run: ">-\n          pushd e2e/sub &&\n          npx playwright test",
      },
      { name: "popd", run: "popd && npx playwright test" },
      { name: "builtin pushd", run: "builtin pushd e2e/sub && npx playwright test" },
      { name: "subshell pushd", run: "(pushd e2e/sub && npx playwright test)" },
      { name: "script cd", run: "npm run b", scripts: { b: "cd e2e/sub && playwright test" } },
      {
        name: "script pushd",
        run: "npm run b",
        scripts: { b: "pushd e2e/sub && playwright test" },
      },
      { name: "script popd", run: "npm run b", scripts: { b: "popd && playwright test" } },
      {
        name: "nested script cd",
        run: "npm run a",
        scripts: { a: "cd e2e/sub && npm run b", b: "playwright test" },
      },
      {
        name: "nested script pushd",
        run: "npm run a",
        scripts: { a: "pushd e2e/sub && npm run b", b: "playwright test" },
      },
      {
        name: "nested target cd",
        run: "npm run a",
        scripts: { a: "npm run b", b: "cd e2e/sub && playwright test" },
      },
      {
        name: "multiline script cd",
        run: "npm run b",
        scripts: { b: "cd e2e/sub\nplaywright test" },
      },
      {
        name: "split npm name retains step cwd",
        run: ">-\n          npm run\n          b\n        working-directory: e2e/sub",
        scripts: { b: "playwright test" },
      },
      ...[
        "time echo cd e2e/sub;",
        "time -p echo cd e2e/sub;",
        "echo time cd e2e/sub;",
        "echo $(time cd .. && pwd);",
        "echo `time cd e2e/sub`;",
        "cat <<'EOF'\ntime cd e2e/sub\nEOF\n",
      ].flatMap((prefix) => [
        {
          name: `workflow timed control: ${prefix}`,
          run: JSON.stringify(`${prefix} npx playwright test`),
          clean: true,
        },
        {
          name: `script timed control: ${prefix}`,
          run: "npm run b",
          scripts: { b: `${prefix} playwright test` },
          clean: true,
        },
      ]),
      ...[
        'time LABEL="two words" echo cd e2e/sub;',
        "time LABEL= echo cd e2e/sub;",
        'time LABEL="semi; cd e2e/sub" echo done;',
        "time command builtin echo cd e2e/sub;",
        "time command -v cd;",
        'echo "time LABEL=; cd e2e/sub";',
        "echo $(time LABEL= cd e2e/sub);",
        'echo `time LABEL="two words" cd e2e/sub`;',
        "cat <<'EOF'\ntime LABEL=\"two words\" command builtin cd e2e/sub\nEOF\n",
      ].flatMap((prefix) => [
        {
          name: `workflow shell-word control: ${prefix}`,
          run: JSON.stringify(`${prefix} npx playwright test`),
          clean: true,
        },
        {
          name: `workflow npm shell-word control: ${prefix}`,
          run: JSON.stringify(`${prefix} npm run b`),
          scripts: { b: "playwright test" },
          clean: true,
        },
        {
          name: `script shell-word control: ${prefix}`,
          run: "npm run b",
          scripts: { b: `${prefix} playwright test` },
          clean: true,
        },
        {
          name: `nested script shell-word control: ${prefix}`,
          run: "npm run a",
          scripts: { a: `${prefix} npm run b`, b: "playwright test" },
          clean: true,
        },
      ]),
      {
        name: "later timed script cd",
        run: "npm run b",
        scripts: { b: "playwright test; time cd e2e/sub" },
        clean: true,
      },
      // Controls: compound syntax alone does not move cwd, changes in a child
      // shell do not move its parent, later changes cannot affect an earlier
      // run, and local-only scripts are not CI.
      {
        name: "workflow compound without cwd change",
        run: JSON.stringify("{ echo cd e2e/sub; }; npx playwright test"),
        clean: true,
      },
      {
        name: "script compound without cwd change",
        run: "npm run b",
        scripts: { b: "if true; then echo cd e2e/sub; fi; playwright test" },
        clean: true,
      },
      {
        name: "later compound cwd change",
        run: "npm run b",
        scripts: { b: "playwright test; if true; then cd e2e/sub; fi" },
        clean: true,
      },
      {
        name: "later script cd",
        run: "npm run b",
        scripts: { b: "playwright test && cd e2e/sub" },
        clean: true,
      },
      {
        name: "script substitution",
        run: "npm run b",
        scripts: { b: "ROOT=$(cd .. && pwd) && playwright test" },
        clean: true,
      },
      {
        name: "script heredoc data",
        run: "npm run b",
        scripts: { b: "cat <<'EOF'\ncd e2e/sub\nEOF\nplaywright test" },
        clean: true,
      },
      {
        name: "uninvoked cwd script",
        run: "npx playwright test",
        scripts: { b: "cd e2e/sub && playwright test" },
        clean: true,
      },
      {
        name: "unrelated script cwd",
        run: "npm run a && npx playwright test",
        scripts: { a: "cd web && npm run lint", lint: "eslint ." },
        clean: true,
      },
      {
        name: "pushd substitution",
        run: "ROOT=$(pushd .. && pwd) && npx playwright test",
        clean: true,
      },
      {
        name: "heredoc pushd data",
        run: "|\n          cat <<'EOF'\n          pushd e2e/sub\n          EOF\n          npx playwright test",
        clean: true,
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: e.scripts ?? {} }));
        mkdirSync(join(dir, ".github/workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github/workflows/ci.yml"),
          `name: ci\njobs:\n  t:\n    steps:\n      - run: ${e.run}\n`,
        );
        writeFileSync(
          join(dir, "playwright.config.ts"),
          'export default defineConfig({ testDir: "./e2e", testMatch: "**/*.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e/sub"), { recursive: true });
        for (const spec of ["x", "y", "sub/z"]) writeFileSync(join(dir, `e2e/${spec}.spec.ts`), "");
        if (e.clean) assert.deepEqual(playwrightInventory(dir).orphans, [], e.name);
        else
          assert.throws(
            () => playwrightInventory(dir),
            /cannot resolve playwright runs outside the repo root/,
            e.name,
          );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  check("playwright ambiguous named imports of specs fail closed", () => {
    const entries = [
      // Named bindings are ambiguous without usage analysis (Playwright's
      // Babel elides bindings never used as values), so they fail closed
      // whether or not the binding looks used.
      { name: "named import", head: 'import { a } from "./suite.visual";', expect: "throw" },
      {
        name: "named import used",
        head: 'import { a } from "./suite.visual";\nconsole.log(a);',
        expect: "throw",
      },
      { name: "default import", head: 'import foo from "./suite.visual";', expect: "throw" },
      { name: "namespace import", head: 'import * as ns from "./suite.visual";', expect: "throw" },
      {
        name: "multiline named import",
        head: 'import {\n a\n} from "./suite.visual";',
        expect: "throw",
      },
      { name: "import-equals", head: 'import X = require("./suite.visual");', expect: "throw" },
      // Inline `type` specifiers are erased deterministically: no edge, and
      // no failure. Unmarked re-exports, require calls and dynamic literal
      // imports load the module and stay edges.
      {
        name: "inline type-only",
        head: 'import { type A } from "./suite.visual";',
        expect: "orphan",
      },
      {
        name: "multiline inline type-only",
        head: 'import {\n type A\n} from "./suite.visual";',
        expect: "orphan",
      },
      {
        name: "export inline type",
        head: 'export { type A } from "./suite.visual";',
        expect: "orphan",
      },
      { name: "export named", head: 'export { a } from "./suite.visual";', expect: "reachable" },
      { name: "export star", head: 'export * from "./suite.visual";', expect: "reachable" },
      { name: "require call", head: 'const x = require("./suite.visual");', expect: "reachable" },
      {
        name: "dynamic literal import",
        head: 'await import("./suite.visual");',
        expect: "reachable",
      },
      // A mid-line `import type` after a genuine edge: the classifier (not
      // the line-start skipper) must skip the type-only clause.
      {
        name: "mid-line type import after edge",
        head: 'import "./suite.visual"; import type { T } from "./other.visual";',
        expect: "other",
        typed: true,
      },
    ];
    for (const e of entries) {
      const dir = mkdtempSync(join(tmpdir(), "test-inventory-pw-"));
      try {
        writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: {} }));
        mkdirSync(join(dir, ".github", "workflows"), { recursive: true });
        writeFileSync(
          join(dir, ".github", "workflows", "ci.yml"),
          "name: ci\njobs:\n  t:\n    steps:\n      - run: npx playwright test --config playwright.am.config.ts\n",
        );
        writeFileSync(
          join(dir, "playwright.am.config.ts"),
          'import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./e2e/entry", testMatch: "entry.spec.ts" });\n',
        );
        mkdirSync(join(dir, "e2e", "entry"), { recursive: true });
        writeFileSync(
          join(dir, "e2e", "entry", "entry.spec.ts"),
          `${e.head}\nimport { test } from "@playwright/test";\ntest("x", async () => {});\n`,
        );
        writeFileSync(
          join(dir, "e2e", "entry", "suite.visual.ts"),
          'import { test } from "@playwright/test";\ntest("y", async () => {});\n',
        );
        if (e.typed) {
          writeFileSync(
            join(dir, "e2e", "entry", "other.visual.ts"),
            'import { test } from "@playwright/test";\ntest("z", async () => {});\n',
          );
        }
        if (e.expect === "throw") {
          assert.throws(() => playwrightInventory(dir), /ambiguously imports/, e.name);
        } else {
          const expected =
            e.expect === "orphan"
              ? ["e2e/entry/suite.visual.ts"]
              : e.expect === "other"
                ? ["e2e/entry/other.visual.ts"]
                : [];
          assert.deepEqual(playwrightInventory(dir).orphans, expected, e.name);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  console.log(`test inventory selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  let root = repoRoot;
  const flags = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--root" && i + 1 < args.length) {
      root = resolve(args[i + 1]);
      i += 1;
    } else {
      flags.push(args[i]);
    }
  }
  const unknown = flags.filter((a) => a !== "--selftest" && a !== "--strict" && a !== "--json");
  if (unknown.length) {
    console.error(
      "Usage: node ci/test-inventory.mjs [--selftest] [--strict] [--json] [--root <dir>]",
    );
    process.exitCode = 2;
  } else if (flags.includes("--selftest")) {
    process.exitCode = selftest();
  } else if (flags.includes("--json")) {
    // Agent-consumable Playwright summary only; the exit code still reflects
    // every gate under --strict, like the human output below.
    console.log(JSON.stringify(playwrightJsonSummary(root)));
    const { orphans } = inventory(root);
    const pw = playwrightInventory(root);
    if (orphans.length + pw.orphans.length && flags.includes("--strict")) process.exitCode = 1;
  } else {
    const { files, orphans } = inventory(root);
    const pw = playwrightInventory(root);
    console.log(
      `test inventory: ${files.length - orphans.length}/${files.length} test files reachable from CI.`,
    );
    console.log(
      `playwright inventory: ${pw.files.length - pw.orphans.length}/${pw.files.length} specs reachable from CI.`,
    );
    for (const f of orphans) {
      console.log(`::warning file=${f}::test file is not reachable from any CI job`);
      console.log(`orphan: ${f}`);
    }
    for (const f of pw.orphans) {
      console.log(`::warning file=${f}::playwright spec is not reachable from any CI job`);
      console.log(`orphan: ${f}`);
    }
    if (orphans.length + pw.orphans.length && flags.includes("--strict")) process.exitCode = 1;
  }
}
