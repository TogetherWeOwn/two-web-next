import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, copyFile, cp, mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  inventory,
  ledgerPrefixes,
  sourceInputs,
  verifyPackage,
  writeManifest,
} from "./kit-cutover-evidence.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";

// Publish only after the parity verifier has approved the exact installed
// bytes. Wrangler receives an explicit Hono compile-time readiness profile.
export async function packageCutover(dir, repo, installed, identity, context) {
  const inputs = await sourceInputs(repo);
  ledgerPrefixes(inputs.journal);
  await mkdir(dir);
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(dir, profile, "modules"), { recursive: true });
  }
  const assets = await inventory(installed.assets);
  assert.deepEqual(
    assets,
    Object.fromEntries(
      Object.entries(identity.files)
        .filter(([name]) => name.startsWith("cloudflare/"))
        .map(([name, digest]) => [name.slice("cloudflare/".length), digest]),
    ),
    "installed Kit assets drifted after parity",
  );
  await cp(installed.assets, join(dir, "kit/assets"), { recursive: true, errorOnExist: true });
  for (const name of ["_worker.js", "kit-adapter.js"]) {
    await copyFile(join(dir, "kit/assets", name), join(dir, "kit/modules", name));
    assert.equal(sha256(await readFile(join(dir, "kit/modules", name))), assets[name]);
  }
  assert.deepEqual(await inventory(join(dir, "kit/assets")), assets);
  const publicFiles = await inventory(join(repo, "public"));
  await cp(join(repo, "public"), join(dir, "hono/assets"), { recursive: true, errorOnExist: true });
  assert.deepEqual(await inventory(join(dir, "hono/assets")), publicFiles);

  const scratch = await mkdtemp(join(process.env.RUNNER_TEMP, "hono-cutover-build-"));
  try {
    execFileSync(
      join(repo, "node_modules/.bin/wrangler"),
      [
        "deploy",
        "--dry-run",
        "--env",
        "production",
        "--outdir",
        scratch,
        "--define",
        "__TWO_WEB_1033_COMPAT__:true",
        "--upload-source-maps=false",
      ],
      { cwd: repo, stdio: "inherit", timeout: 120_000 },
    );
    const files = await readdir(scratch);
    assert.ok(
      files.includes("worker.js") &&
        files.every((file) => ["worker.js", "worker.js.map", "README.md"].includes(file)),
      "unexpected Hono dry-run modules",
    );
    await copyFile(join(scratch, "worker.js"), join(dir, "hono/modules/worker.js"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }

  const digest = await writeManifest(dir, context, inputs);
  await verifyPackage(dir, { ...context, digest }, inputs);
  await appendFile(process.env.GITHUB_OUTPUT, `digest=${digest}\n`);
}
