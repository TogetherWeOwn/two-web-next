import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import {
  ARTIFACTS,
  ROLES,
  build,
  generate,
  parseKit,
  roleDeclarations,
} from "./build-ember-tokens.mjs";
import { check } from "./check-ember-token-sync.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SCRIPT = join(ROOT, "ci/check-ember-token-sync.mjs");
const KIT = "vendor/design-kit/tokens.css";

function lastJsonLine(out) {
  return JSON.parse(out.trim().split("\n").at(-1));
}

// Scratch root with only the generator inputs; artifacts are not copied.
function withScratch(fn) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "ember-sync-"));
  try {
    cpSync(join(ROOT, "vendor/design-kit"), join(root, "vendor/design-kit"), { recursive: true });
    mkdirSync(join(root, "assets"), { recursive: true });
    cpSync(join(ROOT, "assets/theme.css"), join(root, "assets/theme.css"));
    cpSync(join(ROOT, "assets/styles.css"), join(root, "assets/styles.css"));
    mkdirSync(join(root, "public"), { recursive: true });
    mkdirSync(join(root, "web/src"), { recursive: true });
    return fn(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const kitCss = () => readFileSync(join(ROOT, KIT), "utf8");
const realKit = () => parseKit(kitCss());
const mutateKit = (root, edit) =>
  writeFileSync(join(root, KIT), edit(readFileSync(join(root, KIT), "utf8")));

test("generation is exact, repeatable and leaves the real repo untouched", () => {
  const before = ARTIFACTS.map((path) => readFileSync(join(ROOT, path), "utf8"));
  const first = generate(ROOT);
  const second = generate(ROOT);
  assert.deepEqual([...first.keys()], ARTIFACTS);
  ARTIFACTS.forEach((path, index) => {
    assert.equal(first.get(path), second.get(path), `${path} repeatable`);
    assert.equal(first.get(path), before[index], `${path} checked in matches generation`);
  });
  withScratch((root) => {
    build(root);
    const once = ARTIFACTS.map((path) => readFileSync(join(root, path), "utf8"));
    build(root);
    assert.deepEqual(
      ARTIFACTS.map((path) => readFileSync(join(root, path), "utf8")),
      once,
    );
    assert.equal(check(root).ok, true);
  });
  assert.deepEqual(
    ARTIFACTS.map((path) => readFileSync(join(ROOT, path), "utf8")),
    before,
  );
});

test("generated Hono sheets fit every original raw and gzip ceiling", () => {
  const outputs = generate(ROOT);
  for (const [path, raw, gzip] of [
    ["public/styles.css", 6144, 2048],
    ["public/theme-tokens.css", 1536, 512],
    ["public/theme.css", 15360, 3584],
  ]) {
    const bytes = Buffer.from(outputs.get(path) ?? readFileSync(join(ROOT, path), "utf8"));
    assert.ok(bytes.length <= raw, `${path}: ${bytes.length} raw bytes exceeds ${raw}`);
    assert.ok(gzipSync(bytes).length <= gzip, `${path}: gzip exceeds ${gzip}`);
  }
});

test("Hono exposes each role once across the existing three-sheet bundle", () => {
  const outputs = generate(ROOT);
  const css = ["public/styles.css", "public/theme-tokens.css", "public/theme.css"]
    .map((path) => outputs.get(path))
    .join("\n")
    .split("@media(prefers-reduced-motion:reduce)")[0];
  for (const [alias] of ROLES) {
    assert.equal([...css.matchAll(new RegExp(`--${alias}:`, "g"))].length, 1, alias);
  }
  const styles = outputs.get("public/styles.css");
  assert.match(styles, /\.base-theme\{--font-size-hero:/);
  assert.ok(!outputs.get("public/theme.css").includes("--font-size-hero:"));
  assert.ok(!outputs.get("public/theme-tokens.css").includes("--font-size-hero:"));
});

test("every required role group resolves from the kit", () => {
  const roles = roleDeclarations(realKit());
  const aliases = new Set(roles.map(([alias]) => alias));
  assert.equal(aliases.size, ROLES.length);
  const groups = {
    ground: /^g[0-4]$/,
    hair: /^hair[12]$/,
    text: /^t[123]$/,
    accent: /^(ember|on-accent|accent-hi|border)$/,
    status: /^(live|echo|ok|danger|warn)(-bg)?$/,
    focus: /^focus-/,
    space: /^space-/,
    radius: /^radius-/,
    fontSize: /^font-size-/,
    tracking: /^tracking-/,
    family: /^font-(display|accent|data)$/,
    weight: /^font-weight-/,
    width: /^font-width-/,
    lineHeight: /^line-height-/,
    motion: /^motion-/,
    gradient: /^gradient-brand$/,
  };
  for (const [group, pattern] of Object.entries(groups)) {
    assert.ok(
      [...aliases].some((alias) => pattern.test(alias)),
      `role group ${group} present`,
    );
  }
  for (const [alias, , value] of roles) assert.ok(value, `${alias} has a value`);
  assert.match(roles.find(([alias]) => alias === "font-display")[2], /Mona Sans Fallback/);
});

test("a missing kit role fails generation", () => {
  withScratch((root) => {
    mutateKit(root, (css) => css.replace(/\s*--two-color-ground-3:[^;]*;/, ""));
    assert.throws(() => build(root), /missing kit role --two-color-ground-3/);
    for (const path of ARTIFACTS) assert.ok(!existsSync(join(root, path)), `${path} not written`);
  });
  assert.throws(() => roleDeclarations(realKit(), [["x", "color-nope"]]), /missing kit role/);
});

test("alias collisions and invalid aliases are rejected", () => {
  const kit = realKit();
  assert.throws(
    () =>
      roleDeclarations(kit, [
        ["g0", "color-ground-0"],
        ["g0", "color-ground-1"],
      ]),
    /alias collision/,
  );
  assert.throws(() => roleDeclarations(kit, [["Bad Alias", "color-ground-0"]]), /invalid alias/);
});

test("duplicate and unknown kit CSS structure is rejected", () => {
  const css = kitCss();
  assert.throws(
    () => parseKit(css.replace("--two-page:", "--two-surface: #000;\n  --two-page:")),
    /duplicate kit declaration/,
  );
  assert.throws(() => parseKit(`${css}\n.extra { color: red; }`), /unknown kit CSS structure/);
  assert.throws(() => parseKit(":root { color-scheme: dark; }"), /unknown kit CSS structure/);
  assert.throws(
    () => parseKit(css.replace("color-scheme: dark", "color-scheme: light")),
    /dark only/,
  );
  assert.throws(
    () => parseKit(css.replace("--two-page: #15100f", "--two-page: var(--x)")),
    /unresolved or unsafe/,
  );
  assert.throws(
    () =>
      parseKit(
        css.replace(
          /(prefers-reduced-motion: reduce\) \{\s*:root \{)/,
          "$1\n    --two-page: #000;",
        ),
      ),
    /unknown reduced-motion role/,
  );
  withScratch((root) => {
    mutateKit(root, (text) => `${text}\n.extra { color: red; }`);
    assert.throws(() => build(root), /unknown kit CSS structure/);
  });
});

test("base and reduced-motion declarations stay separate", () => {
  const kit = realKit();
  assert.ok(kit.reduced.size > 0);
  for (const name of kit.reduced.keys()) {
    assert.ok(name.startsWith("--two-motion-"), name);
    assert.ok(kit.base.has(name), `${name} has a base value`);
    assert.notEqual(kit.base.get(name), kit.reduced.get(name), `${name} reduced differs from base`);
  }
  const out = generate(ROOT);
  const hono = out.get("public/theme.css");
  const [baseCss, reducedCss] = hono.split("@media(prefers-reduced-motion:reduce)");
  assert.ok(reducedCss, "reduced-motion block emitted");
  assert.match(baseCss, /--motion-duration-fast:\.12s/, "minified base keeps the kit duration");
  const reducedBlock = reducedCss.slice(0, reducedCss.indexOf("}}") + 2);
  assert.ok(reducedBlock.includes("--motion-duration-fast:0ms"));
  assert.ok(
    !/--(g0|t1|space-1|ember)\b/.test(reducedBlock),
    "reduced block holds only motion roles",
  );
  assert.ok(
    !baseCss.includes("--motion-duration-fast:0ms"),
    "base block keeps non-reduced motion values",
  );
});

test("missing, stale and edited artifacts each fail the check", () => {
  withScratch((root) => {
    assert.throws(() => check(root), /ENOENT|generated token drift/, "missing before build");
    build(root);
    assert.equal(check(root).ok, true);
    for (const path of ARTIFACTS) {
      const file = join(root, path);
      const good = readFileSync(file, "utf8");
      try {
        rmSync(file);
        assert.throws(() => check(root), /ENOENT|generated token drift/, `${path} missing`);
        writeFileSync(file, `${good}\n/* edited */`);
        assert.throws(
          () => check(root),
          { message: `generated token drift: ${path}` },
          `${path} edited`,
        );
        writeFileSync(file, "");
        assert.throws(() => check(root), /generated token drift/, `${path} emptied`);
      } finally {
        writeFileSync(file, good);
      }
      assert.equal(check(root).ok, true, `${path} restored`);
    }
  });
});

test("stale artifacts after a kit or theme source change fail the check", () => {
  withScratch((root) => {
    build(root);
    mutateKit(root, (css) => css.replace("#f6f1ea", "#ffffff"));
    assert.throws(() => check(root), /generated token drift/, "kit value change");
    mutateKit(root, (css) => css.replace("#ffffff", "#f6f1ea"));
    assert.equal(check(root).ok, true);
    const theme = join(root, "assets/theme.css");
    writeFileSync(theme, `${readFileSync(theme, "utf8")}\n.ember-sync-probe{color:#123456}\n`);
    assert.throws(() => check(root), /generated token drift: public\/theme\.css/);
    build(root);
    const shared = join(root, "assets/styles.css");
    writeFileSync(shared, `${readFileSync(shared, "utf8")}\n.ember-shared-probe{color:#123456}\n`);
    assert.throws(() => check(root), /generated token drift: public\/styles\.css/);
  });
});

for (const [directory, hooks] of [
  [".", ["postinstall", "predev"]],
  ["web", ["postinstall", "prebuild"]],
]) {
  for (const hook of hooks) {
    test(`${directory} ${hook} rejects drift without repairing tracked outputs`, () => {
      withScratch((root) => {
        mkdirSync(join(root, "ci"));
        mkdirSync(join(root, "src"));
        for (const path of [
          "package.json",
          "web/package.json",
          "ci/build-ember-tokens.mjs",
          "ci/build-leaf-css.mjs",
          "public/styles.css",
        ]) {
          cpSync(join(ROOT, path), join(root, path));
        }
        symlinkSync(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
        build(root);
        const run = () =>
          execFileSync("npm", ["run", hook, "--ignore-scripts"], {
            cwd: join(root, directory),
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            timeout: 30_000,
          });
        const leaf = join(root, "src/leaf-critical-css.ts");
        const assertRejected = () => {
          const before = ARTIFACTS.map((path) =>
            existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null,
          );
          writeFileSync(leaf, "leaf must not be regenerated after adapter failure");
          assert.throws(run, (error) => {
            assert.equal(error.status, 1);
            assert.match(error.stderr, /generated token drift|ENOENT/);
            return true;
          });
          assert.deepEqual(
            ARTIFACTS.map((path) =>
              existsSync(join(root, path)) ? readFileSync(join(root, path), "utf8") : null,
            ),
            before,
            "tracked artifacts remain untouched, including missing outputs",
          );
          assert.equal(
            readFileSync(leaf, "utf8"),
            "leaf must not be regenerated after adapter failure",
          );
        };
        for (const path of ARTIFACTS) {
          const file = join(root, path);
          const good = readFileSync(file, "utf8");
          writeFileSync(file, `${good}\n/* stale */`);
          assertRejected();
          rmSync(file);
          assertRejected();
          writeFileSync(file, good);
        }
        const theme = join(root, "assets/theme.css");
        const source = readFileSync(theme, "utf8");
        writeFileSync(theme, `${source}\n.ember-lifecycle-probe{color:#123456}`);
        assertRejected();
        writeFileSync(theme, source);
        run();
        assert.equal(check(root).ok, true);
        assert.match(readFileSync(leaf, "utf8"), /^\/\/ GENERATED from public\/styles\.css/);
      });
    });
  }
}

test("ember token sync selftest passes on the wired sheets", () => {
  const out = execFileSync("node", [SCRIPT, "--selftest"], { encoding: "utf8" });
  const parsed = lastJsonLine(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.mode, "selftest");
  assert.match(parsed.summary, /ember token sync selftest ok/);
});

test("ember token sync check passes on the wired sheets", () => {
  const out = execFileSync("node", [SCRIPT], { encoding: "utf8" });
  const parsed = lastJsonLine(out);
  assert.equal(parsed.ok, true);
  assert.match(parsed.summary, /ember token sync ok/);
});

test("unknown flags are a usage error", () => {
  assert.throws(
    () =>
      execFileSync("node", [SCRIPT, "--bogus"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    (error) => {
      assert.equal(error.status, 2);
      return true;
    },
  );
});
