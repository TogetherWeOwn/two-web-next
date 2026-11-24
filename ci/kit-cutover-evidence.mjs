import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  assertKitProductionCandidate,
  assertRollbackVersionId,
} from "./production-deploy-gate.mjs";
import { readWranglerOutput, sha256 } from "./worker-bundle-evidence.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

export const STAGING_WORKER = "two-web-kit-cutover-proof";
export const LEDGER_STATES = ["1033", "1037"];
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
  const lock = JSON.parse(await readFile(path("package-lock.json"), "utf8"));
  const honoBuild = {
    define: "__TWO_WEB_1033_COMPAT__:true",
    wrangler: lock.packages["node_modules/wrangler"].version,
  };
  assert.match(honoBuild.wrangler, /^\d+\.\d+\.\d+$/);
  return {
    honoBuild,
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
  const manifest = {
    schema: 1,
    ...context,
    configs: inputs.digests,
    honoBuild: inputs.honoBuild,
    files,
  };
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
  assert.deepEqual(manifest.honoBuild, inputs.honoBuild, "cutover Hono build profile mismatch");
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

export function ledgerPrefixes(journal) {
  const expectedTail = [
    "1033_session-roles-checked-at",
    "1034_event-echoes",
    "1035_bot-reconciliation-intents",
    "1036_event-sync-claim-started",
    "1037_waitlist-offers",
    "1038_announcement-send-claims",
  ];
  const start = journal.findIndex(({ tag }) => tag.startsWith("1033_"));
  assert.ok(start > 0, "cutover prefix missing");
  assert.deepEqual(
    journal.slice(start).map(({ tag }) => tag),
    expectedTail,
    "unexpected migration beyond the approved cutover window",
  );
  const timestamps = journal.map(({ when }) => when);
  assert.ok(
    timestamps.every((when, i) => Number.isSafeInteger(when) && when > (timestamps[i - 1] ?? 0)),
    "invalid canonical ledger timestamps",
  );
  return {
    1033: timestamps.slice(0, start + 1),
    1037: timestamps.slice(0, -1),
  };
}

export function verifyReady(status, body, prefixes, { version, commit, state } = {}) {
  assert.ok(
    status === 200 && body?.db === "ok" && body.pending_migrations === 0,
    "Worker readiness did not report HTTP 200, db ok and zero pending",
  );
  if (version || commit) {
    assert.ok(
      (!version || body.revision?.version_id === version) &&
        (!commit || body.revision?.commit === commit),
      "Worker readiness version or commit mismatch",
    );
  }
  const rows = body.migration_ledger;
  assert.ok(Array.isArray(rows), "missing canonical migration ledger");
  for (const candidate of LEDGER_STATES) {
    const expected = prefixes[candidate];
    if (rows.length === expected.length && rows.every((when, i) => when === expected[i])) {
      assert.ok(!state || state === candidate, "Worker readiness ledger state mismatch");
      return candidate;
    }
  }
  throw new Error("Worker ledger is neither the canonical 1033 nor 1037 prefix");
}

export async function readReady(origin, prefixes, expected, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/up", origin), {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json();
  return verifyReady(response.status, body, prefixes, expected);
}

export function verifyStagingProof(proof, pin) {
  const { sourceSha, runId, runAttempt, digest } = pin;
  assert.deepEqual(
    proof.identity,
    { sourceSha, runId, runAttempt, digest },
    "staging proof identity mismatch",
  );
  assert.equal(proof.schema, 1);
  assert.equal(proof.worker, `${STAGING_WORKER}-${runId}-${runAttempt}`);
  assertRollbackVersionId(proof.hono);
  assertRollbackVersionId(proof.kit);
  assert.notEqual(proof.hono, proof.kit, "staging requires distinct versions on one Worker");
  assert.ok(
    hex.test(proof.configs?.hono) && hex.test(proof.configs?.kit),
    "invalid staged config digests",
  );
  assert.ok(
    Number.isSafeInteger(proof.routeCount) && proof.routeCount > 0,
    "empty staged route smoke",
  );
  assert.equal(proof.bindingCheck, "isolated-and-all-off");
  assert.equal(proof.kitReadinessSamples, 6);
  assert.deepEqual(
    proof.checks,
    LEDGER_STATES.flatMap((state) => [
      { state, step: "hono", version: proof.hono, status: 200, pending: 0, smoke: "passed" },
      { state, step: "kit", version: proof.kit, status: 200, pending: 0, smoke: "passed" },
      { state, step: "undo", version: proof.hono, status: 200, pending: 0, smoke: "passed" },
    ]),
    "staging must prove both ledger states and both exact Hono undos",
  );
}

export function productionUploadConfig(profile, { root, kit }) {
  assert.ok(PROFILES.includes(profile));
  const { $schema, env, routes, triggers, ...hono } = { ...root, ...root.env.production };
  const config = profile === "hono" ? hono : { ...kit };
  delete config.$schema;
  delete config.triggers;
  return {
    ...config,
    main: profile === "kit" ? "modules/_worker.js" : "modules/worker.js",
    base_dir: "modules",
    ...(profile === "kit" ? { rules: [{ type: "ESModule", globs: ["kit-adapter.js"] }] } : {}),
    assets: { ...config.assets, directory: "assets" },
  };
}

// Keep Wrangler's argv fixed and never interpret bindings or script content
// from process output. The native JSONL receipt supplies the version identity.
export function uploadVersion(profile, directory, config, tag, options = {}) {
  const output = options.output;
  const args = [
    "versions",
    "upload",
    "--config",
    join(directory, "wrangler.json"),
    "--no-bundle",
    "--upload-source-maps=false",
    "--tag",
    tag,
  ];
  if (options.message) args.push("--message", options.message);
  if (options.secretsFile) args.push("--secrets-file", options.secretsFile);
  wrangler(profile, args, { ...process.env, WRANGLER_OUTPUT_FILE_PATH: output });
  const uploads = readWranglerOutput(output).filter(({ type }) => type === "version-upload");
  assert.equal(uploads.length, 1, "expected one native version upload record");
  const row = uploads[0];
  assert.ok(
    row.version === 1 && row.worker_name === config.name,
    "version upload has wrong target",
  );
  assertRollbackVersionId(row.version_id);
  return row.version_id;
}

export function wrangler(profile, args, env = process.env) {
  assert.ok(PROFILES.includes(profile));
  const tool = profile === "kit" ? "web/node_modules/.bin/wrangler" : "node_modules/.bin/wrangler";
  try {
    return execFileSync(tool, args, {
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 1024 * 1024,
      timeout: 180_000,
    });
  } catch (error) {
    const detail = Number.isSafeInteger(error.status) ? ` (exit ${error.status})` : "";
    throw new Error(`Wrangler ${args[0]} ${args[1]} failed${detail}`);
  }
}
