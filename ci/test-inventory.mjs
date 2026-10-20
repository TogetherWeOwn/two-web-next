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
// --selftest runs the fixture suite below and exits 0/1 on pass/fail.
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
  const unknown = flags.filter((a) => a !== "--selftest" && a !== "--strict");
  if (unknown.length) {
    console.error("Usage: node ci/test-inventory.mjs [--selftest] [--strict] [--root <dir>]");
    process.exitCode = 2;
  } else if (flags.includes("--selftest")) {
    process.exitCode = selftest();
  } else {
    const { files, orphans } = inventory(root);
    console.log(
      `test inventory: ${files.length - orphans.length}/${files.length} test files reachable from CI.`,
    );
    for (const f of orphans) {
      console.log(`::warning file=${f}::test file is not reachable from any CI job`);
      console.log(`orphan: ${f}`);
    }
    if (orphans.length && flags.includes("--strict")) process.exitCode = 1;
  }
}
