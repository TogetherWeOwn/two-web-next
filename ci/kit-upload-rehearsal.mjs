// Build-only receipt. Neither this tree nor a dry run proves what Cloudflare uploaded.
import assert from "node:assert/strict";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
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
  assert.ok(build.some((item) => item.path === "bundle-meta.json"), "metafile missing");
  const assets = tree(join(root, "web/.svelte-kit/cloudflare"));
  for (const required of ["_worker.js", "_headers", "_app/version.json"]) {
    assert.ok(assets.some((item) => item.path === required), `missing Kit build file: ${required}`);
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
