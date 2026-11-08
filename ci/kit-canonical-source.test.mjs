import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import {
  bindCanonicalSources,
  canonicalCellIdentity,
  inspectCanonicalInstalledSource,
  inspectCanonicalPristineSource,
  inspectCanonicalSource,
  loadCanonicalAuthority,
  loadCanonicalStartup,
  runCanonicalCandidateBuild,
} from "./kit-canonical-source.mjs";

const B_COMMIT = "1fe09ab868a6fea4a7873e4a096523b78747b232";
const B_TREE = "454843aa9ac7b9f911020108ba539a4353ee977d";
const OTHER_SHA = "2".repeat(40);
const ZERO = "0".repeat(40);

const scratch = realpathSync(
  mkdtempSync(join(process.env.PAPERCLIP_RUN_SCRATCH_DIR || tmpdir(), "kit-canonical-source-")),
);
after(() => rmSync(scratch, { recursive: true, force: true }));

const GIT_ENV = {
  PATH: process.env.PATH,
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Fixture Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
  GIT_COMMITTER_NAME: "Fixture Committer",
  GIT_COMMITTER_EMAIL: "committer@example.invalid",
  GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
};

function git(root, ...args) {
  const result = spawnSync(
    "git",
    ["-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", "-C", root, ...args],
    { env: GIT_ENV, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  assert.equal(result.status, 0, `fixture git ${args[0]} failed: ${result.stderr}`);
  return result.stdout.trim();
}

let counter = 0;
function fixtureRoot(name = "repo") {
  const root = join(scratch, `${name}-${counter++}`);
  mkdirSync(root);
  return root;
}

function write(root, path, content, mode) {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
  if (mode) chmodSync(full, mode);
}

function commitAll(root, message) {
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

// Inert data only: nothing here is executed.
const FILES = {
  ".gitignore": "dist/\n",
  "README.md": "fixture readme\n",
  "package-lock.json": '{"lockfileVersion":3,"packages":{}}\n',
  "wrangler.jsonc": '{"name":"fixture-inert"}\n',
  "src/index.txt": "inert source data\n",
  ".github/workflows/ci.yml": "name: inert\n",
};

function makeRepo(name) {
  const root = fixtureRoot(name);
  git(root, "init", "-q");
  for (const [path, content] of Object.entries(FILES)) write(root, path, content);
  write(root, "bin/tool.sh", "inert executable data\n", 0o755);
  const sha = commitAll(root, "first");
  return { root, sha };
}

const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

const AUTHORITY_MODULE = `export const JSON_VERSION = 1;
export const KIT_WORKER_PATH = "web/.svelte-kit/cloudflare/_worker.js";
export const KIT_SERVER_DIR = "web/.svelte-kit/output/server";
export const KIT_CLIENT_DIR = "web/.svelte-kit/output/client/_app";
export const KIT_GROUP_IDS = ["kit.worker", "kit.server.js", "kit.client.js", "kit.client.css"];
`;

function authorityRepo(content = AUTHORITY_MODULE) {
  const { root } = makeRepo("authority");
  write(root, "ci/bundle-inventory.mjs", content);
  return { root, sha: commitAll(root, "authority input") };
}

test("candidate authority loads pinned candidate bytes without overlays", async () => {
  const { root, sha } = authorityRepo();
  const before = inspectCanonicalSource(root, sha);
  const receipt = await loadCanonicalAuthority(root, sha);
  assert.equal(receipt.evidence, "source-bound-candidate-authority-only");
  assert.deepEqual(receipt.source, before);
  assert.deepEqual(
    receipt.input,
    before.files.find((file) => file.path === "ci/bundle-inventory.mjs"),
  );
  assert.equal(receipt.input.sha256, sha256Hex(AUTHORITY_MODULE));
  assert.equal(receipt.authority.KIT_SERVER_DIR, "web/.svelte-kit/output/server");
  assert.deepEqual(receipt.authority.KIT_GROUP_IDS, [
    "kit.worker",
    "kit.server.js",
    "kit.client.js",
    "kit.client.css",
  ]);
  assert.ok(Object.isFrozen(receipt.authority));
  assert.ok(Object.isFrozen(receipt.authority.KIT_GROUP_IDS));
  assert.deepEqual(inspectCanonicalSource(root, sha), before);
  assert.equal(git(root, "status", "--porcelain", "--untracked-files=all"), "");
});

test("candidate authority cache is pinned to the actual source revision", async () => {
  const { root, sha } = authorityRepo();
  await loadCanonicalAuthority(root, sha);
  write(root, "ci/bundle-inventory.mjs", AUTHORITY_MODULE.replace("= 1;", "= 2;"));
  const changed = commitAll(root, "unsupported authority revision");
  await assert.rejects(loadCanonicalAuthority(root, changed), /unsupported candidate authority/);
  await assert.rejects(loadCanonicalAuthority(root, sha), /source HEAD mismatch/);
});

test("candidate authority refuses missing, aliased or altered inputs", async () => {
  const missing = makeRepo("missing-authority");
  await assert.rejects(loadCanonicalAuthority(missing.root, missing.sha), /authority missing/);
  const changed = authorityRepo();
  write(changed.root, "ci/bundle-inventory.mjs", "throw new Error('must not run');\n");
  git(changed.root, "update-index", "--assume-unchanged", "ci/bundle-inventory.mjs");
  await assert.rejects(
    loadCanonicalAuthority(changed.root, changed.sha),
    /tracked source bytes differ/,
  );
  const alias = authorityRepo();
  unlinkSync(join(alias.root, "ci/bundle-inventory.mjs"));
  symlinkSync(join(alias.root, "README.md"), join(alias.root, "ci/bundle-inventory.mjs"));
  await assert.rejects(loadCanonicalAuthority(alias.root, alias.sha));
});

for (const content of [
  "export const JSON_VERSION = 1;\n",
  AUTHORITY_MODULE.replace('"web/.svelte-kit/output/server"', "null"),
  AUTHORITY_MODULE.replace('"kit.client.css"', '"kit.client.js"'),
  AUTHORITY_MODULE.replace('"kit.client.css"', "7"),
]) {
  test(`authority rejects malformed exports ${sha256Hex(content).slice(0, 8)}`, async () => {
    const { root, sha } = authorityRepo(content);
    await assert.rejects(loadCanonicalAuthority(root, sha), /invalid candidate authority/);
  });
}

test("authority sanitizes import errors and refuses evaluation-time drift", async () => {
  const invalid = authorityRepo("throw new Error('private fixture detail');\n");
  await assert.rejects(loadCanonicalAuthority(invalid.root, invalid.sha), (error) => {
    assert.equal(error.message, "candidate authority could not be loaded");
    assert.ok(!error.message.includes("private fixture detail"));
    return true;
  });
  const changed = authorityRepo(`import { writeFileSync } from "node:fs";
writeFileSync(new URL("../README.md", import.meta.url), "changed fixture");
${AUTHORITY_MODULE}`);
  await assert.rejects(loadCanonicalAuthority(changed.root, changed.sha), /dirty/);
});

const STARTUP_MODULE = `import assert from "node:assert/strict";
export const METRIC = "local_startup_non_idle_sample_ms";
export function collect() { return import.meta.url; }
export function runCommand() { throw new Error("fixture must not execute a command"); }
export function validateBudget(budget) { assert.equal(budget.version, 1); }
export function validateEvidence() {}
export function summary() { return "candidate fixture"; }
`;
const RUNNER_MODULE = `export const RUNNER_IMAGE = "node:24-bookworm@sha256:${"a".repeat(64)}";
export function runnerIdentity() { throw new Error("fixture must not inspect runner"); }
`;
const STARTUP_BUDGET = '{"version":1,"tools":{"wrangler":"4.156.1"}}\n';

function startupRepo(startup = STARTUP_MODULE, runner = RUNNER_MODULE, budget = STARTUP_BUDGET) {
  const { root } = makeRepo("startup");
  write(root, "ci/check-worker-startup.mjs", startup);
  write(root, "ci/worker-startup-runner.mjs", runner);
  write(root, "ci/worker-startup-budget.json", budget);
  return { root, sha: commitAll(root, "startup inputs") };
}

test("startup loader binds candidate inputs without executing build or runner", async () => {
  const { root, sha } = startupRepo();
  const before = inspectCanonicalSource(root, sha);
  const result = await loadCanonicalStartup(root, sha);
  assert.equal(result.evidence, "source-bound-candidate-startup-only");
  assert.equal(result.executionVerified, false);
  assert.deepEqual(result.source, before);
  assert.deepEqual(
    result.inputs,
    [
      "ci/check-worker-startup.mjs",
      "ci/worker-startup-runner.mjs",
      "ci/worker-startup-budget.json",
    ].map((path) => before.files.find((file) => file.path === path)),
  );
  assert.equal(result.inputs[2].sha256, sha256Hex(STARTUP_BUDGET));
  assert.deepEqual(result.budget, JSON.parse(STARTUP_BUDGET));
  assert.ok(Object.isFrozen(result.budget) && Object.isFrozen(result.budget.tools));
  assert.ok(Object.isFrozen(result.startup) && Object.isFrozen(result.runner));
  assert.equal(result.startup.summary(), "candidate fixture");
  const loaded = new URL(result.startup.collect());
  assert.equal(loaded.pathname, join(root, "ci/check-worker-startup.mjs"));
  assert.equal(loaded.searchParams.get("source"), sha);
  assert.deepEqual(inspectCanonicalSource(root, sha), before);
});

test("startup loader refuses missing and hidden changed inputs before evaluation", async () => {
  const missing = makeRepo("startup-missing");
  await assert.rejects(loadCanonicalStartup(missing.root, missing.sha), /startup input missing/);
  const changed = startupRepo();
  write(changed.root, "ci/check-worker-startup.mjs", 'throw new Error("must not run");\n');
  git(changed.root, "update-index", "--assume-unchanged", "ci/check-worker-startup.mjs");
  await assert.rejects(
    loadCanonicalStartup(changed.root, changed.sha),
    /tracked source bytes differ/,
  );
  const aliased = startupRepo();
  unlinkSync(join(aliased.root, "ci/worker-startup-budget.json"));
  symlinkSync("../README.md", join(aliased.root, "ci/worker-startup-budget.json"));
  await assert.rejects(loadCanonicalStartup(aliased.root, aliased.sha));
});

for (const [label, startup, runner, budget, error] of [
  [
    "metric",
    STARTUP_MODULE.replace("local_startup_non_idle_sample_ms", "other"),
    RUNNER_MODULE,
    STARTUP_BUDGET,
    /metric drift/,
  ],
  [
    "function",
    STARTUP_MODULE.replace("export function collect", "function collect"),
    RUNNER_MODULE,
    STARTUP_BUDGET,
    /interface missing/,
  ],
  [
    "runner",
    STARTUP_MODULE,
    RUNNER_MODULE.replace("node:24", "node:22"),
    STARTUP_BUDGET,
    /runner image invalid/,
  ],
  ["budget", STARTUP_MODULE, RUNNER_MODULE, '{"version":2}', /budget invalid/],
  ["budget bound", STARTUP_MODULE, RUNNER_MODULE, " ".repeat(4097), /budget exceeds bound/],
]) {
  test(`startup loader rejects ${label} drift`, async () => {
    const { root, sha } = startupRepo(startup, runner, budget);
    await assert.rejects(loadCanonicalStartup(root, sha), error);
  });
}

test("startup loader sanitizes errors and rejects evaluation or validation mutations", async () => {
  const invalid = startupRepo('throw new Error("private fixture detail");\n');
  await assert.rejects(loadCanonicalStartup(invalid.root, invalid.sha), (error) => {
    assert.equal(error.message, "candidate startup inputs could not be loaded");
    return true;
  });
  const changed = startupRepo(`import { writeFileSync } from "node:fs";
writeFileSync(new URL("../README.md", import.meta.url), "changed fixture");
${STARTUP_MODULE}`);
  await assert.rejects(loadCanonicalStartup(changed.root, changed.sha), /dirty/);
  const mutated = startupRepo(
    STARTUP_MODULE.replace("assert.equal(budget.version, 1);", "budget.version = 2;"),
  );
  await assert.rejects(loadCanonicalStartup(mutated.root, mutated.sha), /budget mutated/);
});

function installedRepo() {
  const { root } = makeRepo("installed");
  write(root, ".gitignore", "node_modules/\nsrc/leaf-critical-css.ts\n.env*\n.svelte-kit/\n");
  for (const path of [
    "package.json",
    "web/package.json",
    "web/package-lock.json",
    "ci/build-leaf-css.mjs",
    "public/styles.css",
    "public/theme-tokens.css",
    "public/theme.css",
  ]) {
    write(root, path, `inert candidate input: ${path}\n`);
  }
  const sha = commitAll(root, "install inputs");
  write(root, "src/leaf-critical-css.ts", "inert generated module\n");
  for (const path of ["node_modules", "web/node_modules"]) {
    write(root, `${path}/.package-lock.json`, '{"lockfileVersion":3}\n');
  }
  return { root, sha };
}

test("installed source binds generated bytes and both hidden locks without qualification", () => {
  const { root, sha } = installedRepo();
  const receipt = inspectCanonicalInstalledSource(root, sha);
  const boundary = receipt.installBoundary;
  assert.equal(receipt.commit, sha);
  assert.equal(boundary.evidence, "observed-post-install-inputs-only");
  assert.equal(boundary.inputs.length, 8);
  for (const input of boundary.inputs) {
    assert.equal(input.sha256, sha256Hex(readFileSync(join(root, input.path))));
  }
  assert.deepEqual(boundary.generated, {
    path: "src/leaf-critical-css.ts",
    bytes: Buffer.byteLength("inert generated module\n"),
    sha256: sha256Hex("inert generated module\n"),
  });
  assert.deepEqual(
    boundary.installedLocks.map((file) => file.path),
    ["node_modules/.package-lock.json", "web/node_modules/.package-lock.json"],
  );
  for (const file of boundary.installedLocks) {
    assert.equal(file.sha256, sha256Hex(readFileSync(join(root, file.path))));
  }
  assert.equal(boundary.dependenciesVerified, false);
  assert.equal(boundary.generatorExecutionVerified, false);
  assert.throws(() => inspectCanonicalPristineSource(root, sha), /ignored pre-install inputs/);
  const previous = boundary.generated.sha256;
  write(root, "src/leaf-critical-css.ts", "different inert observation\n");
  assert.notEqual(
    inspectCanonicalInstalledSource(root, sha).installBoundary.generated.sha256,
    previous,
  );
});

for (const path of [".env", "web/.env.local", "web/.svelte-kit/stale.js"]) {
  test(`installed source rejects extra ignored overlay ${path}`, () => {
    const { root, sha } = installedRepo();
    write(root, path, "inert forbidden overlay\n");
    assert.throws(() => inspectCanonicalInstalledSource(root, sha), /unexpected post-install/);
  });
}

for (const path of [
  "src/leaf-critical-css.ts",
  "node_modules/.package-lock.json",
  "web/node_modules/.package-lock.json",
]) {
  test(`installed source rejects missing, empty and symlinked ${path}`, () => {
    const { root, sha } = installedRepo();
    unlinkSync(join(root, path));
    assert.throws(() => inspectCanonicalInstalledSource(root, sha));
    write(root, path, "");
    assert.throws(() => inspectCanonicalInstalledSource(root, sha), /empty generated input/);
    unlinkSync(join(root, path));
    symlinkSync(join(root, "README.md"), join(root, path));
    assert.throws(() => inspectCanonicalInstalledSource(root, sha));
  });
}

test("installed source rejects dependency directory aliases and hidden source changes", () => {
  const { root, sha } = installedRepo();
  rmSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(join(root, "web/node_modules"), join(root, "node_modules"));
  assert.throws(() => inspectCanonicalInstalledSource(root, sha));
  const changed = installedRepo();
  write(changed.root, "public/theme.css", "hidden source overlay\n");
  git(changed.root, "update-index", "--assume-unchanged", "public/theme.css");
  assert.throws(
    () => inspectCanonicalInstalledSource(changed.root, changed.sha),
    /tracked source bytes differ/,
  );
});

test("installed source rejects an absent pinned generator and an untracked overlay", () => {
  const { root } = installedRepo();
  git(root, "rm", "ci/build-leaf-css.mjs");
  const sha = commitAll(root, "without generator");
  assert.throws(() => inspectCanonicalInstalledSource(root, sha), /install input missing/);
  const extra = installedRepo();
  write(extra.root, "collector-overlay.js", "inert collector injection\n");
  assert.throws(() => inspectCanonicalInstalledSource(extra.root, extra.sha), /dirty/);
});

function candidateBuildRepo({ fail = false, drift = null } = {}) {
  const { root } = installedRepo();
  const calls = join(fixtureRoot("build-calls"), "call.json");
  const run = `export async function runCommand(command, args, options) {
    writeFileSync(${JSON.stringify(calls)}, JSON.stringify({ command, args, options }));
    ${drift ? `writeFileSync(${JSON.stringify(join(root, drift))}, "changed by fixture");` : ""}
    ${fail ? 'throw new Error("candidate build failed");' : ""}
  }`;
  write(
    root,
    "ci/check-worker-startup.mjs",
    `import { writeFileSync } from "node:fs";\n${STARTUP_MODULE.replace(
      'export function runCommand() { throw new Error("fixture must not execute a command"); }',
      run,
    )}`,
  );
  write(root, "ci/worker-startup-runner.mjs", RUNNER_MODULE);
  write(root, "ci/worker-startup-budget.json", STARTUP_BUDGET);
  write(root, "ci/bundle-inventory.mjs", AUTHORITY_MODULE);
  return { root, calls, sha: commitAll(root, "candidate build fixture") };
}

test("candidate build invokes candidate command and awaits its capture boundary", async () => {
  const { root, sha, calls } = candidateBuildRepo();
  let captured = false;
  const result = await runCanonicalCandidateBuild(root, sha, async (context) => {
    assert.deepEqual(JSON.parse(readFileSync(calls, "utf8")), {
      command: "npm",
      args: ["run", "build", "--prefix", "web"],
      options: { cwd: root, timeoutMs: 240000, maxBytes: 2097152 },
    });
    assert.equal(context.root, root);
    assert.equal(context.producerOutcome, "success");
    assert.equal(context.authority.KIT_WORKER_PATH, "web/.svelte-kit/cloudflare/_worker.js");
    assert.ok(Object.isFrozen(context.authority));
    await Promise.resolve();
    captured = true;
    return "fixture-capture";
  });
  assert.equal(captured, true);
  assert.equal(result.capture, "fixture-capture");
  assert.equal(result.evidence, "unqualified-candidate-build-return");
  assert.equal(result.command.cwd, "candidate-root");
  assert.equal(result.source.commit, sha);
  assert.equal(result.startupInputs.length, 3);
  assert.equal(result.authorityInput.path, "ci/bundle-inventory.mjs");
  assert.equal(result.dependenciesVerified, false);
  assert.equal(result.executionVerified, false);
});

test("candidate build captures before rejecting tracked source drift", async () => {
  const { root, sha } = candidateBuildRepo({ drift: "README.md" });
  let captured = false;
  await assert.rejects(
    runCanonicalCandidateBuild(root, sha, (context) => {
      assert.equal(context.producerOutcome, "success");
      assert.equal(readFileSync(join(root, "README.md"), "utf8"), "changed by fixture");
      captured = true;
    }),
    /dirty/,
  );
  assert.equal(captured, true);
});

for (const drift of ["src/leaf-critical-css.ts", "web/node_modules/.package-lock.json"]) {
  test(`candidate build captures before rejecting observed input drift ${drift}`, async () => {
    const { root, sha } = candidateBuildRepo({ drift });
    let captured = false;
    await assert.rejects(
      runCanonicalCandidateBuild(root, sha, () => {
        captured = true;
      }),
      /candidate installed input changed/,
    );
    assert.equal(captured, true);
  });
}

test("candidate build propagates capture failure without retry", async () => {
  const { root, sha } = candidateBuildRepo();
  const failure = new Error("capture fixture failure");
  let attempts = 0;
  await assert.rejects(
    runCanonicalCandidateBuild(root, sha, async () => {
      attempts++;
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(attempts, 1);
});

test("candidate build preserves its failure when the immediate capture also fails", async () => {
  const { root, sha, calls } = candidateBuildRepo({ fail: true, drift: "README.md" });
  let attempts = 0;
  await assert.rejects(
    runCanonicalCandidateBuild(root, sha, async (context) => {
      assert.ok(existsSync(calls));
      assert.equal(context.producerOutcome, "failure");
      attempts++;
      throw new Error("capture must not hide build failure");
    }),
    { message: "candidate build failed" },
  );
  assert.equal(attempts, 1);
});

test("candidate build failure remains failed after successful capture", async () => {
  const { root, sha } = candidateBuildRepo({ fail: true });
  let captured = false;
  await assert.rejects(
    runCanonicalCandidateBuild(root, sha, (context) => {
      assert.equal(context.producerOutcome, "failure");
      captured = true;
      return "retained partial fixture bytes";
    }),
    { message: "candidate build failed" },
  );
  assert.equal(captured, true);
});

test("candidate build rejects invalid callbacks and overlays before command invocation", async () => {
  const { root, sha, calls } = candidateBuildRepo();
  await assert.rejects(runCanonicalCandidateBuild(root, sha), /capture required/);
  write(root, "web/.env.local", "inert forbidden overlay\n");
  let captured = false;
  await assert.rejects(
    runCanonicalCandidateBuild(root, sha, () => {
      captured = true;
    }),
    /unexpected post-install/,
  );
  assert.equal(existsSync(calls), false);
  assert.equal(captured, false);
});

test("canonicalCellIdentity permits only exact B commit and tree", () => {
  const collectorSha = OTHER_SHA;
  assert.deepEqual(canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha }), {
    cell: "B",
    candidateSha: B_COMMIT,
    candidateTree: B_TREE,
    collectorSha,
  });
});

test("canonicalCellIdentity rejects later cells, defaults, floats and equal D=B", () => {
  const collectorSha = OTHER_SHA;
  for (const cell of ["A", "C", "D", "b", "B ", "", undefined, null, 1.5, 2]) {
    assert.throws(
      () => canonicalCellIdentity({ cell, candidateSha: B_COMMIT, collectorSha }),
      /no approved source mapping/,
      `cell ${String(cell)}`,
    );
  }
  assert.throws(() => canonicalCellIdentity({}), /explicit full source SHA/);
  assert.throws(() => canonicalCellIdentity({ cell: "B" }), /explicit full source SHA/);
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", collectorSha }),
    /explicit full source SHA/,
  );
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT }),
    /explicit full source SHA/,
  );
  for (const bad of [1.5, 123, "1fe09ab", B_COMMIT.toUpperCase(), `${B_COMMIT}0`, "HEAD", "main"]) {
    assert.throws(
      () => canonicalCellIdentity({ cell: "B", candidateSha: bad, collectorSha }),
      /explicit full source SHA/,
      `candidate ${String(bad)}`,
    );
    assert.throws(
      () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha: bad }),
      /explicit full source SHA/,
      `collector ${String(bad)}`,
    );
  }
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: OTHER_SHA, collectorSha: ZERO }),
    /does not match cell/,
  );
  assert.throws(
    () => canonicalCellIdentity({ cell: "B", candidateSha: B_COMMIT, collectorSha: B_COMMIT }),
    /collector cannot be the measured baseline/,
  );
});

