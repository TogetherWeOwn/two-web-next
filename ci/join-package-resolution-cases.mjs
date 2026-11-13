import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

async function manifest(dir, data) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify(data));
}

async function moduleFile(dir, name, value) {
  const path = join(dir, name);
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `export default ${JSON.stringify(value)};`);
}

// Register the same observable import cases for native Node and a resolver adapter.
export function registerPackageResolutionCases(label, load) {
  async function fixture(t) {
    const root = await mkdtemp(join(tmpdir(), "join-package-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    return root;
  }
  const value = async (root, specifier) => (await load(root, specifier)).default;
  const rejects = (root, specifier, code) =>
    assert.rejects(
      Promise.resolve().then(() => load(root, specifier)),
      { code },
    );

  test(`${label}: scoped subpaths and import conditions`, async (t) => {
    const root = await fixture(t);
    const dir = join(root, "node_modules", "@fixture", "pkg");
    await manifest(dir, {
      exports: { "./part": { require: "./wrong.cjs", import: "./part.mjs" } },
    });
    await moduleFile(dir, "part.mjs", "import");
    assert.equal(await value(root, "@fixture/pkg/part"), "import");
    await rejects(root, "@fixture/pkg/private", "ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  test(`${label}: legacy main, index and URL subpaths`, async (t) => {
    const root = await fixture(t);
    const main = join(root, "node_modules", "legacy-main");
    await manifest(main, { main: "index.cjs" });
    await writeFile(join(main, "index.cjs"), 'module.exports = "legacy";');
    const index = join(root, "node_modules", "legacy-index");
    await mkdir(index, { recursive: true });
    await writeFile(join(index, "index"), 'module.exports = "wrong";');
    await writeFile(join(index, "index.js"), 'module.exports = "index";');
    await moduleFile(index, "space name.mjs", "decoded");
    assert.equal(await value(root, "legacy-main"), "legacy");
    assert.equal(await value(root, "legacy-index"), "index");
    assert.equal(await value(root, "legacy-index/space%20name.mjs"), "decoded");
    await rejects(root, "legacy-index/space%2fname.mjs", "ERR_INVALID_MODULE_SPECIFIER");
  });

  test(`${label}: export condition order and pattern specificity`, async (t) => {
    const root = await fixture(t);
    const dir = join(root, "node_modules", "ranked-pkg");
    await manifest(dir, {
      exports: {
        ".": { default: "./default.mjs", import: "./import.mjs" },
        "./*": "./general.mjs",
        "./feature/*": "./specific.mjs",
        "./feature/*.js": "./suffix.mjs",
        "./feature/exact.js": "./exact.mjs",
      },
    });
    for (const name of ["default", "general", "specific", "suffix", "exact"]) {
      await moduleFile(dir, `${name}.mjs`, name);
    }
    assert.equal(await value(root, "ranked-pkg"), "default");
    assert.equal(await value(root, "ranked-pkg/feature/exact.js"), "exact");
    assert.equal(await value(root, "ranked-pkg/feature/other.js"), "suffix");
    assert.equal(await value(root, "ranked-pkg/feature/other"), "specific");
    assert.equal(await value(root, "ranked-pkg/other"), "general");
  });

  test(`${label}: ordered conditions in export patterns`, async (t) => {
    const root = await fixture(t);
    const dir = join(root, "node_modules", "pattern-pkg");
    await manifest(dir, {
      exports: {
        "./default/*": { default: "./default/*.mjs", import: "./wrong/*.mjs" },
        "./import/*": { import: "./import/*.mjs", default: "./wrong/*.mjs" },
      },
    });
    await moduleFile(dir, "default/part.mjs", "default-first");
    await moduleFile(dir, "import/part.mjs", "import-first");
    assert.equal(await value(root, "pattern-pkg/default/part"), "default-first");
    assert.equal(await value(root, "pattern-pkg/import/part"), "import-first");
  });

  test(`${label}: module execution failures propagate with a competing web package`, async (t) => {
    const root = await fixture(t);
    const dir = join(root, "node_modules", "execution-pkg");
    await manifest(dir, { exports: "./index.mjs" });
    await writeFile(join(dir, "index.mjs"), 'throw new Error("fixture execution failed");');
    const web = join(root, "web", "node_modules", "execution-pkg");
    await manifest(web, { exports: "./index.mjs" });
    await moduleFile(web, "index.mjs", "web");
    await assert.rejects(
      Promise.resolve().then(() => load(root, "execution-pkg")),
      {
        message: "fixture execution failed",
      },
    );
  });

  test(`${label}: self-reference takes precedence over installed packages`, async (t) => {
    const root = await fixture(t);
    await manifest(root, { name: "self-pkg", exports: { ".": "./self.mjs" } });
    await moduleFile(root, "self.mjs", "self");
    for (const base of [root, join(root, "web")]) {
      const dir = join(base, "node_modules", "self-pkg");
      await manifest(dir, { exports: { ".": "./index.mjs", "./private": "./index.mjs" } });
      await moduleFile(dir, "index.mjs", "installed");
    }
    assert.equal(await value(root, "self-pkg"), "self");
    await rejects(root, "self-pkg/private", "ERR_PACKAGE_PATH_NOT_EXPORTED");
  });

  test(`${label}: bare-package import aliases`, async (t) => {
    const root = await fixture(t);
    await manifest(root, {
      imports: { "#package": "alias-pkg", "#scoped": "@fixture/alias/part" },
    });
    const bare = join(root, "node_modules", "alias-pkg");
    await manifest(bare, { exports: "./index.mjs" });
    await moduleFile(bare, "index.mjs", "bare");
    const scoped = join(root, "node_modules", "@fixture", "alias");
    await manifest(scoped, { exports: { "./part": "./part.mjs" } });
    await moduleFile(scoped, "part.mjs", "scoped");
    assert.equal(await value(root, "#package"), "bare");
    assert.equal(await value(root, "#scoped"), "scoped");
  });

  test(`${label}: aliases and literal wildcard replacement`, async (t) => {
    const root = await fixture(t);
    await manifest(root, {
      imports: {
        "#relative": { import: "./runtime.mjs", require: "./wrong.cjs" },
        "#package": "wild-pkg/$&",
        "#wild/*": "wild-pkg/*",
        "#blocked": null,
      },
    });
    await moduleFile(root, "runtime.mjs", "relative");
    const dir = join(root, "node_modules", "wild-pkg");
    await manifest(dir, { exports: { "./*": "./*.mjs" } });
    await moduleFile(dir, "$&.mjs", "literal");
    assert.equal(await value(root, "#relative"), "relative");
    for (const specifier of ["wild-pkg/$&", "#package", "#wild/$&"]) {
      assert.equal(await value(root, specifier), "literal");
    }
    await rejects(root, "#blocked", "ERR_PACKAGE_IMPORT_NOT_DEFINED");
    await rejects(root, "#missing", "ERR_PACKAGE_IMPORT_NOT_DEFINED");
  });

  test(`${label}: invalid targets and array fallback`, async (t) => {
    const root = await fixture(t);
    const dir = join(root, "node_modules", "target-pkg");
    await manifest(dir, {
      exports: {
        ".": ["../outside.mjs", "./index.mjs"],
        "./bad": "./nested/%2e%2e/outside.mjs",
        "./wild/*": "./nested/*.mjs",
      },
    });
    await moduleFile(dir, "index.mjs", "fallback");
    assert.equal(await value(root, "target-pkg"), "fallback");
    await rejects(root, "target-pkg/bad", "ERR_INVALID_PACKAGE_TARGET");
    await rejects(root, "target-pkg/wild/%2e%2e/escape", "ERR_INVALID_MODULE_SPECIFIER");
    await rejects(root, "missing-pkg", "ERR_MODULE_NOT_FOUND");
  });
}
