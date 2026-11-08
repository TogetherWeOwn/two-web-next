// Published Wrangler package bytes only, not transitive dependency attestation.
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./worker-bundle-evidence.mjs";

const pin = JSON.parse(readFileSync(new URL("./kit-wrangler-package-pin.json", import.meta.url)));
const maxFileBytes = 32 * 1024 * 1024;

function realDirectory(path) {
  const absolute = resolve(path);
  for (let parent = absolute; ; parent = dirname(parent)) {
    assert.ok(lstatSync(parent).isDirectory(), "non-directory or symlink ancestor");
    if (parent === dirname(parent)) break;
  }
  return absolute;
}

function readRegular(path) {
  realDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= maxFileBytes, "invalid or oversized tool input");
    const bytes = readFileSync(fd);
    assert.equal(bytes.length, stat.size, "tool input changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function fileRecord(path, bytes) {
  return { path, bytes: bytes.length, sha256: sha256(bytes) };
}

export function verifyWranglerTool(root, expected = pin) {
  assert.equal(expected.schema, "two.wrangler-package-pin.v1", "unknown package pin schema");
  assert.equal(expected.name, "wrangler", "wrong package name");
  assert.equal(expected.version, "4.156.1", "unreviewed Wrangler version");
  assert.equal(
    expected.resolved,
    "https://registry.npmjs.org/wrangler/-/wrangler-4.156.1.tgz",
    "unreviewed Wrangler registry source",
  );
  assert.match(expected.integrity, /^sha512-[A-Za-z0-9+/]{86}==$/, "invalid lock integrity");
  assert.ok(
    Array.isArray(expected.files) && expected.files.length > 0 && expected.files.length <= 128,
    "invalid package file set",
  );
  for (const file of expected.files) {
    assert.match(file.path, /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/, "unsafe package path");
    assert.ok(
      !file.path.split("/").some((part) => [".", "..", "node_modules"].includes(part)),
      "unsafe package path",
    );
    assert.ok(Number.isSafeInteger(file.bytes) && file.bytes >= 0 && file.bytes <= maxFileBytes);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, "invalid file digest");
  }
  assert.deepEqual(
    expected.files.map((file) => file.path),
    [...new Set(expected.files.map((file) => file.path))].sort(),
    "package file pin must be unique and sorted",
  );
  for (const required of ["package.json", "bin/wrangler.js", "wrangler-dist/cli.js"]) {
    assert.ok(
      expected.files.some((file) => file.path === required),
      "required tool member missing",
    );
  }
  const expectedDirectories = new Set();
  for (const file of expected.files) {
    for (let parent = dirname(file.path); parent !== "."; parent = dirname(parent)) {
      expectedDirectories.add(parent);
    }
  }
  const base = realDirectory(root);
  const locks = ["package-lock.json", "web/package-lock.json"].map((path) => {
    const bytes = readRegular(join(base, path));
    const locked = JSON.parse(bytes.toString("utf8")).packages?.["node_modules/wrangler"];
    assert.ok(locked, "locked Wrangler required");
    for (const key of ["version", "resolved", "integrity"]) {
      assert.equal(locked[key], expected[key], `Wrangler lock ${key} changed`);
    }
    assert.equal(locked.bin?.wrangler, "bin/wrangler.js", "wrong locked Wrangler entry");
    return fileRecord(path, bytes);
  });
  const directory = realDirectory(join(base, "node_modules/wrangler"));
  const files = [];
  let total = 0;
  const directories = [];
  function walk(path, prefix) {
    realDirectory(path);
    if (prefix) directories.push(prefix);
    assert.ok(directories.length <= 128, "too many tool directories");
    for (const name of readdirSync(path).sort()) {
      assert.match(name, /^[A-Za-z0-9._-]+$/, "unsafe installed package member");
      const full = join(path, name);
      const member = prefix ? `${prefix}/${name}` : name;
      // npm installs separate transitive packages here in the root lock layout.
      // This subtree is explicitly not covered by the published Wrangler pin.
      if (!prefix && name === "node_modules") {
        realDirectory(full);
        continue;
      }
      if (lstatSync(full).isDirectory()) walk(full, member);
      else {
        const bytes = readRegular(full);
        total += bytes.length;
        assert.ok(files.length < 128 && total <= 64 * 1024 * 1024, "tool package exceeds bounds");
        files.push(fileRecord(member, bytes));
      }
    }
  }
  walk(directory, "");
  assert.deepEqual(
    directories.sort(),
    [...expectedDirectories].sort(),
    "unreviewed tool directories",
  );
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  assert.deepEqual(files, expected.files, "installed Wrangler differs from published package");
  const installed = JSON.parse(readRegular(join(directory, "package.json")).toString("utf8"));
  assert.equal(installed.name, expected.name, "wrong installed package name");
  assert.equal(installed.version, expected.version, "wrong installed Wrangler version");
  assert.equal(installed.bin?.wrangler, "./bin/wrangler.js", "wrong installed Wrangler entry");
  assert.equal(installed.main, "wrangler-dist/cli.js", "wrong installed Wrangler runtime");
  return {
    schema: "two.kit-wrangler-tool.v1",
    evidence: "installed-wrangler-package-only",
    name: expected.name,
    version: expected.version,
    resolved: expected.resolved,
    integrity: expected.integrity,
    files,
    locks,
    entry: "node_modules/wrangler/bin/wrangler.js",
    runtime: "node_modules/wrangler/wrangler-dist/cli.js",
  };
}

function main() {
  const [output, ...extra] = process.argv.slice(2);
  assert.ok(output && !extra.length, "usage: kit-wrangler-tool.mjs <new output>");
  const receipt = verifyWranglerTool(process.cwd());
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