test("inspectCanonicalSource returns a receipt with real fields and digests", () => {
  const { root, sha: first } = makeRepo("receipt");
  write(root, "src/index.txt", "second inert data\n");
  const second = commitAll(root, "second");
  const receipt = inspectCanonicalSource(root, second);

  assert.equal(receipt.commit, second);
  assert.equal(receipt.tree, git(root, "rev-parse", `${second}^{tree}`));
  assert.deepEqual(receipt.parents, [first]);
  assert.deepEqual(inspectCanonicalSource(root, second), receipt, "receipt is deterministic");

  const expectedPaths = git(root, "ls-tree", "-r", "--name-only", second).split("\n");
  assert.deepEqual(
    receipt.files.map((file) => file.path),
    expectedPaths,
  );
  assert.ok(!receipt.files.some((file) => file.path.startsWith("dist/")));
  for (const file of receipt.files) {
    const bytes = Buffer.from(
      file.path === "src/index.txt"
        ? "second inert data\n"
        : file.path === "bin/tool.sh"
          ? "inert executable data\n"
          : FILES[file.path],
    );
    assert.deepEqual(Object.keys(file), ["path", "mode", "blob", "bytes", "sha256"]);
    assert.equal(file.bytes, bytes.length, file.path);
    assert.equal(file.sha256, sha256Hex(bytes), file.path);
    assert.equal(file.blob, git(root, "rev-parse", `${second}:${file.path}`), file.path);
    assert.equal(file.mode, file.path === "bin/tool.sh" ? "100755" : "100644", file.path);
  }
  assert.equal(receipt.filesSha256, sha256Hex(JSON.stringify(receipt.files)));

  const original = makeRepo("receipt-rootcommit");
  const rootCommit = inspectCanonicalSource(original.root, original.sha);
  assert.equal(rootCommit.commit, original.sha);
  assert.deepEqual(rootCommit.parents, []);
});

