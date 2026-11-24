import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEDGER_STATES,
  STAGING_WORKER,
  ledgerPrefixes,
  productionUploadConfig,
  selection,
  sourceInputs,
  undoMessage,
  verifyPackage,
  verifyProducer,
  verifyReady,
  verifyStagingProof,
  verifyUndoVersion,
  writeManifest,
} from "./kit-cutover-evidence.mjs";
import { fixtureDatabase, stagingConfig } from "./kit-cutover-staging.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const inputs = await sourceInputs();

test("cutover requires explicit protected selection and the paired Hono UUID", () => {
  const active = {
    CUTOVER_MODE: "kit",
    CUTOVER_PIN: `21:3:${digest}`,
    CUTOVER_UNDO_VERSION: hono,
    INPUT_SHA: sourceSha,
    DEPLOY_SHA: sourceSha,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REF: "refs/heads/main",
    PRODUCTION_AUTO_PROMOTE_DISABLED: "true",
  };
  assert.deepEqual(selection({}), { mode: "ordinary" });
  assert.deepEqual(selection(active), { mode: "kit", undo: hono, ...identity });
  assert.deepEqual(selection({ ...active, CUTOVER_MODE: "hono", CUTOVER_UNDO_VERSION: "" }), {
    mode: "hono",
    undo: "",
    ...identity,
  });
  for (const change of [
    { CUTOVER_MODE: "" },
    { GITHUB_EVENT_NAME: "workflow_run" },
    { GITHUB_REF: "refs/heads/topic" },
    { INPUT_SHA: "" },
    { DEPLOY_SHA: "d".repeat(40) },
    { CUTOVER_PIN: `21:03:${digest}` },
    { CUTOVER_UNDO_VERSION: "" },
    { PRODUCTION_AUTO_PROMOTE_DISABLED: "false" },
    { MIGRATIONS_APPLIED: "true" },
  ]) {
    assert.throws(() => selection({ ...active, ...change }));
  }
  const version = {
    id: hono,
    annotations: { "workers/tag": `${sourceSha}-99-1`, "workers/message": undoMessage(digest) },
  };
  verifyUndoVersion(version, { ...identity, undo: hono });
  assert.throws(() => verifyUndoVersion(version, { ...identity, undo: kit }), /Hono undo artifact/);
  assert.throws(
    () => verifyUndoVersion(version, { ...identity, undo: hono, digest: "d".repeat(64) }),
    /Hono undo artifact/,
  );
});

test("only exact successful main XFS dispatch metadata can produce a cutover packet", async () => {
  const own = { full_name: "TogetherWeOwn/two-web-next", fork: false, id: 23 };
  const run = {
    id: 21,
    run_attempt: 3,
    repository: own,
    head_repository: own,
    head_sha: sourceSha,
    path: ".github/workflows/xfs-qualification.yml",
    head_branch: "main",
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
  };
  const request = async (url) => {
    assert.equal(
      url,
      "https://api.github.com/repos/TogetherWeOwn/two-web-next/actions/runs/21/attempts/3",
    );
    return Response.json(run);
  };
  assert.equal((await verifyProducer(identity, "synthetic", request)).runAttempt, "3");
  for (const override of [
    { id: 23 },
    { run_attempt: 2 },
    { head_sha: "d".repeat(40) },
    { head_repository: { ...own, fork: true } },
    { status: "in_progress" },
    { path: ".github/workflows/ci.yml" },
    { event: "pull_request" },
    { conclusion: "failure" },
  ]) {
    await assert.rejects(
      verifyProducer(identity, "synthetic", async () => Response.json({ ...run, ...override })),
      /attempt metadata/,
    );
  }
});

test("cutover packet refuses wrong bytes, package identity, or source config", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "cutover-packet-test-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  for (const profile of ["hono", "kit"]) {
    await mkdir(join(scratch, profile, "modules"), { recursive: true });
    await mkdir(join(scratch, profile, "assets"));
    await writeFile(join(scratch, profile, "assets", ".assetsignore"), "fixture");
  }
  await writeFile(join(scratch, "hono/modules/worker.js"), "pure Hono");
  await writeFile(join(scratch, "kit/modules/_worker.js"), "facade");
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  const context = { sourceSha, runId: identity.runId, runAttempt: identity.runAttempt };
  const pin = { ...context, digest: await writeManifest(scratch, context, inputs) };
  await verifyPackage(scratch, pin, inputs);
  await assert.rejects(verifyPackage(scratch, { ...pin, digest }, inputs), /manifest digest/);
  for (const [field, value] of [
    ["sourceSha", "d".repeat(40)],
    ["runId", "22"],
    ["runAttempt", "4"],
  ]) {
    await assert.rejects(
      verifyPackage(scratch, { ...pin, [field]: value }, inputs),
      new RegExp(field),
    );
  }
  await assert.rejects(
    verifyPackage(scratch, pin, {
      digests: { ...inputs.digests, honoConfig: digest },
    }),
    /config or journal digest/,
  );
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "changed");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /kit bytes mismatch/);
  await writeFile(join(scratch, "kit/modules/kit-adapter.js"), "Kit adapter");
  await writeFile(join(scratch, "hono/assets/.assetsignore"), "changed Hono asset control file");
  await assert.rejects(verifyPackage(scratch, pin, inputs), /hono bytes mismatch/);
});

