// Build-only receipt. Neither this tree nor a dry run proves what Cloudflare uploaded.
import assert from "node:assert/strict";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { sha256 } from "./worker-bundle-evidence.mjs";

function regularFile(path) {
  assert.ok(lstatSync(path).isFile(), "expected a regular file, not a symlink");
  const content = readFileSync(path);
  return { bytes: content.length, sha256: sha256(content) };
}

function tree(directory) {
  const files = [];
  function walk(path, prefix) {
    assert.ok(lstatSync(path).isDirectory(), "expected a directory, not a symlink");
    for (const name of readdirSync(path).sort()) {
      const full = join(path, name);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(full).isDirectory()) walk(full, relative);
      else files.push({ path: relative, ...regularFile(full) });
    }
  }
  walk(directory, "");
  assert.ok(files.length > 0, "empty build tree");
  return files;
}

export function createKitRehearsal(root, buildDirectory, replayDirectory, context) {
  assert.match(context.sourceSha, /^[0-9a-f]{40}$/, "source SHA required");
  assert.match(context.runId, /^[1-9][0-9]*$/, "run ID required");
  assert.match(context.runAttempt, /^[1-9][0-9]*$/, "run attempt required");
  const build = tree(buildDirectory);
  const replay = tree(replayDirectory);
  const worker = build.find((item) => item.path === "worker.js");
  const replayWorker = replay.find((item) => item.path === "worker.js");
  assert.ok(worker?.bytes > 0, "built Worker missing or empty");
  assert.deepEqual(replayWorker, worker, "rehearsal changed Worker bytes");
  assert.ok(
    build.some((item) => item.path === "bundle-meta.json"),
    "metafile missing",
  );
  const assets = tree(join(root, "web/.svelte-kit/cloudflare"));
  for (const required of ["_worker.js", "_headers", "_app/version.json"]) {
    assert.ok(
      assets.some((item) => item.path === required),
      `missing Kit build file: ${required}`,
    );
  }
  assert.ok(
    assets.some((item) => item.path.startsWith("_app/immutable/")),
    "immutable assets missing",
  );
  const inputs = [
    "web/wrangler.production.jsonc",
    "web/worker.js",
    "web/_headers",
    "package-lock.json",
    "web/package-lock.json",
  ].map((path) => ({ path, ...regularFile(join(root, path)) }));
  const trees = { build, replay, assets };
  return {
    schema: "two.kit-upload-rehearsal.v1",
    evidence: "build-and-upload-rehearsal-only",
    sourceSha: context.sourceSha,
    runId: context.runId,
    runAttempt: context.runAttempt,
    target: "two-web-next-production",
    sameWorkerBytes: true,
    workerSha256: worker.sha256,
    inputs,
    // Include every file, including control files and adapter code. This is the
    // complete build tree, NOT an assertion about Wrangler's asset selection.
    trees,
    treeSha256: sha256(JSON.stringify(trees)),
  };
}

// This is a byte-retention primitive, not the independently pinned collector.
// Callers must separately bind candidate-owned inventory and build provenance.
const CANONICAL_ROOTS = [
  "web/.svelte-kit/output/server",
  "web/.svelte-kit/output/client",
  "web/.svelte-kit/cloudflare",
];
const CANONICAL_LIMITS = { files: 20000, fileBytes: 64 * 1024 * 1024, bytes: 256 * 1024 * 1024 };

function canonicalAuthority(authority) {
  assert.equal(
    authority?.KIT_WORKER_PATH,
    `${CANONICAL_ROOTS[2]}/_worker.js`,
    "worker authority drift",
  );
  assert.equal(authority?.KIT_SERVER_DIR, CANONICAL_ROOTS[0], "server authority drift");
  assert.equal(authority?.KIT_CLIENT_DIR, `${CANONICAL_ROOTS[1]}/_app`, "client authority drift");
  assert.deepEqual(
    authority?.KIT_GROUP_IDS,
    ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"],
    "group authority drift",
  );
}

function safeMember(path) {
  assert.ok(
    typeof path === "string" &&
      path.length <= 1024 &&
      !/[\\\\\u0000-\u001f\u007f]/.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "unsafe canonical member",
  );
}