test("inspectCanonicalSource reports a root commit with no parents", () => {
  const { root, sha } = makeRepo("rootcommit");
  assert.deepEqual(inspectCanonicalSource(root, sha).parents, []);
});

test("inspectCanonicalSource allows generated ignored output", () => {
  const { root, sha } = makeRepo("ignored");
  write(root, "dist/generated.js", "generated inert output\n");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  const receipt = inspectCanonicalSource(root, sha);
  assert.ok(!receipt.files.some((file) => file.path.startsWith("dist/")));
});

test("pristine candidate inspection retains pinned bytes and explicit empty input boundary", () => {
  const { root, sha } = makeRepo("pristine");
  assert.deepEqual(inspectCanonicalPristineSource(root, sha), {
    ...inspectCanonicalSource(root, sha),
    installBoundary: {
      evidence: "observed-pristine-pre-install-source-only",
      ignoredEntries: 0,
      untrackedEntries: 0,
    },
  });
});

for (const path of [
  "src/leaf-critical-css.ts",
  "node_modules/injected/index.js",
  "web/node_modules/injected/index.js",
  "web/.svelte-kit/output/server/index.js",
  ".dev.vars",
  ".env",
]) {
  test(`pristine candidate refuses ignored input ${path} without deleting or exposing it`, () => {
    const { root } = makeRepo("pristine-ignored");
    write(root, ".gitignore", `${FILES[".gitignore"]}${path}\n`);
    const sha = commitAll(root, "declare ignored input");
    write(root, path, "inert private fixture marker\n");
    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.throws(
      () => inspectCanonicalPristineSource(root, sha),
      (error) => {
        assert.match(error.message, /candidate has ignored pre-install inputs/);
        assert.ok(!error.message.includes(path));
        assert.ok(!error.message.includes("private fixture marker"));
        return true;
      },
    );
    assert.equal(readFileSync(join(root, path), "utf8"), "inert private fixture marker\n");
    assert.equal(inspectCanonicalSource(root, sha).commit, sha);
  });
}

