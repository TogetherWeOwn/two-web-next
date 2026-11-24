import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile, lstat, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fetchPureHonoRecoveryRun } from "./pure-hono-recovery-run.mjs";
import { PRODUCTION_ORIGIN, assertRollbackVersionId } from "./production-deploy-gate.mjs";
import {
  ledgerPrefixes,
  productionUploadConfig,
  readReady,
  sourceInputs,
  uploadVersion,
  verifyPackage,
  verifyStagingProof,
  wrangler,
} from "./kit-cutover-evidence.mjs";

export const STAGING_WORKFLOW = ".github/workflows/xfs-qualification.yml";
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
    return;
  }
  assert.equal(command, "upload");
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
