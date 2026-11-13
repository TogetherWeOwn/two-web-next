import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appGit, srcImport } from "./join-state-evidence-source.mjs";

test("imports only an explicit file contained in the target", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "target");
  await mkdir(root);
  await writeFile(join(root, "runtime.mjs"), 'export default "target";');
  await writeFile(join(parent, "outside.mjs"), 'export default "outside";');
  await symlink(join(parent, "outside.mjs"), join(root, "linked.mjs"));
  assert.equal((await srcImport(root, "runtime.mjs")).default, "target");
  for (const file of ["../outside.mjs", join(parent, "outside.mjs"), "linked.mjs"]) {
    assert.throws(() => srcImport(root, file), /path outside target/);
  }
  await assert.rejects(srcImport(root, "missing.mjs"), { code: "ERR_MODULE_NOT_FOUND" });
});

test("rejects a target nested in a different git checkout", async (t) => {
  const parent = await mkdtemp(join(tmpdir(), "join-source-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: parent });
  const root = join(parent, "target");
  await mkdir(root);
  assert.throws(() => appGit(root, "status", "--porcelain"), /git root.*target/i);
});

test("reads target identity and status including a linked worktree", async (t) => {
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

test("ignores inherited git repository, worktree and index routing", async (t) => {
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
  const old = Object.fromEntries(
    ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"].map((key) => [key, process.env[key]]),
  );
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