test("pristine candidate rejects ignored empty directories and nested repositories", () => {
  for (const nestedRepo of [false, true]) {
    const { root, sha } = makeRepo("pristine-dir");
    mkdirSync(join(root, "dist"));
    if (nestedRepo) git(join(root, "dist"), "init", "-q");
    assert.throws(
      () => inspectCanonicalPristineSource(root, sha),
      /candidate has ignored pre-install inputs/,
    );
  }
});

test("pristine candidate catches local exclude rules and ignored symlink overlays", () => {
  const { root, sha } = makeRepo("pristine-local-exclude");
  write(root, ".git/info/exclude", "local-overlay\n");
  symlinkSync("README.md", join(root, "local-overlay"));
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.throws(
    () => inspectCanonicalPristineSource(root, sha),
    /candidate has ignored pre-install inputs/,
  );
});

test("pristine candidate still refuses untracked, hidden tracked and wrong-head inputs", () => {
  const extra = makeRepo("pristine-untracked");
  write(extra.root, "overlay.txt", "inert\n");
  assert.throws(
    () => inspectCanonicalPristineSource(extra.root, extra.sha),
    /candidate has untracked pre-install inputs/,
  );
  const hidden = makeRepo("pristine-hidden");
  write(hidden.root, "src/index.txt", "hidden drift\n");
  git(hidden.root, "update-index", "--assume-unchanged", "src/index.txt");
  assert.throws(
    () => inspectCanonicalPristineSource(hidden.root, hidden.sha),
    /tracked source bytes differ from pinned tree/,
  );
  const wrong = makeRepo("pristine-head");
  assert.throws(() => inspectCanonicalPristineSource(wrong.root, OTHER_SHA), /HEAD mismatch/);
});

