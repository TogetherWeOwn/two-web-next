import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkMigrations, filesystemInventory, formatLock, resolveBaseline } from "./check-migration-history.mjs";

const initial = {
  "drizzle/0000_init-users.sql": "SELECT 'users';\n",
  "drizzle/0001_agent-events.sql": "SELECT 'events';\n",
  "drizzle/1000_original.sql": "SELECT 1;\n",
  "db/migrations/1002_original.sql": "SELECT 2;\n",
};

function git(root, ...args) {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", ...args], { cwd: root, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8").trim();
}

function put(root, path, content) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function lock(root) {
  put(root, "migrations.lock", formatLock(filesystemInventory(root)));
}

function fixture(t, { bootstrap = false, defaultBranch, signing = false } = {}) {
  const root = mkdtempSync(join(process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(), "migration-guard-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const [path, sql] of Object.entries(initial)) put(root, path, sql);
  if (!bootstrap) {
    lock(root);
    copyFileSync(fileURLToPath(new URL("./check-migration-history.mjs", import.meta.url)), join(root, "helper-copy.mjs"));
    mkdirSync(join(root, "ci"));
    renameSync(join(root, "helper-copy.mjs"), join(root, "ci/check-migration-history.mjs"));
  }
  const initConfig = defaultBranch ? ["-c", `init.defaultBranch=${defaultBranch}`] : [];
  git(root, ...initConfig, "init", "-q", "--initial-branch=fixture");
  if (signing) {
    git(root, "config", "--local", "commit.gpgSign", "true");
    git(root, "config", "--local", "gpg.format", "openpgp");
    git(root, "config", "--local", "gpg.program", join(root, "unavailable-fixture-signer"));
  }
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture baseline");
  const base = git(root, "rev-parse", "HEAD");
  git(root, "update-ref", "refs/remotes/origin/main", base);
  if (bootstrap) lock(root);
  return { root, base, check: () => checkMigrations(root, base) };
}

for (const bootstrap of [false, true]) {
  test(`unchanged history passes (${bootstrap ? "initial adoption" : "locked base"})`, (t) => {
    const f = fixture(t, { bootstrap });
    assert.deepEqual(f.check(), { total: 4, historical: 4 });
  });
  test(`append-only SQL passes (${bootstrap ? "initial adoption" : "locked base"})`, (t) => {
    const f = fixture(t, { bootstrap });
    const before = Object.fromEntries(Object.keys(initial).map((path) => [path, readFileSync(join(f.root, path))]));
    put(f.root, "migrations/1003_appended.sql", "SELECT 3;\n");
    lock(f.root);
    assert.deepEqual(f.check(), { total: 5, historical: 4 });
    for (const [path, bytes] of Object.entries(before)) assert.deepEqual(readFileSync(join(f.root, path)), bytes);
  });
  for (const path of Object.keys(initial)) {
    test(`cannot bless edit of ${path} by rewriting lock (${bootstrap ? "bootstrap" : "locked"})`, (t) => {
      const f = fixture(t, { bootstrap });
      put(f.root, path, `${initial[path]}-- edited\n`);
      lock(f.root);
      assert.throws(f.check, /historical SQL is immutable/);
    });
  }
  test(`cannot bless deletion by rewriting lock (${bootstrap ? "bootstrap" : "locked"})`, (t) => {
    const f = fixture(t, { bootstrap });
    rmSync(join(f.root, "drizzle/1000_original.sql"));
    lock(f.root);
    assert.throws(f.check, /historical migration deleted\/renamed/);
  });
}

for (const changed of [false, true]) {
  test(`same-number rename/reuse fails (${changed ? "changed SQL" : "identical SQL"})`, (t) => {
    const f = fixture(t);
    renameSync(join(f.root, "drizzle/1000_original.sql"), join(f.root, "drizzle/1000_reused.sql"));
    if (changed) put(f.root, "drizzle/1000_reused.sql", "SELECT 999;\n");
    lock(f.root);
    assert.throws(f.check, /historical migration deleted\/renamed/);
  });
}

test("moving migration to another directory fails", (t) => {
  const f = fixture(t);
  renameSync(join(f.root, "drizzle/1000_original.sql"), join(f.root, "db/migrations/1000_original.sql"));
  lock(f.root);
  assert.throws(f.check, /historical migration deleted\/renamed/);
});

for (const [path, error] of [
  ["drizzle/1000_duplicate.sql", /duplicate number/],
  ["migrations/1000_cross_directory.sql", /duplicate number/],
  ["drizzle/0999_bot.sql", /out of range/],
  ["drizzle/2000_overflow.sql", /out of range/],
  ["drizzle/no_number.sql", /bad name/],
  ["drizzle/1003_.sql", /bad name/],
  ["drizzle/1003_wrong.SQL", /bad name/],
  ["drizzle/nested/1003_hidden.sql", /bad name\/path/],
  ["drizzle/1001_old_gap.sql", /must append above reserved number/],
]) {
  test(`rejects ${path}`, (t) => {
    const f = fixture(t);
    put(f.root, path, "SELECT 3;\n");
    lock(f.root);
    assert.throws(f.check, error);
  });
}

test("key-bearing SQL slugs use separate path and checksum fields", (t) => {
  const f = fixture(t);
  put(f.root, "drizzle/1003_import-keys.sql", "SELECT 'public data';\n");
  lock(f.root);
  const text = readFileSync(join(f.root, "migrations.lock"), "utf8");
  assert.match(text, /"path": "drizzle\/1003_import-keys\.sql",\n\s+"sha256": "[0-9a-f]{64}"/);
  assert.equal(f.check().total, 5);
});

test("upper web-range boundary is appendable", (t) => {
  const f = fixture(t);
  put(f.root, "drizzle/1999_last.sql", "SELECT 1999;\n");
  lock(f.root);
  assert.equal(f.check().total, 5);
});

test("new grandfathered name is not a new bot-range exception", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "drizzle/0001_agent-events.sql"));
  lock(f.root);
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "synthetic base without legacy file");
  put(f.root, "drizzle/0001_agent-events.sql", initial["drizzle/0001_agent-events.sql"]);
  lock(f.root);
  assert.throws(() => checkMigrations(f.root, "HEAD"), /must append above reserved number/);
});