function safeDirectory(path) {
  const absolute = resolve(path);
  let current = absolute;
  while (true) {
    assert.ok(lstatSync(current).isDirectory(), "canonical directory is missing or symlinked");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return absolute;
}

function canonicalBytes(path, remaining = CANONICAL_LIMITS.fileBytes) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= CANONICAL_LIMITS.fileBytes && stat.size <= remaining,
      "canonical file is not regular or exceeds byte bound",
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    assert.equal(size, stat.size, "canonical file changed while reading");
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

export function createCanonicalReceipt(root, authority) {
  canonicalAuthority(authority);
  const base = safeDirectory(root);
  const files = [];
  const directories = [];
  let totalBytes = 0;
  const groupFor = (path) => {
    if (path === authority.KIT_WORKER_PATH) return "kit.worker";
    if (path.startsWith(`${authority.KIT_SERVER_DIR}/`) && path.endsWith(".js"))
      return "kit.server.js";
    if (path.startsWith(`${authority.KIT_CLIENT_DIR}/`) && path.endsWith(".js"))
      return "kit.client.js";
    if (path.startsWith(`${authority.KIT_CLIENT_DIR}/`) && path.endsWith(".css"))
      return "kit.client.css";
    return null;
  };
  function walk(path, depth) {
    assert.ok(depth <= 32, "canonical directory depth exceeded");
    safeDirectory(join(base, path));
    assert.ok(directories.length < CANONICAL_LIMITS.files, "canonical directory count exceeded");
    directories.push(path);
    const members = readdirSync(join(base, path)).sort();
    assert.ok(depth > 0 || members.length > 0, "empty canonical directory");
    for (const name of members) {
      const member = `${path}/${name}`;
      safeMember(member);
      const full = join(base, member);
      const stat = lstatSync(full);
      if (stat.isDirectory()) walk(member, depth + 1);
      else {
        assert.ok(stat.isFile(), "canonical member is not a regular file");
        assert.ok(files.length < CANONICAL_LIMITS.files, "canonical file count exceeded");
        const bytes = canonicalBytes(full, CANONICAL_LIMITS.bytes - totalBytes);
        totalBytes += bytes.length;
        files.push({
          path: member,
          group: groupFor(member),
          bytes: bytes.length,
          gzipBytes: gzipSync(bytes).length,
          sha256: sha256(bytes),
        });
      }
    }
  }
  for (const path of CANONICAL_ROOTS) walk(path, 0);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const sums = (rows) => ({
    files: rows.length,
    bytes: rows.reduce((sum, row) => sum + row.bytes, 0),
    gzipBytes: rows.reduce((sum, row) => sum + row.gzipBytes, 0),
  });
  const groups = authority.KIT_GROUP_IDS.map((id) => ({
    id,
    ...sums(files.filter((file) => file.group === id)),
  }));
  assert.ok(
    groups.every((group) => group.files > 0 && group.bytes > 0),
    "missing canonical group",
  );
  return {
    schema: "two.kit-canonical-build.v1",
    evidence: "unqualified-canonical-build-bytes",
    measurementRuntime: { node: process.versions.node, zlib: process.versions.zlib },
    directories: directories.sort(),
    files,
    totals: sums(files),
    groups,
  };
}

export function verifyCanonicalBuild(directory, authority) {
  const base = safeDirectory(directory);
  const receipt = JSON.parse(canonicalBytes(join(base, "receipt.json")).toString("utf8"));
  const actual = createCanonicalReceipt(base, authority);
  assert.deepEqual(receipt, actual, "canonical receipt mismatch");
  const allowedFiles = new Set(["receipt.json", ...actual.files.map((file) => file.path)]);
  const allowedDirectories = new Set(actual.directories);
  for (const path of allowedFiles) {
    let parent = dirname(path);
    while (parent !== ".") {
      allowedDirectories.add(parent);
      parent = dirname(parent);
    }
  }
  function exact(path) {
    for (const name of readdirSync(join(base, path))) {
      const member = path ? `${path}/${name}` : name;
      safeMember(member);
      const stat = lstatSync(join(base, member));
      if (stat.isDirectory()) {
        assert.ok(allowedDirectories.has(member), "unexpected canonical directory");
        exact(member);
      } else {
        assert.ok(stat.isFile() && allowedFiles.has(member), "unexpected canonical file");
      }
    }
  }
  exact("");
  return receipt;
}

export function freezeCanonicalBuild(root, destination, authority) {
  const source = safeDirectory(root);
  const output = resolve(destination);
  safeDirectory(dirname(output));
  for (const path of CANONICAL_ROOTS) {
    const relation = relative(join(source, path), output);
    assert.ok(
      relation !== "" && (relation === ".." || relation.startsWith(`..${sep}`)),
      "canonical destination overlaps emitted tree",
    );
  }
  const receipt = createCanonicalReceipt(source, authority);
  mkdirSync(output, { mode: 0o700 });
  for (const path of receipt.directories) {
    mkdirSync(join(output, path), { recursive: true, mode: 0o700 });
  }
  for (const file of receipt.files) {
    const bytes = canonicalBytes(join(source, file.path));
    assert.equal(bytes.length, file.bytes, "canonical source size changed");
    assert.equal(sha256(bytes), file.sha256, "canonical source digest changed");
    mkdirSync(dirname(join(output, file.path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(output, file.path), bytes, { flag: "wx", mode: 0o400 });
  }
  assert.deepEqual(createCanonicalReceipt(source, authority), receipt, "canonical source changed");
  writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o400,
  });
  verifyCanonicalBuild(output, authority);
  return receipt;
}

function main() {
  const [buildDirectory, replayDirectory, output, ...extra] = process.argv.slice(2);
  assert.ok(
    buildDirectory && replayDirectory && output && !extra.length,
    "usage: kit-upload-rehearsal.mjs <build-dir> <replay-dir> <receipt>",
  );
  const receipt = createKitRehearsal(process.cwd(), buildDirectory, replayDirectory, {
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