test("inspectCanonicalSource rejects bad expected SHAs and wrong HEAD", () => {
  const { root, sha } = makeRepo("head");
  for (const bad of [undefined, "", "HEAD", sha.slice(0, 12), sha.toUpperCase(), 1.5]) {
    assert.throws(() => inspectCanonicalSource(root, bad), /explicit full source SHA/);
  }
  assert.throws(() => inspectCanonicalSource(root, OTHER_SHA), /source HEAD mismatch/);
  write(root, "src/index.txt", "later\n");
  commitAll(root, "later");
  assert.throws(() => inspectCanonicalSource(root, sha), /source HEAD mismatch/);
});

test("inspectCanonicalSource rejects the wrong root", () => {
  const { root, sha } = makeRepo("wrongroot");
  assert.throws(() => inspectCanonicalSource(join(root, "src"), sha), /not source root/);
  const plain = fixtureRoot("nongit");
  assert.throws(() => inspectCanonicalSource(plain, sha), /Git inspection failed|not source root/);
  assert.throws(() => inspectCanonicalSource(join(scratch, "does-not-exist"), sha));
});

test("inspectCanonicalSource rejects a symlinked or aliased root", () => {
  const { root, sha } = makeRepo("aliasroot");
  const alias = join(scratch, `alias-${counter++}`);
  symlinkSync(root, alias);
  assert.throws(() => inspectCanonicalSource(alias, sha), /missing or symlinked|alias/);
});