test("unlocked SQL edit fails without regeneration", (t) => {
  const f = fixture(t);
  put(f.root, "drizzle/1000_original.sql", "SELECT 99;\n");
  assert.throws(f.check, /lock does not match/);
});

test("append requires an explicit lock entry", (t) => {
  const f = fixture(t);
  put(f.root, "drizzle/1003_new.sql", "SELECT 3;\n");
  assert.throws(f.check, /lock does not match/);
});

for (const [name, mutate, error] of [
  ["missing", (r) => rmSync(join(r, "migrations.lock")), /missing\/unreadable/],
  ["unreadable", (r) => chmodSync(join(r, "migrations.lock"), 0), /missing\/unreadable/],
  ["malformed", (r) => put(r, "migrations.lock", "not JSON"), /JSON/],
  ["empty", (r) => put(r, "migrations.lock", formatLock({})), /lock does not match/],
  ["hash tampered", (r) => put(r, "migrations.lock", readFileSync(join(r, "migrations.lock"), "utf8").replace(/[0-9a-f]{64}/, "0".repeat(64))), /lock does not match/],
  ["extra field", (r) => put(r, "migrations.lock", readFileSync(join(r, "migrations.lock"), "utf8").replace('"version": 1,', '"version": 1, "override": true,')), /invalid\/noncanonical/],
  ["duplicate path", (r) => {
    const value = JSON.parse(readFileSync(join(r, "migrations.lock"), "utf8"));
    value.migrations.push(value.migrations[0]);
    put(r, "migrations.lock", `${JSON.stringify(value, null, 2)}\n`);
  }, /invalid\/noncanonical/],
  ["missing path", (r) => {
    const value = JSON.parse(readFileSync(join(r, "migrations.lock"), "utf8"));
    delete value.migrations[0].path;
    put(r, "migrations.lock", `${JSON.stringify(value, null, 2)}\n`);
  }, /invalid\/noncanonical/],
  ["invalid hash", (r) => put(r, "migrations.lock", readFileSync(join(r, "migrations.lock"), "utf8").replace(/[0-9a-f]{64}/, "not-a-sha256")), /invalid\/noncanonical/],
  ["linked", (r) => { renameSync(join(r, "migrations.lock"), join(r, "outside.lock")); symlinkSync("outside.lock", join(r, "migrations.lock")); }, /missing\/unreadable/],
]) {
  test(`${name} lock fails closed`, (t) => {
    const f = fixture(t);
    mutate(f.root);
    assert.throws(f.check, error);
  });
}

for (const path of ["db", "db/migrations", "drizzle"]) {
  test(`filesystem and Git reject linked ancestor ${path}`, (t) => {
    const f = fixture(t);
    const target = join(f.root, `outside-${path.replaceAll("/", "-")}`);
    renameSync(join(f.root, path), target);
    symlinkSync(target, join(f.root, path));
    assert.throws(f.check, /ancestor must be/);
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "synthetic linked base");
    rmSync(join(f.root, path));
    renameSync(target, join(f.root, path));
    assert.throws(() => checkMigrations(f.root, "HEAD"), /Git migration ancestor must be/);
  });
}

test("linked SQL file fails closed", (t) => {
  const f = fixture(t);
  renameSync(join(f.root, "drizzle/1000_original.sql"), join(f.root, "outside.sql"));
  symlinkSync("../outside.sql", join(f.root, "drizzle/1000_original.sql"));
  assert.throws(f.check, /symlink/);
});

