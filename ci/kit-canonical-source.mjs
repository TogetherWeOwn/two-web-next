// Source-bound candidate interfaces. No collection admission or qualification is implied.
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
import { pathToFileURL } from "node:url";
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

export async function loadCanonicalAuthority(path, expectedSha) {
  const root = directory(path);
  const source = inspectCanonicalSource(root, expectedSha);
  const input = source.files.find((file) => file.path === "ci/bundle-inventory.mjs");
  assert.ok(input && input.bytes > 0 && input.bytes <= 256 * 1024, "candidate authority missing");
  // Import the candidate's pinned authority in place, never a collector copy.
  // A commit-specific URL also prevents a cached earlier revision at this path
  // from silently supplying the inventory after a supported checkout changes.
  const url = pathToFileURL(join(root, input.path));
  url.searchParams.set("source", expectedSha);
  let module;
  try {
    module = await import(url.href);
  } catch {
    throw new Error("candidate authority could not be loaded");
  }
  assert.deepEqual(inspectCanonicalSource(root, expectedSha), source, "candidate source changed");
  assert.equal(module.JSON_VERSION, 1, "unsupported candidate authority version");
  const authority = {};
  for (const key of ["KIT_WORKER_PATH", "KIT_SERVER_DIR", "KIT_CLIENT_DIR"]) {
    assert.ok(
      typeof module[key] === "string" && module[key].length > 0 && module[key].length <= 1024,
      "invalid candidate authority path",
    );
    authority[key] = module[key];
  }
  assert.ok(
    Array.isArray(module.KIT_GROUP_IDS) &&
      module.KIT_GROUP_IDS.length === 4 &&
      module.KIT_GROUP_IDS.every((id) => typeof id === "string" && /^[a-z.]{1,64}$/.test(id)) &&
      new Set(module.KIT_GROUP_IDS).size === 4,
    "invalid candidate authority groups",
  );
  authority.KIT_GROUP_IDS = Object.freeze([...module.KIT_GROUP_IDS]);
  return {
    evidence: "source-bound-candidate-authority-only",
    source,
    input,
    // Retention still validates the canonical path/group contract. Loading does
    // not execute the checker, establish tool provenance or admit collection.
    authority: Object.freeze(authority),
  };
}