test("inspectCanonicalSource rejects changed, missing and untracked files", () => {
  const changed = makeRepo("changed");
  write(changed.root, "src/index.txt", "tampered\n");
  assert.throws(() => inspectCanonicalSource(changed.root, changed.sha), /dirty/);

  const missing = makeRepo("missing");
  unlinkSync(join(missing.root, "src/index.txt"));
  assert.throws(() => inspectCanonicalSource(missing.root, missing.sha), /dirty/);

  const untracked = makeRepo("untracked");
  write(untracked.root, "extra/new.txt", "not in tree\n");
  assert.throws(() => inspectCanonicalSource(untracked.root, untracked.sha), /dirty/);

  const staged = makeRepo("staged");
  write(staged.root, "src/index.txt", "staged change\n");
  git(staged.root, "add", "src/index.txt");
  assert.throws(() => inspectCanonicalSource(staged.root, staged.sha), /dirty/);
});

for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
  test(`blob comparison catches mutation hidden by ${flag}`, () => {
    const { root, sha } = makeRepo(`hidden${flag.replaceAll("-", "")}`);
    write(root, "src/index.txt", "hidden tamper\n");
    git(root, "update-index", flag, "src/index.txt");
    assert.equal(
      git(root, "status", "--porcelain=v1", "--untracked-files=all"),
      "",
      "fixture must hide the mutation from status",
    );
    assert.throws(
      () => inspectCanonicalSource(root, sha),
      /tracked source bytes differ from pinned tree/,
    );
  });

  test(`hidden missing file under ${flag} still fails`, () => {
    const { root, sha } = makeRepo(`hiddenmissing${flag.replaceAll("-", "")}`);
    unlinkSync(join(root, "src/index.txt"));
    git(root, "update-index", flag, "src/index.txt");
    assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
    assert.throws(() => inspectCanonicalSource(root, sha));
  });

  test(`tracked lock and config mutations are refused under ${flag}`, () => {
    for (const path of ["package-lock.json", "wrangler.jsonc"]) {
      const { root, sha } = makeRepo(`lock${path.replace(/\W/g, "")}${flag.replaceAll("-", "")}`);
      write(root, path, `${FILES[path]}\n`);
      assert.throws(() => inspectCanonicalSource(root, sha), /dirty/, `plain ${path}`);
      git(root, "update-index", flag, path);
      assert.throws(
        () => inspectCanonicalSource(root, sha),
        /tracked source bytes differ from pinned tree/,
        `hidden ${path}`,
      );
    }
  });
}