test("missing Git commit cannot fall back to candidate lock", (t) => {
  const f = fixture(t);
  assert.throws(() => checkMigrations(f.root, "0".repeat(40)), /cannot read Git baseline/);
});

test("missing base lock after adoption is not bootstrap", (t) => {
  const f = fixture(t);
  rmSync(join(f.root, "migrations.lock"));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "synthetic missing lock base");
  lock(f.root);
  assert.throws(() => checkMigrations(f.root, "HEAD"), /baseline lock is missing after guard adoption/);
});

test("CI resolves PR base and push-before SHA, not checked-out HEAD", (t) => {
  const f = fixture(t);
  put(f.root, "drizzle/1003_new.sql", "SELECT 3;\n");
  lock(f.root);
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "candidate");
  const eventPath = join(f.root, "event.json");
  put(f.root, "event.json", JSON.stringify({ before: f.base, pull_request: { base: { sha: f.base } } }));
  for (const name of ["pull_request", "push"]) {
    assert.equal(resolveBaseline(f.root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: name, GITHUB_EVENT_PATH: eventPath }), f.base);
  }
  put(f.root, "event.json", "{}");
  assert.throws(() => resolveBaseline(f.root, { GITHUB_ACTIONS: "true", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: eventPath }), /missing\/invalid CI base SHA/);
});

test("a SQL-named directory cannot hide as an absent file", (t) => {
  const f = fixture(t);
  mkdirSync(join(f.root, "drizzle/1003_directory.sql"));
  assert.throws(f.check, /missing\/unreadable regular file/);
});

test("an unreadable SQL file fails closed", (t) => {
  const f = fixture(t);
  chmodSync(join(f.root, "drizzle/1000_original.sql"), 0);
  assert.throws(f.check, /missing\/unreadable regular file/);
});

test("a corrupt base lock cannot be replaced by a valid candidate lock", (t) => {
  const f = fixture(t);
  put(f.root, "migrations.lock", formatLock({}));
  git(f.root, "add", ".");
  git(f.root, "commit", "-qm", "synthetic corrupt baseline");
  lock(f.root);
  assert.throws(() => checkMigrations(f.root, "HEAD"), /Git baseline lock: lock does not match/);
});

test("fixture commits ignore inherited signing with an unavailable signer", (t) => {
  const f = fixture(t, { signing: true });
  assert.equal(git(f.root, "config", "--local", "--get", "commit.gpgSign"), "true");
  assert.deepEqual(f.check(), { total: 4, historical: 4 });
  assert.equal(git(f.root, "cat-file", "commit", f.base).includes("\ngpgsig "), false);
});

for (const defaultBranch of ["main", "master"]) {
  test(`shallow CI fetches event base and dispatch main (default branch ${defaultBranch})`, (t) => {
    const f = fixture(t, { defaultBranch });
    assert.equal(git(f.root, "branch", "--show-current"), "fixture");
    git(f.root, "branch", "main", f.base);
    put(f.root, "drizzle/1003_new.sql", "SELECT 3;\n");
    lock(f.root);
    git(f.root, "add", ".");
    git(f.root, "commit", "-qm", "candidate");
    git(f.root, "branch", "candidate");
    const clone = join(f.root, "shallow-clone");
    git(f.root, "clone", "--quiet", "--depth=1", "--branch", "candidate", `file://${f.root}`, clone);
    assert.equal(git(clone, "rev-parse", "--is-shallow-repository"), "true");
    const eventPath = join(f.root, "event.json");
    put(f.root, "event.json", JSON.stringify({ pull_request: { base: { sha: f.base } } }));
    const env = { GITHUB_ACTIONS: "true", GITHUB_EVENT_PATH: eventPath };
    assert.equal(resolveBaseline(clone, { ...env, GITHUB_EVENT_NAME: "pull_request" }), f.base);
    assert.deepEqual(checkMigrations(clone, f.base), { total: 5, historical: 4 });
    assert.equal(resolveBaseline(clone, { ...env, GITHUB_EVENT_NAME: "workflow_dispatch" }), f.base);
  });
}

test("CLI guard and regeneration cannot bless a historical edit", (t) => {
  const f = fixture(t);
  const env = { ...process.env, GITHUB_ACTIONS: "false" };
  const cli = (...args) => spawnSync(process.execPath, ["ci/check-migration-history.mjs", ...args], { cwd: f.root, env, encoding: "utf8" });
  assert.equal(cli().status, 0);
  put(f.root, "drizzle/1000_original.sql", "SELECT 999;\n");
  assert.equal(cli("--write-lock").status, 0);
  const result = cli();
  assert.equal(result.status, 1);
  assert.match(result.stderr, /historical SQL is immutable/);
});