export async function loadCanonicalStartup(path, expectedSha) {
  const root = directory(path);
  const source = inspectCanonicalSource(root, expectedSha);
  const paths = [
    "ci/check-worker-startup.mjs",
    "ci/worker-startup-runner.mjs",
    "ci/worker-startup-budget.json",
  ];
  const inputs = paths.map((path) => {
    const file = source.files.find((file) => file.path === path);
    assert.ok(
      file && file.bytes > 0 && file.bytes <= 256 * 1024,
      "candidate startup input missing",
    );
    return file;
  });
  assert.ok(inputs[2].bytes <= 4096, "candidate startup budget exceeds bound");
  let startup;
  let runner;
  let budget;
  try {
    // Relative imports and the module-owned root remain in the candidate tree.
    // Never copy the diagnostic or substitute the collector's budget/runner.
    const load = (path) => {
      const url = pathToFileURL(join(root, path));
      url.searchParams.set("source", expectedSha);
      return import(url.href);
    };
    startup = await load(paths[0]);
    runner = await load(paths[1]);
    budget = JSON.parse(sourceBytes(root, paths[2], 4096).toString("utf8"));
  } catch {
    throw new Error("candidate startup inputs could not be loaded");
  }
  assert.deepEqual(inspectCanonicalSource(root, expectedSha), source, "candidate source changed");
  assert.equal(
    startup.METRIC,
    "local_startup_non_idle_sample_ms",
    "candidate startup metric drift",
  );
  for (const key of ["collect", "runCommand", "validateBudget", "validateEvidence", "summary"]) {
    assert.equal(typeof startup[key], "function", "candidate startup interface missing");
  }
  assert.equal(typeof runner.runnerIdentity, "function", "candidate runner interface missing");
  assert.ok(
    typeof runner.RUNNER_IMAGE === "string" &&
      /^node:24-bookworm@sha256:[0-9a-f]{64}$/.test(runner.RUNNER_IMAGE),
    "candidate runner image invalid",
  );
  const original = JSON.stringify(budget);
  try {
    startup.validateBudget(budget);
  } catch {
    throw new Error("candidate startup budget invalid");
  }
  assert.equal(JSON.stringify(budget), original, "candidate startup budget mutated");
  assert.deepEqual(inspectCanonicalSource(root, expectedSha), source, "candidate source changed");
  return {
    evidence: "source-bound-candidate-startup-only",
    source,
    inputs,
    budget: Object.freeze({ ...budget, tools: Object.freeze({ ...budget.tools }) }),
    startup: Object.freeze({
      collect: startup.collect,
      runCommand: startup.runCommand,
      validateEvidence: startup.validateEvidence,
      summary: startup.summary,
    }),
    runner: Object.freeze({ image: runner.RUNNER_IMAGE, identity: runner.runnerIdentity }),
    // Loading exports does not execute the build, collect profiles, verify the
    // installed tools or establish the actual process/container identity.
    executionVerified: false,
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

export function inspectCanonicalInstalledSource(path, expectedSha) {
  const root = directory(path);
  const source = inspectCanonicalSource(root, expectedSha);
  const generatedPath = "src/leaf-critical-css.ts";
  const dependencyPaths = ["node_modules", "web/node_modules"];
  const inputPaths = [
    "package.json",
    "package-lock.json",
    "web/package.json",
    "web/package-lock.json",
    "ci/build-leaf-css.mjs",
    "public/styles.css",
    "public/theme-tokens.css",
    "public/theme.css",
  ];
  const inputs = inputPaths.map((path) => {
    const file = source.files.find((file) => file.path === path);
    assert.ok(file && file.bytes > 0, "candidate generator or install input missing");
    return file;
  });
  assert.ok(
    !source.files.some((file) => file.path === generatedPath),
    "generated input unexpectedly tracked",
  );
  const observe = () => {
    const ignored = git(root, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
      "-z",
    ]).split("\0");
    assert.equal(ignored.pop(), "", "missing post-install ignored inputs");
    assert.deepEqual(
      ignored.sort(),
      [...dependencyPaths.map((path) => `${path}/`), generatedPath].sort(),
      "unexpected post-install ignored inputs",
    );
    for (const path of dependencyPaths) directory(join(root, path));
    return [generatedPath, ...dependencyPaths.map((path) => `${path}/.package-lock.json`)].map(
      (path) => {
        const bytes = sourceBytes(root, path, LIMITS.fileBytes);
        assert.ok(bytes.length > 0, "empty generated input or installed lock");
        return { path, bytes: bytes.length, sha256: sha256(bytes) };
      },
    );
  };
  const observed = observe();
  assert.deepEqual(inspectCanonicalSource(root, expectedSha), source, "candidate source changed");
  assert.deepEqual(observe(), observed, "post-install inputs changed during observation");
  return {
    ...source,
    installBoundary: {
      evidence: "observed-post-install-inputs-only",
      inputs,
      generated: observed[0],
      installedLocks: observed.slice(1),
      // Lock snapshots are observations, not proof of installed package contents
      // or that the candidate generator produced the observed CSS module.
      dependenciesVerified: false,
      generatorExecutionVerified: false,
    },
  };
}

export async function runCanonicalCandidateBuild(path, expectedSha, capture) {
  assert.equal(typeof capture, "function", "candidate build capture required");
  const root = directory(path);
  const startup = await loadCanonicalStartup(root, expectedSha);
  const inventory = await loadCanonicalAuthority(root, expectedSha);
  const { installBoundary, ...source } = inspectCanonicalInstalledSource(root, expectedSha);
  assert.deepEqual(startup.source, source, "candidate source changed");
  assert.deepEqual(inventory.source, source, "candidate source changed");
  const command = {
    executable: "npm",
    args: ["run", "build", "--prefix", "web"],
    cwd: "candidate-root",
    timeoutMs: 240000,
    maxBytes: 2097152,
  };
  let failed = false;
  let buildError;
  try {
    await startup.startup.runCommand(command.executable, [...command.args], {
      cwd: root,
      timeoutMs: command.timeoutMs,
      maxBytes: command.maxBytes,
    });
  } catch (error) {
    failed = true;
    buildError = error;
  }
  let captured;
  try {
    // The collector observes the return boundary before any source rechecks or
    // profiler work, including when the candidate command failed. It owns raw
    // byte retention and its failure journal; no later retry is performed here.
    captured = await capture({
      root,
      authority: inventory.authority,
      producerOutcome: failed ? "failure" : "success",
    });
  } catch (error) {
    if (!failed) throw error;
  }
  if (failed) throw buildError;
  assert.deepEqual(inspectCanonicalSource(root, expectedSha), source, "candidate source changed");
  // Build output is now expected. Recheck only the previously observed inputs,
  // not the pre-build overlay set, without classifying dependency contents.
  for (const file of [installBoundary.generated, ...installBoundary.installedLocks]) {
    const bytes = sourceBytes(root, file.path, LIMITS.fileBytes);
    assert.equal(bytes.length, file.bytes, "candidate installed input changed");
    assert.equal(sha256(bytes), file.sha256, "candidate installed input changed");
  }
  return {
    evidence: "unqualified-candidate-build-return",
    source,
    installBoundary,
    startupInputs: startup.inputs,
    authorityInput: inventory.input,
    command,
    capture: captured,
    // A call through candidate code is not actual runtime/tool/image provenance,
    // verified dependency contents, a separated workflow or collection admission.
    dependenciesVerified: false,
    executionVerified: false,
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