test("hidden mode change is refused", () => {
  const { root, sha } = makeRepo("hiddenmode");
  chmodSync(join(root, "bin/tool.sh"), 0o644);
  git(root, "update-index", "--assume-unchanged", "bin/tool.sh");
  assert.throws(
    () => inspectCanonicalSource(root, sha),
    /tracked source mode differs from pinned tree/,
  );
  const added = makeRepo("hiddenmodeadd");
  chmodSync(join(added.root, "README.md"), 0o755);
  git(added.root, "update-index", "--assume-unchanged", "README.md");
  assert.throws(
    () => inspectCanonicalSource(added.root, added.sha),
    /tracked source mode differs from pinned tree/,
  );
});

test("tracked symlinks are unsupported tree members", () => {
  const root = fixtureRoot("symlink");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  symlinkSync("README.md", join(root, "link.md"));
  const sha = commitAll(root, "with symlink");
  assert.throws(() => inspectCanonicalSource(root, sha), /unsupported source tree member/);
});

test("a regular file replaced by a symlink is refused even when hidden", () => {
  const { root, sha } = makeRepo("swapped");
  unlinkSync(join(root, "src/index.txt"));
  symlinkSync("../README.md", join(root, "src/index.txt"));
  git(root, "update-index", "--assume-unchanged", "src/index.txt");
  assert.throws(() => inspectCanonicalSource(root, sha));
});

