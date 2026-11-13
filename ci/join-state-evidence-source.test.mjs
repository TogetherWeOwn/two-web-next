import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appGit, appImport, srcImport } from "./join-state-evidence-source.mjs";

async function packageAt(root, name, value) {
  const dir = join(root, "node_modules", name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "package.json"), JSON.stringify({ main: "index.cjs" }));
  await writeFile(join(dir, "index.cjs"), `module.exports = ${JSON.stringify(value)};`);
}

test("resolves target root before web, with explicit runtime taking precedence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await packageAt(root, "fixture-pkg", "root");
  await packageAt(join(root, "web"), "fixture-pkg", "web");
  await packageAt(join(root, "web"), "web-only-pkg", "web-only");
  await writeFile(join(root, "runtime.mjs"), 'export default "explicit";');
  assert.equal((await appImport(root, "fixture-pkg")).default, "root");
  assert.equal((await appImport(root, "web-only-pkg")).default, "web-only");
  assert.equal((await appImport(root, "fixture-pkg", "runtime.mjs")).default, "explicit");
  assert.equal((await srcImport(root, "runtime.mjs")).default, "explicit");
});

test("uses import conditions for import-only and dual-mode packages", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of ["import-only", "dual-mode"]) {
    const dir = join(root, "node_modules", name);
    await mkdir(dir, { recursive: true });
    const conditions = { import: "./import.mjs" };
    if (name === "dual-mode") conditions.require = "./require.cjs";
    await writeFile(join(dir, "package.json"), JSON.stringify({ exports: conditions }));
    await writeFile(join(dir, "import.mjs"), `export default ${JSON.stringify(name)};`);
    await writeFile(join(dir, "require.cjs"), 'module.exports = "require";');
    assert.equal((await appImport(root, name)).default, name);
  }
});

test("rejects a target nested in a different git checkout", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: parent });
  const root = join(parent, "target");
  await mkdir(root);
  assert.throws(() => appGit(root, "status", "--porcelain"), /git root.*target/i);
});

test("ignores enclosing package errors before trying the target web package", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  const outside = join(parent, "node_modules", "fallback-pkg");
  await mkdir(outside, { recursive: true });
  await writeFile(
    join(outside, "package.json"),
    JSON.stringify({ exports: { "./other": "./index.js" } }),
  );
  await packageAt(join(root, "web"), "fallback-pkg", "web");
  assert.equal((await appImport(root, "fallback-pkg")).default, "web");
});

test("ignores enclosing self-reference errors before trying the target web package", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  await writeFile(
    join(parent, "package.json"),
    JSON.stringify({ name: "fallback-pkg", exports: { "./other": "./index.js" } }),
  );
  await packageAt(root, "fallback-pkg", "root");
  await packageAt(join(root, "web"), "fallback-pkg", "web");
  await writeFile(join(root, "web", "package.json"), JSON.stringify({ name: "web" }));
  assert.equal((await appImport(root, "fallback-pkg")).default, "web");
});

test("rejects missing packages and does not fall back outside the target", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  await mkdir(root);
  await packageAt(parent, "outside-pkg", "outside");
  assert.throws(() => appImport(root, "outside-pkg"), /cannot resolve outside-pkg/);
  assert.throws(() => appImport(root, "missing-pkg"), /cannot resolve missing-pkg/);
  assert.throws(() => appGit(root, "not-a-git-command"));
});

test("rejects explicit and source paths that escape the target", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  await mkdir(root);
  await writeFile(join(parent, "outside.mjs"), 'export default "outside";');
  await symlink(join(parent, "outside.mjs"), join(root, "linked.mjs"));
  for (const file of [
    "../outside.mjs",
    join(parent, "outside.mjs"),
    join(root, "linked.mjs"),
    "linked.mjs",
  ]) {
    assert.throws(() => srcImport(root, file), /path outside target/);
    assert.throws(() => appImport(root, "missing-pkg", file), /path outside target/);
  }
  await packageAt(parent, "linked-pkg", "outside");
  await mkdir(join(root, "node_modules"));
  await symlink(
    join(parent, "node_modules", "linked-pkg"),
    join(root, "node_modules", "linked-pkg"),
  );
  assert.throws(() => appImport(root, "linked-pkg"), /cannot resolve linked-pkg/);
});

test("reads identity and status from the requested git checkout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
  git("init", "-q");
  await writeFile(join(root, "tracked.txt"), "initial\n");
  git("add", "tracked.txt");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  );
  const sha = appGit(root, "rev-parse", "HEAD");
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(appGit(root, "status", "--porcelain"), "");
  await writeFile(join(root, "tracked.txt"), "changed\n");
  assert.equal(appGit(root, "status", "--porcelain"), "M tracked.txt");
  assert.equal(appGit(root, "rev-parse", "HEAD"), sha);
  const worktree = join(root, "worktree");
  git("worktree", "add", "--detach", worktree, "HEAD");
  assert.equal(appGit(worktree, "rev-parse", "HEAD"), sha);
});

test("ignores inherited git repository and index routing", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  const controller = join(parent, "controller");
  for (const dir of [root, controller]) {
    await mkdir(dir);
    const git = (...args) => execFileSync("git", args, { cwd: dir, stdio: "pipe" });
    git("init", "-q");
    await writeFile(join(dir, "tracked.txt"), dir);
    git("add", "tracked.txt");
    git(
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-qm",
      "fixture",
    );
  }
  const sha = appGit(root, "rev-parse", "HEAD");
  const old = {
    GIT_DIR: process.env.GIT_DIR,
    GIT_WORK_TREE: process.env.GIT_WORK_TREE,
    GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
  };
  try {
    process.env.GIT_DIR = join(controller, ".git");
    process.env.GIT_WORK_TREE = root;
    assert.equal(appGit(root, "rev-parse", "HEAD"), sha);
    delete process.env.GIT_DIR;
    delete process.env.GIT_WORK_TREE;
    process.env.GIT_INDEX_FILE = join(parent, "other-index");
    assert.equal(appGit(root, "status", "--porcelain"), "");
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("propagates package resolution errors other than missing modules", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = join(root, "node_modules", "bad-pkg");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "package.json"),
    JSON.stringify({ exports: { "./other": "./index.js" } }),
  );
  assert.throws(() => appImport(root, "bad-pkg"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
  const webDir = join(root, "web", "node_modules", "bad-web-pkg");
  await mkdir(webDir, { recursive: true });
  await writeFile(
    join(webDir, "package.json"),
    JSON.stringify({ exports: { "./other": "./index.js" } }),
  );
  assert.throws(() => appImport(root, "bad-web-pkg"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});

test("propagates target package self-reference export errors", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "self-pkg", exports: { "./other": "./index.js" } }),
  );
  await packageAt(join(root, "web"), "self-pkg", "web");
  assert.throws(() => appImport(root, "self-pkg"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});
