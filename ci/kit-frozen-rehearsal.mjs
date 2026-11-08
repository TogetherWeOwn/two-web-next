// Snapshot-only dry run. Never uploads, authenticates or qualifies recovery.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyFrozenKitInputs } from "./kit-frozen-inputs.mjs";
import { verifyKitMultipartModules } from "./kit-multipart-modules.mjs";
import { verifyWranglerTool } from "./kit-wrangler-tool.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

function realDirectory(path) {
  const absolute = resolve(path);
  for (let parent = absolute; ; parent = dirname(parent)) {
    assert.ok(lstatSync(parent).isDirectory(), "non-directory or symlink ancestor");
    if (parent === dirname(parent)) break;
  }
  return absolute;
}

function outputBytes(path, maximum = 64 * 1024 * 1024) {
  realDirectory(dirname(path));
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    assert.ok(stat.isFile() && stat.size > 0 && stat.size <= maximum);
    const bytes = readFileSync(fd);
    assert.equal(bytes.length, stat.size, "rehearsal output changed while reading");
    return bytes;
  } finally {
    closeSync(fd);
  }
}

export function rehearseFrozenKitInputs(root, snapshot, destination, context, collaborators = {}) {
  const verifyInputs = collaborators.verifyInputs ?? verifyFrozenKitInputs;
  const verifyTool = collaborators.verifyTool ?? verifyWranglerTool;
  const run = collaborators.run ?? spawnSync;
  const base = realDirectory(root);
  const frozen = realDirectory(snapshot);
  const output = resolve(destination);
  realDirectory(dirname(output));
  assert.ok(output !== frozen && !output.startsWith(`${frozen}${sep}`), "output overlaps snapshot");
  const inputs = verifyInputs(frozen, context);
  const tool = verifyTool(base);
  for (const lock of tool.locks) {
    assert.deepEqual(
      inputs.files.find((file) => file.path === `source/${lock.path}`),
      { ...lock, path: `source/${lock.path}` },
      "frozen lock differs from checked installed tool",
    );
  }
  const expectedWorker = outputBytes(join(frozen, "build/worker.js"));
  // A fresh cwd/HOME excludes project redirects, dotenv files and cached auth.
  // Explicit --config bypasses Wrangler's generated-config discovery. --assets
  // overrides only the directory, preserving the reviewed binding/router policy.
  mkdirSync(output, { mode: 0o700 });
  for (const path of ["home", "tmp", "config", "private"]) {
    mkdirSync(join(output, path), { mode: 0o700 });
  }
  const multipartPath = join(output, "private/form-data");
  const args = [
    join(base, tool.entry),
    "versions",
    "upload",
    "--dry-run",
    "--no-bundle",
    join(frozen, "build/worker.js"),
    "--config",
    join(frozen, "source/web/wrangler.production.jsonc"),
    "--assets",
    join(frozen, "adapter"),
    "--outdir",
    join(output, "output"),
    "--outfile",
    multipartPath,
  ];
  const env = {
    CI: "true",
    HOME: join(output, "home"),
    XDG_CONFIG_HOME: join(output, "config"),
    TMPDIR: join(output, "tmp"),
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    CLOUDFLARE_SEND_METRICS: "false",
    WRANGLER_SEND_METRICS: "false",
  };
  let multipart;
  try {
    const child = run(process.execPath, args, {
      cwd: output,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });
    // Do not print or retain child output, cached state or diagnostic log files.
    assert.ok(!child.error && !child.signal && child.status === 0, "frozen dry run failed");
    multipart = verifyKitMultipartModules(
      outputBytes(multipartPath, 65 * 1024 * 1024),
      expectedWorker,
    );
  } finally {
    // Raw metadata may contain binding values. Unlink even on child/parser failure;
    // only the sanitized projection below can enter the retained receipt.
    const raw = lstatSync(multipartPath, { throwIfNoEntry: false });
    if (raw) unlinkSync(multipartPath);
  }
  assert.deepEqual(verifyInputs(frozen, context), inputs, "snapshot changed during dry run");
  assert.deepEqual(verifyTool(base), tool, "checked tool changed during dry run");
  const emitted = realDirectory(join(output, "output"));
  // This finite no-bundle contract permits one runtime module and Wrangler's
  // explanatory README, not an unnoticed extra module, map or subdirectory.
  assert.deepEqual(
    readdirSync(emitted).sort(),
    ["README.md", "worker.js"],
    "unexpected frozen dry-run output membership",
  );
  const actualWorker = outputBytes(join(emitted, "worker.js"));
  assert.deepEqual(actualWorker, expectedWorker, "frozen dry run changed Worker bytes");
  const readme = outputBytes(join(emitted, "README.md"), 64 * 1024);
  const receipt = {
    schema: "two.kit-frozen-rehearsal.v1",
    evidence: "frozen-input-dry-run-only",
    sourceSha: inputs.sourceSha,
    runId: inputs.runId,
    runAttempt: inputs.runAttempt,
    target: inputs.target,
    snapshotSha256: sha256(JSON.stringify(inputs)),
    toolSha256: sha256(JSON.stringify(tool)),
    workerSha256: sha256(actualWorker),
    multipart,
    emittedFiles: [
      { path: "README.md", bytes: readme.length, sha256: sha256(readme) },
      { path: "worker.js", bytes: actualWorker.length, sha256: sha256(actualWorker) },
    ],
    invocation: {
      command: ["versions", "upload", "--dry-run", "--no-bundle"],
      entry: "build/worker.js",
      config: "source/web/wrangler.production.jsonc",
      assets: "adapter",
      environmentKeys: Object.keys(env).sort(),
    },
  };
  writeFileSync(join(output, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return receipt;
}

function main() {
  const [snapshot, destination, ...extra] = process.argv.slice(2);
  assert.ok(snapshot && destination && !extra.length, "expected snapshot and new destination");
  rehearseFrozenKitInputs(process.cwd(), snapshot, destination, {
    sourceSha: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID,
    runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