test("a tracked directory replaced by a symlink is refused even when hidden", () => {
  const { root, sha } = makeRepo("dirswap");
  const outside = fixtureRoot("outside");
  write(outside, "index.txt", FILES["src/index.txt"]);
  rmSync(join(root, "src"), { recursive: true });
  symlinkSync(outside, join(root, "src"));
  git(root, "update-index", "--assume-unchanged", "src/index.txt");
  write(root, ".git/info/exclude", "/src\n");
  assert.equal(git(root, "status", "--porcelain=v1", "--untracked-files=all"), "");
  assert.throws(() => inspectCanonicalSource(root, sha), /missing or symlinked/);
});

test("submodule-style gitlinks are unsupported tree members", () => {
  const root = fixtureRoot("gitlink");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  git(root, "add", "README.md");
  git(root, "update-index", "--add", "--cacheinfo", `160000,${OTHER_SHA},vendor/mod`);
  git(root, "commit", "-q", "-m", "gitlink");
  const sha = git(root, "rev-parse", "HEAD");
  assert.throws(() => inspectCanonicalSource(root, sha));
});

test("unsafe tracked paths are refused", () => {
  const root = fixtureRoot("unsafepath");
  git(root, "init", "-q");
  write(root, "README.md", "inert\n");
  write(root, "back\\slash.txt", "inert\n");
  const sha = commitAll(root, "backslash path");
  assert.throws(() => inspectCanonicalSource(root, sha), /unsafe tracked source path/);
});

test("empty tree is refused", () => {
  const root = fixtureRoot("empty");
  git(root, "init", "-q");
  git(root, "commit", "-q", "--allow-empty", "-m", "empty");
  const sha = git(root, "rev-parse", "HEAD");
  assert.throws(() => inspectCanonicalSource(root, sha), /source file count bound/);
});

test("bindCanonicalSources checks the cell before touching any path", () => {
  const missing = join(scratch, "never-created");
  for (const cell of ["A", "C", undefined]) {
    assert.throws(
      () =>
        bindCanonicalSources(missing, missing, {
          cell,
          candidateSha: B_COMMIT,
          collectorSha: OTHER_SHA,
        }),
      /no approved source mapping/,
    );
  }
  assert.throws(
    () =>
      bindCanonicalSources(missing, missing, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: B_COMMIT,
      }),
    /collector cannot be the measured baseline/,
  );
});

test("canonical source fixtures stay wired into the existing Actions selftests", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  assert.match(
    workflow,
    /run: node --test [^\n]*ci\/kit-canonical-retention\.test\.mjs ci\/kit-canonical-source\.test\.mjs/,
  );
});

const bContext = { cell: "B", candidateSha: B_COMMIT, collectorSha: OTHER_SHA };

test("bindCanonicalSources rejects equal and nested roots before inspecting sources", () => {
  const { root } = makeRepo("bind-equal");
  assert.throws(() => bindCanonicalSources(root, root, bContext), /separate and non-nested/);
  assert.throws(
    () => bindCanonicalSources(root, join(root, "src"), bContext),
    /separate and non-nested/,
  );
  assert.throws(
    () => bindCanonicalSources(join(root, "src"), root, bContext),
    /separate and non-nested/,
  );
});

test("bindCanonicalSources enforces the candidate pre-install boundary", () => {
  const collector = makeRepo("bind-pristine-collector");
  const candidate = makeRepo("bind-pristine-candidate");
  write(candidate.root, "dist/stale.js", "inert stale fixture\n");
  assert.throws(
    () =>
      bindCanonicalSources(collector.root, candidate.root, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: collector.sha,
      }),
    /candidate has ignored pre-install inputs/,
  );
});

test("bindCanonicalSources requires the actual B source", () => {
  const collector = makeRepo("bind-collector");
  const candidate = makeRepo("bind-candidate");
  // Fixture repositories cannot reproduce the pinned B commit, so binding must fail.
  assert.throws(
    () =>
      bindCanonicalSources(collector.root, candidate.root, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: collector.sha,
      }),
    /source HEAD mismatch/,
  );
  assert.throws(
    () =>
      bindCanonicalSources(collector.root, candidate.root, {
        cell: "B",
        candidateSha: B_COMMIT,
        collectorSha: OTHER_SHA,
      }),
    /source HEAD mismatch/,
  );
});
