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
//   entrypoint imports its member-board-viewer suite this way).
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

function collectWorkflowFiles(root) {
  const out = [];
  const wfDir = join(root, ".github", "workflows");
  if (!existsSync(wfDir)) return out;
  for (const e of readdirSync(wfDir)) {
    if (e.endsWith(".yml") || e.endsWith(".yaml"))
      out.push({ name: `.github/workflows/${e}`, text: readFileSync(join(wfDir, e), "utf8") });
  }
  return out;
}

// Script names CI actually runs, transitively: a workflow `npm run a` marks
// `a` invoked, and `a`'s own `npm run b` marks `b`. Anything else in
// package.json is a local helper, not a CI run.
function invokedScriptNames(scripts, workflowText) {
  const invoked = new Set();
  const queue = [];
  const scan = (text) => {
    for (const m of text.matchAll(/npm\s+run(?:-script)?\s+([A-Za-z0-9_:\-./]+)/g)) {
      const name = m[1];
      if (Object.hasOwn(scripts, name) && !invoked.has(name)) {
        invoked.add(name);
        queue.push(name);
      }
    }
  };
  scan(workflowText);
  while (queue.length) scan(scripts[queue.shift()] ?? "");
  return invoked;
}

function stripYamlComment(line) {
  if (/^\s*#/.test(line)) return "";
  const hash = line.indexOf(" #");
  return hash === -1 ? line : line.slice(0, hash);
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
  for (const { name, text } of workflowFiles) {
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      const line = stripYamlComment(lines[i]);
      const at = line.search(/\bplaywright\s+test\b/);
      if (at === -1) continue;
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
    if (colon === -1) continue;
    const key = entryCode.slice(0, colon).trim();
    if (key !== "testDir" && key !== "testMatch" && key !== "testIgnore") continue;
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
  const bases = [];
  let testDir = null;
  let testMatch = null;
  let testIgnore = null;
  let projects = null;
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
      bases.push(parsePlaywrightConfig(root, candidate, seen));
      continue;
    }
    const colon = entryCode.indexOf(":");
    if (colon === -1) continue;
    const key = entryCode.slice(0, colon).trim();
    if (key !== "testDir" && key !== "testMatch" && key !== "testIgnore" && key !== "projects")
      continue;
    const valueClean = clean.slice(start, end).slice(colon + 1);
    const valueCode = entryCode.slice(colon + 1);
    if (key === "testDir") testDir = parsePlainString(valueClean, configPath, "testDir");
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
      projects = [];
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
        projects.push(
          parseProjectObject(
            pClean.slice(pOpen + 1, pClose),
            pCode.slice(pOpen + 1, pClose),
            configPath,
          ),
        );
      }
    } else {
      const parsed = parseTestMatchValue(valueClean, valueCode, configPath, key);
      if (key === "testMatch") testMatch = parsed;
      else testIgnore = parsed;
    }
  }
  const merged = { testDir: null, testMatch: null, testIgnore: null, projects: null };
  for (const base of bases) {
    if (base.testDir !== null) merged.testDir = base.testDir;
    if (base.testMatch !== null) merged.testMatch = base.testMatch;
    if (base.testIgnore !== null) merged.testIgnore = base.testIgnore;
    if (base.projects !== null) merged.projects = base.projects;
  }
  if (testDir !== null) merged.testDir = testDir;
  if (testMatch !== null) merged.testMatch = testMatch;
  if (testIgnore !== null) merged.testIgnore = testIgnore;
  if (projects !== null) merged.projects = projects;
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
    assert.ok(
      p.split("/").every((part) => part && part !== "." && part !== ".."),
      `${configPath} has a non-canonical pattern (${p}): use paths without empty, . or .. segments`,
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

// Playwright matches testMatch/testIgnore against the file path; whether the
// basis is testDir-relative or repo-relative is version-dependent, so a
// pattern matching either basis counts. Lenient toward reachable, never
// toward orphans: a file any Playwright would run still passes.
function patternMatchesFile(patterns, file, testDir) {
  const candidates = [file];
  if (testDir !== "." && file.startsWith(`${testDir}/`))
    candidates.push(file.slice(testDir.length + 1));
  else if (testDir === ".") candidates.push(file);
  return patterns.some((p) => {
    const re = globToRegExp(p);
    return candidates.some((c) => re.test(c));
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
    if (!patternMatchesFile(matchPatterns, file, testDir)) return false;
    const testIgnore = project.testIgnore ?? parsed.testIgnore ?? [];
    if (!testIgnore.length) return true;
    const ignorePatterns = testIgnore.flatMap((p) => expandBraces(p, configRel));
    assertSupportedPlaywrightPatterns(ignorePatterns, configRel);
    return !patternMatchesFile(ignorePatterns, file, testDir);
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
  for (const line of lines) {
    for (const re of [
      /\bfrom\s*(['"])([^'"]+)\1/g,
      /\bimport\s*(['"])([^'"]+)\1/g,
      /\brequire\s*\(\s*(['"])([^'"]+)\1/g,
      /\bimport\s*\(\s*(['"])([^'"]+)\1/g,
    ]) {
      for (const m of line.matchAll(re)) specs.add(m[2]);
    }
  }
  const out = [];
  for (const spec of specs) {
    const resolved = resolveRelativeImport(spec, file, root);
    if (resolved) out.push(resolved);
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
