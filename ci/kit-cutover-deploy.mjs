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
import { createRouteEvidenceRequest } from "./route-evidence-github.mjs";
import { fetchRouteEvidenceProducer } from "./route-evidence-jobs.mjs";

export const STAGING_WORKFLOW = ".github/workflows/xfs-qualification.yml";
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const tagSuffix = /^[1-9]\d{0,14}-[1-9]\d{0,14}$/;

export function selection(env) {
  const mode = env.CUTOVER_MODE || "ordinary";
  const pin = env.CUTOVER_PIN || "";
  const undo = env.CUTOVER_UNDO_VERSION || "";
  const undoDigest = env.CUTOVER_UNDO_DIGEST || "";
  if (mode === "admin") assert.match(undoDigest, /^[a-f0-9]{64}$/, "invalid Ember undo digest");
  else assert.equal(undoDigest, "", "Ember undo digest requires admin mode");
  if (mode === "ordinary") {
    assert.ok(!pin && !undo, "cutover inputs require an explicit cutover mode");
    return { mode };
  }
  assert.ok(["kit", "ember", "hono", "admin"].includes(mode), "unknown cutover mode");
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
  assert.ok(mode === "hono" ? undo === "" : uuid.test(undo), "invalid expected undo version");
  const [, runId, runAttempt, digest] = parsed;
  const selected = { mode, sourceSha: env.DEPLOY_SHA, runId, runAttempt, digest, undo };
  return undoDigest ? { ...selected, undoDigest } : selected;
}

export async function verifyProducer(pin, token, fetchImpl) {
  const run = await fetchPureHonoRecoveryRun(
    { ...pin, workflow: STAGING_WORKFLOW, event: "workflow_dispatch" },
    token,
    fetchImpl,
  );
  const job = await fetchRouteEvidenceProducer(
    createRouteEvidenceRequest(run.repository, token, fetchImpl),
    Number(run.runId),
    Number(run.runAttempt),
    "isolated-cutover",
  );
  // A green generic XFS run can skip isolated cutover. Require the upload
  // itself on the pinned attempt before exporting a usable production pin.
  const uploads = Array.isArray(job.steps)
    ? job.steps.filter((step) => step?.name === "Retain successful isolated cutover proof")
    : [];
  assert.ok(
    job.run_id === Number(run.runId) &&
      job.run_attempt === Number(run.runAttempt) &&
      job.status === "completed" &&
      job.conclusion === "success" &&
      uploads.length === 1 &&
      uploads[0].status === "completed" &&
      uploads[0].conclusion === "success",
    "isolated cutover proof upload did not succeed on the pinned attempt",
  );
  return run;
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

export function verifyEmberUndoVersion(version, { undo, undoDigest }, commit) {
  const tag = version?.annotations?.["workers/tag"];
  const bindings = version?.resources?.bindings;
  assert.ok(
    version?.id === undo &&
      /^[a-f0-9]{40}$/.test(commit ?? "") &&
      typeof tag === "string" &&
      tag.startsWith(`${commit}-`) &&
      tagSuffix.test(tag.slice(commit.length + 1)) &&
      version.annotations["workers/message"] === `two-web-cutover-kit:${undoDigest}` &&
      Array.isArray(bindings),
    "rollback target is not the recorded Ember release",
  );
  const lookup = (name) => {
    const matches = bindings.filter((binding) => binding.name === name);
    assert.ok(matches.length === 0 || (matches.length === 1 && matches[0].type === "plain_text"));
    return matches[0]?.text;
  };
  assert.equal(lookup("APP_URL"), PRODUCTION_ORIGIN, "rollback target lacks the production origin");
  assert.equal(lookup("KIT_ROUTE_EMBER_PAGES"), "true", "rollback target lacks Ember");
  assert.ok(
    [undefined, "false"].includes(lookup("KIT_ROUTE_ADMIN")),
    "rollback target already enables Kit admin",
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
    assert.ok(
      version === process.env.CUTOVER_UPLOADED_VERSION &&
        process.env.PREV_VERSION === process.env.CUTOVER_UNDO_TARGET,
      "cutover version pair changed",
    );
    const state = pin.mode === "admin" ? "1037" : undefined;
    await readReady(PRODUCTION_ORIGIN, prefixes, { version, commit: pin.sourceSha, state });
    if (pin.mode === "admin") await verifyOperatorDenial(PRODUCTION_ORIGIN);
    return;
  }
  const version = process.env.ROLLBACK_VERSION_ID;
  assertRollbackVersionId(version);
  const profile = pin.mode === "hono" ? "hono" : "kit";
  if (profile === "kit")
    assert.equal(version, pin.undo, "recorded rollback target is not the expected UUID");
  const expected =
    profile === "kit"
      ? { version, commit: pin.mode === "admin" ? process.env.ROLLBACK_COMMIT : pin.sourceSha }
      : { version, allowDeferred: true };
  assert.equal(
    execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    pin.sourceSha,
  );
  await verifyPackage(dir, pin, inputs);
  const state = await readReady(PRODUCTION_ORIGIN, prefixes, expected);
  if (pin.mode === "admin") assert.equal(state, "1037", "admin requires the post-cutover ledger");
  console.info(`Readiness verified at the canonical ${state} ledger`);
  if (profile === "kit") {
    const view = wrangler("hono", [
      "versions",
      "view",
      pin.undo,
      "--name",
      "two-web-next-production",
      "--json",
    ]);
    const rollback = JSON.parse(view);
    if (pin.mode === "admin") verifyEmberUndoVersion(rollback, pin, expected.commit);
    else verifyUndoVersion(rollback, pin);
  }
  if (command === "prepare") {
    const stat = await lstat(proofPath);
    assert.ok(stat.isFile() && stat.size <= 16 * 1024, "invalid staging proof");
    verifyStagingProof(JSON.parse(await readFile(proofPath, "utf8")), pin);
    return;
  }
  assert.equal(command, "upload");
  const mode = ["ember", "admin"].includes(pin.mode) ? pin.mode : "all-off";
  const config = productionUploadConfig(profile, inputs, mode);
  const directory = join(dir, profile);
  await writeFile(join(directory, "wrangler.json"), JSON.stringify(config), { flag: "wx" });
  const { GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt } = process.env;
  assert.match(`${runId}-${attempt}`, tagSuffix, "invalid deployment attempt");
  const uploaded = uploadVersion(
    profile,
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

export async function verifyOperatorDenial(origin, fetchImpl = fetch) {
  const response = await fetchImpl(new URL("/admin/ops-overrides", origin), {
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  try {
    await response.body?.cancel();
  } catch {
    console.warn("Could not cancel the unused operator denial response body");
  }
  assert.ok([401, 404].includes(response.status), "operator route admits anonymous traffic");
  assert.equal(response.headers.get("x-two-renderer"), "kit");
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.match(response.headers.get("cache-control") ?? "", /\bno-store\b/);
  assert.equal(response.headers.get("set-cookie"), null);
  if (response.status === 401) assert.equal(response.headers.get("www-authenticate"), "Bearer");
}

if (import.meta.main) await main();
