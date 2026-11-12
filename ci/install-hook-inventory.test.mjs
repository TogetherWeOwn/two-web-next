import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { inventoryHooks, REVIEWED_ROOT_HOOKS, sha256 } from "./install-hook-inventory.mjs";

const roots = [];
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});
const put = (root, path, data) => {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, data);
};
const fixture = (scripts, packages = {}) => {
  const root = mkdtempSync(join(tmpdir(), "hook-inventory-"));
  roots.push(root);
  put(root, "package.json", JSON.stringify({ scripts }));
  put(root, "package-lock.json", JSON.stringify({ packages: { "": {}, ...packages } }));
  return root;
};

describe("hook inventory", () => {
  it("records reviewed generators, dependency candidates and non-registry sources", () => {
    const root = fixture(REVIEWED_ROOT_HOOKS, {
      "node_modules/esbuild": {
        version: "0.28.2",
        hasInstallScript: true,
        optional: true,
        resolved: "https://registry.npmjs.org/esbuild/-/esbuild-0.28.2.tgz",
        integrity: "sha512-x",
      },
      "node_modules/vendored": { version: "1.0.0", resolved: "git+https://example.com/x.git" },
    });
    put(root, "ci/build-ember-tokens.mjs", "first");
    put(root, "ci/build-leaf-css.mjs", "second");
    put(
      root,
      "web/package.json",
      JSON.stringify({ scripts: { prepare: "kit sync", test: "test" } }),
    );
    const inv = inventoryHooks(root);
    assert.equal(inv.ok, true);
    assert.deepEqual(inv.lockedDependencyHooks, [
      { path: "node_modules/esbuild", version: "0.28.2", integrity: "sha512-x", optional: true },
    ]);
    assert.deepEqual(inv.nonRegistrySources, [
      { path: "node_modules/vendored", resolved: "git+https://example.com/x.git", link: false },
    ]);
    assert.match(inv.lockSha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(
      inv.rootHookGenerators.map((g) => [g.hook, g.path, g.reviewed, g.sha256]),
      [
        ["postinstall", "ci/build-ember-tokens.mjs", true, sha256("first")],
        ["postinstall", "ci/build-leaf-css.mjs", true, sha256("second")],
      ],
    );
    assert.deepEqual(inv.kitHooks, { prepare: "kit sync" });
  });
  it("fails closed on added, changed or removed root hooks", () => {
    for (const hooks of [
      { ...REVIEWED_ROOT_HOOKS, preinstall: "node x.js" },
      { postinstall: "node other.js" },
      {},
    ]) {
      assert.match(inventoryHooks(fixture(hooks)).problems[0], /differ from the reviewed set/);
    }
    for (const name of ["prepack", "postpack", "prepublishOnly", "prepare"]) {
      const inv = inventoryHooks(fixture({ ...REVIEWED_ROOT_HOOKS, [name]: "echo hi" }));
      assert.equal(inv.ok, false, name);
      assert.ok(name in inv.rootHooks);
    }
  });
  it("classifies an unreviewed script", () => {
    const inv = inventoryHooks(fixture({ postinstall: "node ci/other-generator.mjs" }));
    assert.equal(inv.ok, false);
    assert.equal(inv.rootHookGenerators[0].reviewed, false);
    assert.match(inv.problems.join(" "), /unreviewed script ci\/other-generator\.mjs/);
  });
  it("reports resolved locations without guessing dependency specifications", () => {
    const root = fixture(REVIEWED_ROOT_HOOKS, {
      "node_modules/missing": { version: "1.0.0" },
      "node_modules/direct": { resolved: "https://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz" },
      "node_modules/alternate": { resolved: "https://registry.example.com/pkg.tgz" },
      "node_modules/link": { link: true, resolved: "packages/local" },
      "node_modules/bundle": { inBundle: true },
    });
    const inv = inventoryHooks(root);
    assert.deepEqual(
      Object.fromEntries(inv.resolvedOrigins.map(({ path, origin }) => [path, origin])),
      {
        "node_modules/alternate": "other-resolved",
        "node_modules/bundle": "bundled",
        "node_modules/direct": "npm-registry-host",
        "node_modules/link": "link",
        "node_modules/missing": "unknown",
      },
    );
    assert.equal(
      inv.nonRegistrySources.some(({ path }) => path === "node_modules/direct"),
      false,
    );
    assert.equal(
      inv.nonRegistrySources.some(({ path }) => path === "node_modules/missing"),
      true,
    );
  });
  it("rejects malformed lock metadata", () => {
    for (const meta of [
      null,
      [],
      { resolved: 42 },
      { resolved: "" },
      { hasInstallScript: "false" },
      { link: 1 },
      { optional: null },
      { inBundle: "true" },
      { integrity: 42 },
      { version: "" },
    ]) {
      assert.throws(() =>
        inventoryHooks(fixture(REVIEWED_ROOT_HOOKS, { "node_modules/bad": meta })),
      );
    }
    const root = fixture(REVIEWED_ROOT_HOOKS);
    put(root, "package-lock.json", JSON.stringify({ packages: [] }));
    assert.throws(() => inventoryHooks(root), /packages must be an object/);
  });
  it("exposes a JSON CLI and exits nonzero on unreviewed hooks or invalid input", () => {
    const cli = fileURLToPath(new URL("./install-hook-inventory.mjs", import.meta.url));
    const good = spawnSync(process.execPath, [cli, fixture(REVIEWED_ROOT_HOOKS)], {
      encoding: "utf8",
    });
    assert.equal(good.status, 0);
    assert.equal(JSON.parse(good.stdout).ok, true);
    const bad = spawnSync(process.execPath, [cli, fixture({ preinstall: "node other.js" })], {
      encoding: "utf8",
    });
    assert.equal(bad.status, 1);
    assert.equal(JSON.parse(bad.stdout).ok, false);
    const invalid = fixture(REVIEWED_ROOT_HOOKS);
    put(invalid, "package-lock.json", "{");
    assert.equal(spawnSync(process.execPath, [cli, invalid]).status, 1);
  });
  it("matches actual root hooks", () => {
    const inv = inventoryHooks();
    assert.deepEqual(inv.problems, []);
    assert.deepEqual(Object.keys(inv.rootHooks), ["postinstall"]);
  });
});
