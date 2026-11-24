import assert from "node:assert/strict";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertKitProductionCandidate,
  assertRollbackVersionId,
} from "./production-deploy-gate.mjs";
import { sha256 } from "./worker-bundle-evidence.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

export const PROFILES = ["hono", "kit"];
const maxFileBytes = 32 * 1024 * 1024;
const maxPacketBytes = 128 * 1024 * 1024;
const hex = /^[a-f0-9]{64}$/;

export async function sourceInputs(root = ".") {
  const path = (file) => join(root, file);
  const rootBytes = await readFile(path("wrangler.jsonc"));
  const kitBytes = await readFile(path("web/wrangler.production.jsonc"));
  const journalBytes = await readFile(path("drizzle/meta/_journal.json"));
  assertKitProductionCandidate(rootBytes.toString(), kitBytes.toString());
  const rootConfig = readWranglerConfig(rootBytes.toString());
  const kit = readWranglerConfig(kitBytes.toString());
  const production = { ...rootConfig, ...rootConfig.env.production };
  for (const key of [
    "compatibility_date",
    "compatibility_flags",
    "observability",
    "placement",
    "keep_vars",
  ]) {
    assert.deepEqual(kit[key], production[key], `unexpected Kit production ${key}`);
  }
  assert.equal(kit.main, ".svelte-kit/cloudflare/_worker.js");
  assert.equal(production.main, "src/worker.ts");
  return {
    root: rootConfig,
    kit,
    journal: JSON.parse(journalBytes).entries,
    digests: {
      honoConfig: sha256(rootBytes),
      kitConfig: sha256(kitBytes),
      journal: sha256(journalBytes),
    },
  };
}

export async function inventory(dir) {
  assert.ok((await lstat(dir)).isDirectory(), "cutover package directory is unsafe");
  const files = {};
  let total = 0;
  const walk = async (prefix) => {
    const entries = await readdir(join(dir, prefix), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
      assert.match(entry.name, /^(?!\.{1,2}$)[A-Za-z0-9._-]+$/, "unsafe cutover asset name");
      const key = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(key);
        continue;
      }
      assert.ok(entry.isFile(), "cutover package requires regular files");
      const path = join(dir, key);
      const { size } = await lstat(path);
      total += size;
      assert.ok(size <= maxFileBytes && total <= maxPacketBytes, "cutover package size limit");
      files[key] = sha256(await readFile(path));
    }
  };
  await walk("");
  return files;
}

export async function writeManifest(dir, context, inputs) {
  const files = Object.fromEntries(
    await Promise.all(
      PROFILES.map(async (profile) => [profile, await inventory(join(dir, profile))]),
    ),
  );
  const manifest = { schema: 1, ...context, configs: inputs.digests, files };
  const bytes = JSON.stringify(manifest);
  await writeFile(join(dir, "manifest.json"), bytes, { flag: "wx" });
  return sha256(bytes);
}

export async function verifyPackage(dir, pin, inputs) {
  assert.ok((await lstat(dir)).isDirectory(), "cutover packet directory is unsafe");
  assert.deepEqual((await readdir(dir)).sort(), ["hono", "kit", "manifest.json"]);
  const path = join(dir, "manifest.json");
  const stat = await lstat(path);
  assert.ok(stat.isFile() && stat.size <= 1024 * 1024, "invalid cutover manifest");
  const bytes = await readFile(path);
  assert.ok(
    hex.test(pin.digest) && sha256(bytes) === pin.digest,
    "cutover manifest digest mismatch",
  );
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.schema, 1);
  for (const field of ["sourceSha", "runId", "runAttempt"]) {
    assert.equal(manifest[field], pin[field], `cutover package ${field} mismatch`);
  }
  assert.deepEqual(
    manifest.configs,
    inputs.digests,
    "cutover source config or journal digest mismatch",
  );
  for (const profile of PROFILES) {
    const files = await inventory(join(dir, profile));
    assert.ok(
      Object.keys(files).some((name) => name.startsWith("assets/")),
      "missing Worker assets",
    );
    assert.deepEqual(
      Object.keys(files)
        .filter((name) => name.startsWith("modules/"))
        .sort(),
      profile === "hono" ? ["modules/worker.js"] : ["modules/_worker.js", "modules/kit-adapter.js"],
      `unexpected ${profile} module set`,
    );
    assert.deepEqual(files, manifest.files[profile], `cutover ${profile} bytes mismatch`);
  }
  return manifest;
}
