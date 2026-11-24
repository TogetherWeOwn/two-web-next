import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchPureHonoRecoveryRun } from "./pure-hono-recovery-run.mjs";
import {
  PRODUCTION_ORIGIN,
  assertKitProductionCandidate,
  assertRollbackVersionId,
} from "./production-deploy-gate.mjs";
import { readWranglerOutput, sha256 } from "./worker-bundle-evidence.mjs";
import { readWranglerConfig } from "./wrangler-config.mjs";

export const STAGING_WORKER = "two-web-kit-cutover-proof";
export const STAGING_WORKFLOW = ".github/workflows/xfs-qualification.yml";
export const PROFILES = ["hono", "kit"];
export const LEDGER_STATES = ["1033", "1037"];
const maxFileBytes = 32 * 1024 * 1024;
const maxPacketBytes = 128 * 1024 * 1024;
const hex = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const tagSuffix = /^[1-9]\d{0,14}-[1-9]\d{0,14}$/;

export function selection(env) {
  const mode = env.CUTOVER_MODE || "ordinary";
  const pin = env.CUTOVER_PIN || "";
  const undo = env.CUTOVER_UNDO_VERSION || "";
  if (mode === "ordinary") {
    assert.ok(!pin && !undo, "cutover inputs require an explicit cutover mode");
    return { mode };
  }
  assert.ok(mode === "kit" || mode === "hono", "unknown cutover mode");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.INPUT_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(env.DEPLOY_SHA, env.INPUT_SHA, "explicit cutover source mismatch");
  assert.equal(
    env.PRODUCTION_AUTO_PROMOTE_DISABLED,
    "true",
    "pause automatic promotion for cutover",
  );
  assert.notEqual(env.MIGRATIONS_APPLIED, "true", "cutover requires observed ledger evidence");
  const parsed = /^([1-9]\d{0,14}):([1-9]\d{0,14}):([a-f0-9]{64})$/.exec(pin);
  assert.ok(parsed, "expected cutover run:attempt:manifest SHA-256");
  assert.ok(mode === "kit" ? uuid.test(undo) : undo === "", "invalid expected Hono undo version");
  const [, runId, runAttempt, digest] = parsed;
  return { mode, sourceSha: env.DEPLOY_SHA, runId, runAttempt, digest, undo };
}

export async function verifyProducer(pin, token, fetchImpl) {
  return fetchPureHonoRecoveryRun(
    { ...pin, workflow: STAGING_WORKFLOW, event: "workflow_dispatch" },
    token,
    fetchImpl,
  );
}

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

export const undoMessage = (digest) => `two-web-cutover-undo:${digest}`;

export function verifyUndoVersion(version, pin) {
  const tag = version?.annotations?.["workers/tag"];
  assert.ok(
    version?.id === pin.undo &&
      typeof tag === "string" &&
      tag.startsWith(`${pin.sourceSha}-`) &&
      tagSuffix.test(tag.slice(pin.sourceSha.length + 1)) &&
      version.annotations["workers/message"] === undoMessage(pin.digest),
    "live rollback version does not identify the staged Hono undo artifact",
  );
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

async function main() {
  const [command, dir, proofPath] = process.argv.slice(2);
  const pin = selection(process.env);
  if (command === "select") {
    await appendFile(process.env.GITHUB_OUTPUT, `mode=${pin.mode}\n`);
    if (pin.mode === "ordinary") return;
    await verifyProducer(pin, process.env.GITHUB_TOKEN);
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `run_id=${pin.runId}\nrun_attempt=${pin.runAttempt}\n`,
    );
    return;
  }
  assert.ok(pin.mode !== "ordinary", "cutover command requires an explicit selection");
  const inputs = await sourceInputs();
  const prefixes = ledgerPrefixes(inputs.journal);
  if (command === "live") {
    const version = process.env.PROMOTED_VERSION_ID;
    assertRollbackVersionId(version);
    assert.equal(
      version,
      process.env.CUTOVER_UPLOADED_VERSION,
      "promoted cutover version mismatch",
    );
    assert.equal(
      process.env.PREV_VERSION,
      process.env.CUTOVER_UNDO_TARGET,
      "cutover rollback target changed",
    );
    await readReady(PRODUCTION_ORIGIN, prefixes, { version, commit: pin.sourceSha });
    return;
  }
  const version = process.env.ROLLBACK_VERSION_ID;
  assertRollbackVersionId(version);
  if (pin.mode === "kit")
    assert.equal(version, pin.undo, "recorded rollback target is not the expected Hono UUID");
  const expected = { version, ...(pin.mode === "kit" ? { commit: pin.sourceSha } : {}) };
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    pin.sourceSha,
  );
  await verifyPackage(dir, pin, inputs);
  const state = await readReady(PRODUCTION_ORIGIN, prefixes, expected);
  console.info(`Readiness verified at the canonical ${state} ledger`);
  if (pin.mode === "kit") {
    const view = wrangler("hono", [
      "versions",
      "view",
      pin.undo,
      "--name",
      "two-web-next-production",
      "--json",
    ]);
    verifyUndoVersion(JSON.parse(view), pin);
  }
  if (command === "prepare") {
    const stat = await lstat(proofPath);
    assert.ok(stat.isFile() && stat.size <= 16 * 1024, "invalid staging proof");
    verifyStagingProof(JSON.parse(await readFile(proofPath, "utf8")), pin);
    await appendFile(process.env.GITHUB_OUTPUT, `manifest=${pin.digest}\n`);
    return;
  }
  assert.equal(command, "upload");
  assert.equal(
    process.env.CUTOVER_MANIFEST,
    pin.digest,
    "cutover packet was not admitted under the lock",
  );
  const config = productionUploadConfig(pin.mode, inputs);
  const directory = join(dir, pin.mode);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify(config), { flag: "wx" });
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  assert.match(`${runId}-${attempt}`, tagSuffix, "invalid deployment attempt");
  const uploaded = uploadVersion(
    pin.mode,
    directory,
    config,
    `${pin.sourceSha}-${runId}-${attempt}`,
    {
      message: pin.mode === "hono" ? undoMessage(pin.digest) : `two-web-cutover-kit:${pin.digest}`,
      output: process.env.WRANGLER_OUTPUT_FILE_PATH,
    },
  );
  await appendFile(process.env.GITHUB_OUTPUT, `version_id=${uploaded}\n`);
  console.info(`Uploaded staged ${pin.mode} version ${uploaded}, manifest ${pin.digest}`);
}

if (import.meta.main) await main();
