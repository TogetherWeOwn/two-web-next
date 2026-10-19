// CI-inventory check (HARD): every *.test.ts / *.test.mjs must be reachable
// from a CI job. A test file nobody runs is worse than no test: it claims
// coverage the suite never verifies.
//
// Reachability rules (vitest.config.ts + package.json + workflows):
// - test/** matches the vitest `include` globs, except the files the config
//   `exclude`s (parsed live from vitest.config.ts, never mirrored by hand:
//   literals plus `*`/`**` globs expanded against the files on disk).
//   An excluded file runs via `npm run test:smoke` instead, and counts as
//   reachable only while that command still names it (a mention anywhere
//   else is not a run).
// - tier0/** matches the Tier-0 config (`tier0/vitest.config.ts`, run via
//   `npm run test:tier0`); reachable only while that wiring names it.
// - ci/** and e2e/** have no glob runner: each file must be named in a
//   package.json script or a .github/workflows/*.yml step.
// - test/helpers/** and other non-*.test.* files are fixtures, not tests.
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

// The test/** files vitest skips, parsed from the `exclude` array in
// <root>/vitest.config.ts. Derived, not mirrored, so the gate cannot drift
// from the config. Literals land here; `*` globs are expanded against the
// files on disk by vitestExcludeGlobs (a glob-excluded suite needs smoke
// wiring too, never a silent vitest-reachable). A root without the config
// (hermetic fixtures) excludes nothing.
export function vitestExcludedTests(root = repoRoot) {
  const configPath = join(root, "vitest.config.ts");
  if (!existsSync(configPath)) return new Set();
  const text = readFileSync(configPath, "utf8");
  const start = text.indexOf("exclude:");
  assert.ok(start !== -1, `${configPath} has no exclude block`);
  const end = text.indexOf("]", start);
  assert.ok(end !== -1, `${configPath} exclude block never closes`);
  const files = [...text.slice(start, end).matchAll(/"([^"]+\.test\.(?:ts|mjs))"/g)]
    .map((m) => m[1])
    .filter((f) => f.startsWith("test/") && !f.includes("*"));
  return new Set(files);
}

// Every `*`/`**` entry in the vitest `exclude` array. Expanded against the
// discovered test files so a glob-excluded suite cannot read as
// vitest-reachable, however the glob is prefixed (`test/…`, `**/…`).
// Entries matching nothing (node_modules, dist) expand to the empty set.
export function vitestExcludeGlobs(root = repoRoot) {
  const configPath = join(root, "vitest.config.ts");
  if (!existsSync(configPath)) return [];
  const text = readFileSync(configPath, "utf8");
  const start = text.indexOf("exclude:");
  assert.ok(start !== -1, `${configPath} has no exclude block`);
  const end = text.indexOf("]", start);
  assert.ok(end !== -1, `${configPath} exclude block never closes`);
  return [...text.slice(start, end).matchAll(/"([^"]+)"/g)]
    .map((m) => m[1])
    .filter((g) => g.includes("*"));
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
  // Glob excludes (e.g. "test/smoke-*.test.mjs") expand against the files on
  // disk: a glob-excluded suite needs test:smoke wiring like a literal one,
  // instead of silently reading as vitest-reachable.
  const excludeGlobs = vitestExcludeGlobs(root);
  for (const file of testFiles) {
    if (excludeGlobs.some((g) => globToRegExp(g).test(file))) smokeExcluded.add(file);
  }
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
