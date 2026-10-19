// CI-inventory check (HARD): every *.test.ts / *.test.mjs must be reachable
// from a CI job. A test file nobody runs is worse than no test: it claims
// coverage the suite never verifies.
//
// Reachability rules (vitest.config.ts + package.json + workflows):
// - test/** matches the vitest `include` globs, except the files the config
//   `exclude`s (parsed live from vitest.config.ts, never mirrored by hand).
//   An excluded file runs via `npm run test:smoke` instead, and counts as
//   reachable only while that script still names it.
// - tier0/** matches the Tier-0 config (`tier0/vitest.config.ts`, run via
//   `npm run test:tier0`); reachable only while that wiring names it.
// - ci/** and e2e/** have no glob runner: each file must be named in a
//   package.json script or a .github/workflows/*.yml step.
// - test/helpers/** and other non-*.test.* files are fixtures, not tests.
//
// Modes: default prints ::warning:: per orphan and exits 0 (triage runs).
// --strict exits 1 on any orphan; CI runs --strict (HARD).
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
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const VITEST_TEST_DIRS = ["test"];

// The test/** files vitest skips, parsed from the `exclude` array in
// <root>/vitest.config.ts. Derived, not mirrored, so the gate cannot drift
// from the config: only literal test/** test paths count (configDefaults and
// glob entries never match a concrete file). A root without the config
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
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);
}

function referencedInCi(file, haystack) {
  if (haystack.includes(file)) return true;
  const tokens = haystack.match(/[A-Za-z0-9_./-]*\*[^ \t\n"'`]*\.test\.mjs/g) ?? [];
  return tokens.some((t) => globToRegExp(t).test(file));
}

export function inventory(root = repoRoot) {
  const haystack = collectHaystack(root);
  const smokeExcluded = vitestExcludedTests(root);
  const files = [
    ...VITEST_TEST_DIRS.flatMap((d) => listTestFiles(root, d)),
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
      // A vitest-excluded file is reachable only when test:smoke still names it.
      if (smokeExcluded.has(file) && !referencedInCi(file, haystack)) via = null;
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

  console.log(`test inventory selftest: ${cases} cases passed.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--selftest" && a !== "--strict");
  if (unknown.length) {
    console.error("Usage: node ci/test-inventory.mjs [--selftest] [--strict]");
    process.exitCode = 2;
  } else if (args.includes("--selftest")) {
    process.exitCode = selftest();
  } else {
    const { files, orphans } = inventory(repoRoot);
    console.log(
      `test inventory: ${files.length - orphans.length}/${files.length} test files reachable from CI.`,
    );
    for (const f of orphans) {
      console.log(`::warning file=${f}::test file is not reachable from any CI job`);
      console.log(`orphan: ${f}`);
    }
    if (orphans.length && args.includes("--strict")) process.exitCode = 1;
  }
}
