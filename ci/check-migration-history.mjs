#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const roots = ["db/migrations", "drizzle", "migrations"];
const ancestors = ["db", ...roots];
const grandfathered = new Set(["drizzle/0000_init-users.sql", "drizzle/0001_agent-events.sql"]);
const lockFile = "migrations.lock";
const helperFile = "ci/check-migration-history.mjs";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inMigrationRoot = (path) => roots.some((dir) => path.startsWith(`${dir}/`));

function stat(root, path) {
  try {
    return lstatSync(resolve(root, path));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readRegular(root, path) {
  const info = stat(root, path);
  if (!info?.isFile() || !(info.mode & 0o444)) {
    throw new Error(`missing/unreadable regular file: ${path}`);
  }
  return readFileSync(resolve(root, path));
}

export function filesystemInventory(root) {
  // lstat every ancestor before traversal: a linked db/ or drizzle/ must not
  // become a zero-file Git baseline while the filesystem follows external SQL.
  for (const path of ancestors) {
    const info = stat(root, path);
    if (info && (!info.isDirectory() || !(info.mode & 0o444) || !(info.mode & 0o111))) {
      throw new Error(`migration ancestor must be a readable real directory: ${path}`);
    }
  }
  const files = {};
  function visit(dir) {
    for (const entry of readdirSync(resolve(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`symlink in migration directory: ${path}`);
      if (/\.sql$/i.test(entry.name)) files[path] = sha256(readRegular(root, path));
      else if (entry.isDirectory()) visit(path);
    }
  }
  for (const dir of roots) if (stat(root, dir)) visit(dir);
  return files;
}

function validateInventory(files) {
  const seen = new Map();
  for (const path of Object.keys(files).sort()) {
    const match = /^([0-9]{4})_[A-Za-z0-9][A-Za-z0-9_-]*\.sql$/.exec(path.split("/").at(-1));
    if (!roots.includes(dirname(path)) || !match) throw new Error(`bad name/path: ${path} (want NNNN_slug.sql directly in a migration directory)`);
    const number = Number(match[1]);
    if (!grandfathered.has(path) && (number < 1000 || number > 1999)) {
      throw new Error(`out of range: ${path} (web range is 1000-1999)`);
    }
    if (seen.has(number)) throw new Error(`duplicate number: ${path} (also ${seen.get(number)})`);
    seen.set(number, path);
  }
}

export function formatLock(files) {
  return `${JSON.stringify({ version: 1, migrations: Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))) }, null, 2)}\n`;
}

function validateLock(bytes, files, label) {
  const text = bytes.toString("utf8");
  const value = JSON.parse(text);
  if (value?.version !== 1 || !value.migrations || Array.isArray(value.migrations)
      || typeof value.migrations !== "object" || text !== formatLock(value.migrations)) {
    throw new Error(`${label}: invalid/noncanonical lock`);
  }
  if (text !== formatLock(files)) throw new Error(`${label}: lock does not match migration paths/SQL bytes; append new entries with --write-lock`);
}

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch {
    throw new Error(`cannot read Git baseline (${args[0]}); fetch origin/main or restore the CI base commit`);
  }
}

function gitTree(root, base) {
  const entries = new Map();
  for (const line of git(root, ["ls-tree", "-r", "-t", "-z", base]).toString("utf8").split("\0")) {
    if (!line) continue;
    const [header, path] = line.split("\t");
    const [mode, type, oid] = header.split(" ");
    entries.set(path, { mode, type, oid });
  }
  return entries;
}

function gitFile(root, entry, path) {
  if (!entry || !["100644", "100755"].includes(entry.mode) || entry.type !== "blob") {
    throw new Error(`Git baseline must contain a regular file: ${path}`);
  }
  return git(root, ["cat-file", "blob", entry.oid]);
}

function baselineInventory(root, entries) {
  for (const path of ancestors) {
    const entry = entries.get(path);
    if (entry && entry.mode !== "040000") throw new Error(`Git migration ancestor must be a real directory: ${path}`);
  }
  const files = {};
  for (const [path, entry] of entries) {
    if (!inMigrationRoot(path)) continue;
    if (!["040000", "100644", "100755"].includes(entry.mode)) {
      throw new Error(`non-regular entry in Git migration directory: ${path}`);
    }
    if (/\.sql$/i.test(path)) files[path] = sha256(gitFile(root, entry, path));
  }
  validateInventory(files);
  return files;
}

export function checkMigrations(root, base) {
  const current = filesystemInventory(root);
  validateInventory(current);
  validateLock(readRegular(root, lockFile), current, lockFile);
  const entries = gitTree(root, base);
  const previous = baselineInventory(root, entries);
  if (entries.has(lockFile)) {
    validateLock(gitFile(root, entries.get(lockFile), lockFile), previous, "Git baseline lock");
  } else if (entries.has(helperFile)) {
    throw new Error("Git baseline lock is missing after guard adoption");
  }
  // Bootstrap is allowed only before guard adoption; even then, every SQL file
  // already in the base is immutable. Updating the lock never blesses edits.
  for (const [path, hash] of Object.entries(previous)) {
    if (!(path in current)) throw new Error(`historical migration deleted/renamed: ${path}`);
    if (current[path] !== hash) throw new Error(`historical SQL is immutable: ${path}`);
  }
  const highest = Math.max(999, ...Object.keys(previous).filter((path) => !grandfathered.has(path)).map((path) => Number(path.split("/").at(-1).slice(0, 4))));
  for (const path of Object.keys(current)) {
    if (path in previous) continue;
    const number = Number(path.split("/").at(-1).slice(0, 4));
    if (grandfathered.has(path) || number <= highest) throw new Error(`new migration must append above reserved number ${highest}: ${path}`);
  }
  return { total: Object.keys(current).length, historical: Object.keys(previous).length };
}

export function resolveBaseline(root, env = process.env) {
  let base = "origin/main";
  if (env.GITHUB_ACTIONS === "true") {
    const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
    if (env.GITHUB_EVENT_NAME === "pull_request") base = event.pull_request?.base?.sha;
    else if (env.GITHUB_EVENT_NAME === "push") base = event.before;
    else if (env.GITHUB_EVENT_NAME !== "workflow_dispatch") throw new Error("unsupported CI event for historical baseline");
    if (base !== "origin/main" && !/^[0-9a-f]{40}$/.test(base ?? "")) throw new Error("missing/invalid CI base SHA");
    if (base === "origin/main") {
      // Dispatch checks against the current target branch, not a stale local ref.
      git(root, ["fetch", "--no-tags", "origin", "main"]);
      base = "FETCH_HEAD";
    } else {
      try {
        git(root, ["cat-file", "-e", `${base}^{commit}`]);
      } catch {
        // actions/checkout is shallow. Fetch only the event's immutable SHA;
        // neither a PR-controlled ref nor the candidate's lock is the baseline.
        git(root, ["fetch", "--no-tags", "--depth=1", "origin", base]);
      }
    }
  }
  return git(root, ["rev-parse", "--verify", `${base}^{commit}`]).toString("utf8").trim();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  try {
    if (process.argv.length === 3 && process.argv[2] === "--write-lock") {
      const files = filesystemInventory(root);
      validateInventory(files);
      if (stat(root, lockFile)) readRegular(root, lockFile);
      writeFileSync(resolve(root, lockFile), formatLock(files));
      console.log("migration-history: wrote candidate lock; run ci/check-migration-numbers.sh to verify against Git history");
    } else if (process.argv.length === 2) {
      const result = checkMigrations(root, resolveBaseline(root));
      console.log(`migration-history: ok (${result.total} migrations; ${result.historical} historical paths and SQL hashes protected)`);
    } else throw new Error("usage: node ci/check-migration-history.mjs [--write-lock]");
  } catch (error) {
    console.error(`migration-history: ${error.message}`);
    process.exitCode = 1;
  }
}