test("cutover ledger admits exactly 1033 or 1037 and exact version readiness", () => {
  const prefixes = ledgerPrefixes(inputs.journal);
  const body = {
    db: "ok",
    pending_migrations: 0,
    migration_ledger: prefixes["1033"],
    revision: { version_id: hono, commit: sourceSha },
  };
  const expected = { version: hono, commit: sourceSha };
  for (const [state, rows] of Object.entries(prefixes)) {
    assert.equal(verifyReady(200, { ...body, migration_ledger: rows }, prefixes, expected), state);
  }
  assert.throws(() => verifyReady(503, body, prefixes, expected), /readiness/);
  assert.throws(() => verifyReady(200, { ...body, pending_migrations: 1 }, prefixes), /readiness/);
  assert.throws(() => verifyReady(200, body, prefixes, { version: kit }), /version or commit/);
  for (const rows of [
    prefixes["1037"].slice(0, -1),
    [...prefixes["1033"], prefixes["1037"].at(-1)],
    [...prefixes["1037"], inputs.journal.at(-1).when],
    [...prefixes["1033"], prefixes["1033"].at(-1)],
    prefixes["1033"].map(String),
  ]) {
    assert.throws(
      () => verifyReady(200, { ...body, migration_ledger: rows }, prefixes),
      /canonical/,
    );
  }
});

test("isolated cutover proof requires both exact versions and six healthy transitions", () => {
  const checks = LEDGER_STATES.flatMap((state) =>
    ["hono", "kit", "undo"].map((step) => ({
      state,
      step,
      version: step === "kit" ? kit : hono,
      status: 200,
      pending: 0,
      smoke: "passed",
    })),
  );
  const proof = {
    schema: 1,
    identity,
    worker: `${STAGING_WORKER}-21-3`,
    hono,
    kit,
    checks,
    configs: { kit: digest, hono: digest },
    routeCount: 24,
    kitReadinessSamples: 6,
    bindingCheck: "isolated-and-all-off",
  };
  verifyStagingProof(proof, identity);
  for (const change of [{ status: 503 }, { pending: 1 }, { version: kit }, { smoke: "failed" }]) {
    assert.throws(
      () =>
        verifyStagingProof(
          {
            ...proof,
            checks: checks.map((row, i) => (i === 2 ? { ...row, ...change } : row)),
          },
          identity,
        ),
      /must prove/,
    );
  }
  assert.throws(() => verifyStagingProof(proof, { ...identity, runAttempt: "2" }), /identity/);
  assert.throws(
    () => verifyStagingProof({ ...proof, checks: checks.slice(0, 3) }, identity),
    /must prove/,
  );
});

test("upload config keeps production bindings and isolates synthetic staging", () => {
  const production = inputs.root.env.production;
  for (const profile of ["hono", "kit"]) {
    const config = productionUploadConfig(profile, inputs);
    for (const key of ["hyperdrive", "queues", "tail_consumers", "version_metadata"]) {
      assert.deepEqual(config[key], production[key]);
    }
    for (const key of ["routes", "env", "triggers"]) assert.ok(!Object.hasOwn(config, key));
    const staged = stagingConfig(profile, inputs, STAGING_WORKER, "https://fixture.example.test");
    for (const key of ["hyperdrive", "queues", "tail_consumers", "routes", "triggers"]) {
      assert.ok(!Object.hasOwn(staged, key));
    }
    if (profile === "kit") {
      assert.equal(
        Object.keys(config.vars).filter((name) => name.startsWith("KIT_ROUTE_")).length,
        5,
      );
      for (const [key, value] of Object.entries(config.vars)) {
        if (key.startsWith("KIT_ROUTE_")) {
          assert.equal(value, "false");
          assert.equal(staged.vars[key], "false");
        }
      }
    }
  }
  const host = "ep-fixture.us-east-2.aws.neon.tech";
  const fixture = `postgresql://two_web_cutover_owner:synthetic@${host}/two_web_cutover`;
  assert.equal(fixtureDatabase(fixture, host).hostname, host);
  assert.throws(() => fixtureDatabase(fixture, "ep-different.us-east-2.aws.neon.tech"));
  assert.throws(() => fixtureDatabase(fixture.replace("/two_web_cutover", "/main"), host));
  assert.throws(() => fixtureDatabase(`${fixture}?options=override`, host));
});
