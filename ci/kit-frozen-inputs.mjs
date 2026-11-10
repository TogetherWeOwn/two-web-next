// Local read-only input snapshot, not custody, provenance or upload qualification.
import assert from "node:assert/strict";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { classifyKitAssets } from "./kit-complete-assets.mjs";
import { verifyKitSourceConfig } from "./kit-source-config.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

const sourceFiles = [
  "wrangler.jsonc",
  "web/wrangler.production.jsonc",
  "web/worker.js",
  "web/_headers",
  "package-lock.json",
  "web/package-lock.json",
];
const maxFiles = 2048;
const maxFileBytes = 64 * 1024 * 1024;
const maxTreeBytes = 256 * 1024 * 1024;

function realPath(path) {
  assert.equal(typeof path, "string", "path required");
  assert.ok(path && !path.includes("//"), "aliased path");
  assert.ok(!path.split("/").some((part) => part === "." || part === ".."), "aliased path");
  const absolute = resolve(path);
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    assert.ok(lstatSync(parent).isDirectory(), "non-directory or symlink ancestor");
    if (parent === dirname(parent)) break;
  }
  return absolute;
}

function readRegular(path, readonly = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size <= maxFileBytes, "invalid or oversized snapshot file");
    if (readonly) assert.equal(stat.mode & 0o777, 0o444, "snapshot file must be read-only");
    const bytes = readFileSync(fd);
    assert.equal(bytes.length, stat.size, "snapshot file changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

function inventory(root, readonly = false, skipManifest = false) {
  const files = [];
  const directories = [];
  let total = 0;
  function walk(path, prefix) {
    const stat = lstatSync(path);
    assert.ok(stat.isDirectory(), "snapshot directory must not be a symlink");
    if (readonly) assert.equal(stat.mode & 0o777, 0o555, "snapshot directory must be read-only");
    if (prefix) directories.push(prefix);
    assert.ok(directories.length <= maxFiles, "too many snapshot directories");
    for (const name of readdirSync(path).sort()) {
      assert.match(name, /^[A-Za-z0-9._-]+$/, "unsafe snapshot member");
      const member = prefix ? `${prefix}/${name}` : name;
      const full = join(path, name);
      if (lstatSync(full).isDirectory()) walk(full, member);
      else {
        const bytes = readRegular(full, readonly);
        // Only the root receipt is excluded from its own digest inventory.
        if (skipManifest && !prefix && name === "manifest.json") continue;
        total += bytes.length;
        assert.ok(files.length < maxFiles && total <= maxTreeBytes, "snapshot exceeds bounds");
        files.push({ path: member, bytes: bytes.length, sha256: sha256(bytes) });
      }
    }
  }
  walk(root, "");
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  directories.sort();
  return { files, directories };
}

function contextIdentity(context) {
  assert.match(context.sourceSha, /^[0-9a-f]{40}$/, "source SHA required");
  assert.match(context.runId, /^[1-9][0-9]*$/, "run ID required");
  assert.match(context.runAttempt, /^[1-9][0-9]*$/, "run attempt required");
  return { sourceSha: context.sourceSha, runId: context.runId, runAttempt: context.runAttempt };
}

function validateWorkers(files) {
  const worker = files.find((file) => file.path === "build/worker.js");
  const replay = files.find((file) => file.path === "replay/worker.js");
  assert.ok(worker?.bytes > 0, "built Worker missing or empty");
  assert.ok(
    replay?.bytes === worker.bytes && replay?.sha256 === worker.sha256,
    "rehearsal changed Worker bytes",
  );
  assert.ok(
    files.some((file) => file.path === "build/bundle-meta.json" && file.bytes > 0),
    "metafile missing or empty",
  );
  return worker;
}

function evidence(root, context, readonly) {
  const entries = inventory(root, readonly, true);
  const requiredSource = sourceFiles.map((path) => `source/${path}`).sort();
  assert.deepEqual(
    entries.files.filter((file) => file.path.startsWith("source/")).map((file) => file.path),
    requiredSource,
    "source snapshot membership differs",
  );
  assert.ok(
    entries.files.every((file) => /^(source|adapter|build|replay)\//.test(file.path)),
    "unexpected snapshot member",
  );
  const worker = validateWorkers(entries.files);
  const assets = classifyKitAssets(join(root, "adapter"));
  const configs = ["wrangler.jsonc", "web/wrangler.production.jsonc"].map((path) =>
    readWranglerConfig(readRegular(join(root, "source", path), readonly).toString("utf8")),
  );
  return {
    schema: "two.kit-frozen-inputs.v1",
    evidence: "read-only-build-input-snapshot-only",
    ...contextIdentity(context),
    target: "two-web-next-production",
    ...entries,
    workerSha256: worker.sha256,
    assets,
    sourceConfig: verifyKitSourceConfig(...configs),
  };
}

export function freezeKitInputs(root, buildDirectory, replayDirectory, destination, context) {
  contextIdentity(context);
  const output = realPath(destination);
  const locations = [
    ["build", realPath(buildDirectory)],
    ["replay", realPath(replayDirectory)],
    ["adapter", realPath(join(root, "web/.svelte-kit/cloudflare"))],
  ];
  for (const [, path] of locations) {
    assert.ok(output !== path && !output.startsWith(`${path}${sep}`), "snapshot overlaps input");
  }
  const copies = locations.flatMap(([prefix, path]) =>
    inventory(path).files.map((file) => ({
      source: join(path, file.path),
      path: `${prefix}/${file.path}`,
      bytes: file.bytes,
      sha256: file.sha256,
    })),
  );
  for (const path of sourceFiles) {
    const source = realPath(join(root, path));
    const bytes = readRegular(source);
    assert.ok(bytes.length > 0, "empty source input");
    copies.push({ source, path: `source/${path}`, bytes: bytes.length, sha256: sha256(bytes) });
  }
  assert.ok(copies.length <= maxFiles, "too many input files");
  assert.ok(
    copies.reduce((total, file) => total + file.bytes, 0) <= maxTreeBytes,
    "inputs exceed snapshot bounds",
  );
  classifyKitAssets(locations[2][1]);
  verifyKitSourceConfig(
    ...["wrangler.jsonc", "web/wrangler.production.jsonc"].map((path) =>
      readWranglerConfig(readRegular(join(root, path)).toString("utf8")),
    ),
  );
  validateWorkers(copies);
  // Exclusive creation: never overwrite a prior snapshot, even an empty directory.
  mkdirSync(output, { mode: 0o700 });
  for (const file of copies) {
    const bytes = readRegular(file.source);
    assert.equal(sha256(bytes), file.sha256, "input changed before snapshot");
    assert.equal(bytes.length, file.bytes, "input size changed before snapshot");
    const target = join(output, file.path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, bytes, { flag: "wx", mode: 0o600 });
  }
  const manifest = evidence(output, context, false);
  assert.deepEqual(
    manifest.files,
    copies
      .map(({ path, bytes, sha256 }) => ({ path, bytes, sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
    "snapshot copy differs from inputs",
  );
  // Catch changes during copying; the consuming job must not share these inputs
  // with concurrent writers. Owner-reversible modes are not immutable custody.
  for (const [prefix, path] of locations) {
    assert.deepEqual(
      inventory(path).files,
      manifest.files
        .filter((file) => file.path.startsWith(`${prefix}/`))
        .map((file) => ({
          ...file,
          path: file.path.slice(prefix.length + 1),
        })),
      "input tree changed during snapshot",
    );
  }
  for (const file of copies) {
    assert.equal(sha256(readRegular(file.source)), file.sha256, "source changed during snapshot");
  }
  writeFileSync(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, {
    flag: "wx",
    mode: 0o444,
  });
  for (const file of manifest.files) chmodSync(join(output, file.path), 0o444);
  for (const path of [...manifest.directories].reverse()) chmodSync(join(output, path), 0o555);
  chmodSync(output, 0o555);
  return verifyFrozenKitInputs(output, context);
}

export function verifyFrozenKitInputs(destination, context) {
  const root = realPath(destination);
  assert.ok(lstatSync(root).isDirectory(), "snapshot root must be a real directory");
  const raw = readRegular(join(root, "manifest.json"), true);
  assert.ok(raw.length <= 2 * 1024 * 1024, "snapshot manifest exceeds bounds");
  const saved = JSON.parse(raw.toString("utf8"));
  const actual = evidence(root, context, true);
  assert.deepEqual(saved, actual, "missing, stale or changed frozen Kit inputs");
  return actual;
}

function main() {
  const [command, ...args] = process.argv.slice(2);
  const context = {
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  };
  if (command === "freeze") {
    assert.equal(args.length, 3, "freeze requires build-dir, replay-dir and new destination");
    freezeKitInputs(process.cwd(), ...args, context);
  } else {
    assert.equal(command, "verify", "expected freeze or verify");
    assert.equal(args.length, 1, "verify requires snapshot directory");
    verifyFrozenKitInputs(args[0], context);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
