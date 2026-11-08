// Source identity only. No build, collection admission or qualification is implied.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256 } from "./worker-bundle-evidence.mjs";

const BASELINE = {
  commit: "1fe09ab868a6fea4a7873e4a096523b78747b232",
  tree: "454843aa9ac7b9f911020108ba539a4353ee977d",
};
const LIMITS = { files: 20000, fileBytes: 64 * 1024 * 1024, bytes: 512 * 1024 * 1024 };

export function canonicalCellIdentity({ cell, candidateSha, collectorSha }) {
  for (const value of [candidateSha, collectorSha]) {
    assert.ok(
      typeof value === "string" && /^[0-9a-f]{40}$/.test(value),
      "explicit full source SHA required",
    );
  }
  // Later cells have no accepted immutable source mapping yet. Never infer one.
  assert.equal(cell, "B", "canonical cell has no approved source mapping");
  assert.equal(candidateSha, BASELINE.commit, "canonical candidate does not match cell");
  assert.notEqual(collectorSha, candidateSha, "collector cannot be the measured baseline");
  return { cell, candidateSha, candidateTree: BASELINE.tree, collectorSha };
}

function directory(path) {
  const root = resolve(path);
  let current = root;
  while (true) {
    assert.ok(lstatSync(current).isDirectory(), "source directory missing or symlinked");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  assert.equal(realpathSync(root), root, "source directory alias");
  return root;
}

function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", "-C", root, ...args], {
    env: { PATH: process.env.PATH, LC_ALL: "C", GIT_OPTIONAL_LOCKS: "0" },
    encoding: "utf8",
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.ok(!result.error && result.status === 0, "canonical source Git inspection failed");
  return result.stdout;
}

function sourceBytes(root, path, remaining) {
  assert.ok(
    path.length <= 1024 &&
      !/[\\\u0000-\u001f\u007f]/.test(path) &&
      path.split("/").every((part) => part && part !== "." && part !== ".."),
    "unsafe tracked source path",
  );
  directory(dirname(join(root, path)));
  const fd = openSync(
    join(root, path),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = fstatSync(fd);
    assert.ok(
      stat.isFile() && stat.size <= LIMITS.fileBytes && stat.size <= remaining,
      "tracked source file exceeds bound or is not regular",
    );
    const bytes = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, null);
      if (!count) break;
      size += count;
    }
    assert.equal(size, stat.size, "tracked source changed while reading");
    return bytes.subarray(0, size);
  } finally {
    closeSync(fd);
  }
}

export function inspectCanonicalSource(path, expectedSha) {
  assert.ok(
    typeof expectedSha === "string" && /^[0-9a-f]{40}$/.test(expectedSha),
    "explicit full source SHA required",
  );
  const root = directory(path);
  assert.equal(git(root, ["rev-parse", "--show-toplevel"]).trim(), root, "not source root");
  const identity = () => {
    assert.equal(git(root, ["rev-parse", "HEAD"]).trim(), expectedSha, "source HEAD mismatch");
    assert.equal(
      git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
      "",
      "source checkout is dirty",
    );
  };
  identity();
  const tree = git(root, ["rev-parse", `${expectedSha}^{tree}`]).trim();
  const parents = git(root, ["show", "-s", "--format=%P", expectedSha]).trim();
  assert.match(tree, /^[0-9a-f]{40}$/, "invalid source tree");
  assert.ok(!parents || parents.split(" ").every((sha) => /^[0-9a-f]{40}$/.test(sha)));
  const records = git(root, ["ls-tree", "-r", "-z", expectedSha]).split("\0");
  assert.equal(records.pop(), "", "unterminated source inventory");
  assert.ok(records.length > 0 && records.length <= LIMITS.files, "source file count bound");
  let totalBytes = 0;
  const files = records.map((record) => {
    const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
    assert.ok(match, "unsupported source tree member");
    const [, mode, blob, path] = match;
    const bytes = sourceBytes(root, path, LIMITS.bytes - totalBytes);
    totalBytes += bytes.length;
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    assert.equal(actual, blob, "tracked source bytes differ from pinned tree");
    assert.equal(
      Boolean(lstatSync(join(root, path)).mode & 0o111),
      mode === "100755",
      "tracked source mode differs from pinned tree",
    );
    return { path, mode, blob, bytes: bytes.length, sha256: sha256(bytes) };
  });
  identity();
  return {
    commit: expectedSha,
    tree,
    parents: parents ? parents.split(" ") : [],
    files,
    filesSha256: sha256(JSON.stringify(files)),
  };
}

export function inspectCanonicalPristineSource(path, expectedSha) {
  const root = directory(path);
  const inspectExtras = () => {
    // status excludes ignored inputs: stale CSS, dependency trees and local env
    // files can otherwise affect a nominally clean candidate before installation.
    // --directory also reports ignored empty directories and nested repositories.
    const ignored = git(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]);
    assert.ok(ignored === "", "candidate has ignored pre-install inputs");
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    assert.ok(untracked === "", "candidate has untracked pre-install inputs");
  };
  // Inventory tracked bytes between two overlay checks. No cleanup or source
  // repair is allowed here: unsupported candidate execution must stop instead.
  inspectExtras();
  const source = inspectCanonicalSource(root, expectedSha);
  inspectExtras();
  return {
    ...source,
    installBoundary: {
      evidence: "observed-pristine-pre-install-source-only",
      ignoredEntries: 0,
      untrackedEntries: 0,
    },
  };
}

export function bindCanonicalSources(collectorPath, candidatePath, context) {
  const identity = canonicalCellIdentity(context);
  const collectorRoot = directory(collectorPath);
  const candidateRoot = directory(candidatePath);
  for (const [a, b] of [
    [collectorRoot, candidateRoot],
    [candidateRoot, collectorRoot],
  ]) {
    const relation = relative(a, b);
    assert.ok(
      relation === ".." || relation.startsWith(`..${sep}`),
      "collector and candidate roots must be separate and non-nested",
    );
  }
  const collector = inspectCanonicalSource(collectorRoot, identity.collectorSha);
  const candidate = inspectCanonicalPristineSource(candidateRoot, identity.candidateSha);
  assert.equal(candidate.tree, identity.candidateTree, "canonical candidate tree mismatch");
  assert.ok(
    collector.files.some((file) => file.path === ".github/workflows/ci.yml"),
    "collector workflow missing",
  );
  return {
    schema: "two.kit-canonical-source.v1",
    evidence: "unqualified-source-identity-only",
    // Post-install generated inputs/dependencies and build environment need separate proof.
    trackedFilesOnly: true,
    cell: identity.cell,
    collector,
    candidate,
    // For B the approved patch inventory is exactly empty, not a workflow diff.
    sourcePatch: { base: BASELINE.commit, files: [] },
  };
}
