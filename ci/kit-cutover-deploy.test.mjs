import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { fileURLToPath } from "node:url";
import { first, preRollback, soakEnv, trustedReads } from "../test/fixtures/staging-soak-http.mjs";
import { verifyOrdinaryLedger } from "./check-production-secrets.mjs";
import {
  productionUploadConfig,
  verifyReady,
  verifyStagingProof,
} from "./kit-cutover-evidence.mjs";
import {
  selection,
  undoMessage,
  uploadCutover,
  verifyEmberUndoVersion,
  verifyOperatorDenial,
  verifyProducer,
  verifyUndoVersion,
} from "./kit-cutover-deploy.mjs";
import { STAGING_ORIGIN } from "./operator-constants.mjs";
import { verifyAllocationSoak } from "./production-deploy-gate.mjs";
import { deploymentTarget } from "./staging-deploy-gate.mjs";
import { resolveStagingCandidate } from "./staging-provenance.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const undoDigest = "c".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const proofUpload = {
  name: "Retain successful isolated cutover proof",
  status: "completed",
  conclusion: "success",
};

function completedCutoverJob({ runId, runAttempt }) {
  return {
    id: 25,
    name: "isolated-cutover",
    run_id: Number(runId),
    run_attempt: Number(runAttempt),
    status: "completed",
    conclusion: "success",
    steps: [proofUpload],
  };
}

const emberUndoVersion = {
  id: kit,
  annotations: {
    "workers/tag": `${sourceSha}-99-1`,
    "workers/message": `two-web-cutover-kit:${undoDigest}`,
  },
};

const readbackSection = "## Ember release input readback";
const qualificationPin = `21:3:${digest}`;
const readbackFields = {
  candidate_sha: sourceSha,
  candidate_pin: qualificationPin,
  hono_sha: sourceSha,
  hono_pin: qualificationPin,
  hono_serving_version: hono,
  hono_version_id: hono,
  hono_tag: `${sourceSha}-99-1`,
  hono_annotation: undoMessage(digest),
};

function evidencePacket(fields) {
  return [
    "# Release evidence",
    "",
    "Historical candidate and private notes go here.",
    "",
    readbackSection,
    "",
    "```text",
    ...Object.entries(fields).map(([field, value]) => `${field}=${value}`),
    "```",
    "",
    "### Further release evidence",
  ].join("\n");
}

function offlineReadback(input) {
  const cli = fileURLToPath(new URL("./read-ember-release-evidence.mjs", import.meta.url));
  return spawnSync(process.execPath, [cli], { input, encoding: "utf8", env: {}, timeout: 5_000 });
}

function assertReadbackRejected(input) {
  const result = offlineReadback(input);
  assert.equal(result.status, 1, result.error?.message);
  assert.equal(result.stdout, "");
  assert.equal(
    result.stderr,
    "Ember release readback failed. Check the evidence section, candidate pin and Hono undo binding.\n",
  );
}

test("offline Ember readback emits only the candidate and bound production undo identifiers", () => {
  const result = offlineReadback(evidencePacket(readbackFields).replaceAll("\n", "\r\n"));
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    mode: "ember",
    candidateSha: sourceSha,
    qualificationPin,
    honoUndoVersion: hono,
    undoManifestSha256: digest,
  });
});

test("offline Ember readback refuses mismatched, absent and ambiguous evidence without echoing it", () => {
  const otherSha = "d".repeat(40);
  const otherEvidence = [
    { candidate_pin: `21:03:${digest}`, hono_pin: `21:03:${digest}` },
    { hono_sha: otherSha },
    { hono_pin: `21:4:${digest}` },
    { hono_serving_version: kit },
    { hono_tag: `${otherSha}-99-1` },
    { hono_annotation: undoMessage(undoDigest) },
    { hono_annotation: "" },
    { candidate_sha: "private-note-that-must-not-appear" },
  ];
  const packet = evidencePacket(readbackFields);
  const rejected = [
    ...otherEvidence.map((changes) => evidencePacket({ ...readbackFields, ...changes })),
    ...Object.keys(readbackFields).map((absent) =>
      evidencePacket(
        Object.fromEntries(Object.entries(readbackFields).filter(([key]) => key !== absent)),
      ),
    ),
    packet.replace(readbackSection, "## Historical candidate"),
    `${packet}\n${packet}`,
  ];
  for (const input of rejected) assertReadbackRejected(input);
});

test("offline Ember readback ignores archived readbacks in Markdown fences", () => {
  const previous = evidencePacket({
    ...readbackFields,
    candidate_pin: `20:1:${digest}`,
    hono_pin: `20:1:${digest}`,
  });
  const current = evidencePacket(readbackFields);
  for (const fence of ["````", "~~~"]) {
    const archive = `${fence}markdown\n${fence}example\n<!--\n${previous}\n${fence}\n`;
    assertReadbackRejected(archive);
    const result = offlineReadback(`${archive}\n${current}`);
    assert.equal(result.status, 0, result.error?.message || result.stderr);
    assert.equal(JSON.parse(result.stdout).qualificationPin, qualificationPin);
  }
});

test("offline Ember readback ignores commented headings and fence markers", () => {
  const comment = "<!-- Example fence\n```text\n-->\n";
  const current = evidencePacket(readbackFields);
  const result = offlineReadback(`${comment}\n${current}`);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(JSON.parse(result.stdout).qualificationPin, qualificationPin);
  assertReadbackRejected(`${comment}\n${current}\n${current}`);
  assertReadbackRejected(`<!-- Archived evidence\n${current}\n-->`);
});

test("offline Ember readback enforces the byte limit and UTF-8 decoding", () => {
  const packet = Buffer.from(`${evidencePacket(readbackFields)}\n`);
  const atLimit = Buffer.concat([packet, Buffer.alloc(512 * 1024 - packet.length, 32)]);
  const result = offlineReadback(atLimit);
  assert.equal(result.status, 0, result.error?.message || result.stderr);
  assert.equal(JSON.parse(result.stdout).qualificationPin, qualificationPin);
  assertReadbackRejected(Buffer.concat([atLimit, Buffer.from(" ")]));
  assertReadbackRejected(Buffer.concat([packet, Buffer.from([0xff])]));
  assertReadbackRejected("");
});

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
  const ember = { ...active, CUTOVER_MODE: "ember" };
  assert.deepEqual(selection(ember), { mode: "ember", undo: hono, ...identity });
  const admin = { ...active, CUTOVER_MODE: "admin", CUTOVER_UNDO_VERSION: kit };
  assert.throws(() => selection(admin), /undo digest/);
  const selected = selection({ ...admin, CUTOVER_UNDO_DIGEST: undoDigest });
  assert.deepEqual(selected, { ...identity, mode: "admin", undo: kit, undoDigest });
  const prepare = selection({ ...active, CUTOVER_MODE: "hono", CUTOVER_UNDO_VERSION: "" });
  assert.deepEqual(prepare, { ...identity, mode: "hono", undo: "" });
  for (const change of [
    { CUTOVER_MODE: "" },
    { CUTOVER_MODE: "hono" },
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

test("admin rollback admits only the recorded production Ember version with admin off", () => {
  const pin = { undo: kit, undoDigest };
  const text = (name, value) => ({ name, text: value, type: "plain_text" });
  const bindings = [
    text("APP_URL", "https://togetherweown.com"),
    text("KIT_ROUTE_EMBER_PAGES", "true"),
  ];
  const version = { ...emberUndoVersion, resources: { bindings } };
  const withBindings = (bindings) => ({ ...version, resources: { bindings } });
  verifyEmberUndoVersion(version, pin, sourceSha);
  verifyEmberUndoVersion(
    withBindings([...bindings, text("KIT_ROUTE_ADMIN", "false")]),
    pin,
    sourceSha,
  );
  for (const required of bindings) {
    assert.throws(
      () => verifyEmberUndoVersion(withBindings([...bindings, { ...required }]), pin, sourceSha),
      assert.AssertionError,
      `must reject duplicate ${required.name} bindings even when their values agree`,
    );
    const wrongType = bindings.map((binding) =>
      binding.name === required.name ? { ...binding, type: "json" } : binding,
    );
    assert.throws(
      () => verifyEmberUndoVersion(withBindings(wrongType), pin, sourceSha),
      assert.AssertionError,
      `must reject a non-plain-text ${required.name} binding even with the expected text`,
    );
  }
  for (const mismatch of [{ undo: hono }, { undoDigest: digest }]) {
    assert.throws(() => verifyEmberUndoVersion(version, { ...pin, ...mismatch }, sourceSha));
  }
  assert.throws(() => verifyEmberUndoVersion(version, pin, "c".repeat(40)));
  for (const rejected of [
    bindings.slice(0, 1),
    [...bindings, text("KIT_ROUTE_ADMIN", "true")],
    [...bindings, { name: "KIT_ROUTE_ADMIN", type: "secret_text" }],
    [...bindings, text("APP_URL", "https://other.example")],
  ]) {
    assert.throws(() => verifyEmberUndoVersion(withBindings(rejected), pin, sourceSha));
  }
});

test("operator denial checks survive unused body cancellation failure", async (t) => {
  const origin = "https://operator-probe.example";
  const denialHeaders = {
    "x-two-renderer": "kit",
    "referrer-policy": "no-referrer",
    "cache-control": "private, no-store",
  };
  const challenge = { "www-authenticate": "Bearer" };
  const headerRefusal = { code: "ERR_ASSERTION" };
  const statusRefusal = { ...headerRefusal, message: "operator route admits anonymous traffic" };
  for (const [name, status, overrides, refusal] of [
    ["accepts a 401 with a Bearer challenge", 401, challenge],
    ["accepts a 404 without a challenge", 404, {}],
    ["refuses a success", 200, {}, statusRefusal],
    ["refuses a redirect", 302, {}, statusRefusal],
    ["refuses a different renderer", 404, { "x-two-renderer": "hono" }, headerRefusal],
    ["refuses a different referrer policy", 404, { "referrer-policy": "origin" }, headerRefusal],
    ["refuses a cacheable response", 404, { "cache-control": "public" }, headerRefusal],
    ["refuses a cookie", 404, { "set-cookie": "fixture=value" }, headerRefusal],
    ["refuses a 401 without a Bearer challenge", 401, {}, headerRefusal],
  ]) {
    await t.test(name, async (subtest) => {
      const cancel = subtest.mock.fn(async () => {
        throw new Error("synthetic cancellation detail");
      });
      const warn = subtest.mock.method(console, "warn", () => {});
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { ...denialHeaders, ...overrides },
      });
      const verify = () =>
        verifyOperatorDenial(origin, async (url, options) => {
          assert.equal(url.href, `${origin}/admin/ops-overrides`);
          assert.equal(options.redirect, "manual");
          assert.ok(options.signal instanceof AbortSignal);
          return response;
        });

      if (refusal) await assert.rejects(verify, refusal);
      else await verify();
      assert.equal(cancel.mock.callCount(), 1);
      assert.deepEqual(
        warn.mock.calls.map(({ arguments: args }) => args),
        [["Could not cancel the unused operator denial response body"]],
      );
    });
  }
});

test("cutover producer requires the exact main attempt and its successful proof upload", async (t) => {
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
  const workflow = parse(readFileSync(new URL("../" + run.path, import.meta.url), "utf8"));
  const upload = workflow.jobs["isolated-cutover"].steps.find((step) =>
    step.uses?.startsWith("actions/upload-artifact@"),
  );
  assert.equal(upload.name, proofUpload.name);
  assert.equal(upload.with.name, "kit-cutover-proof-${{ github.run_attempt }}");
  assert.equal(upload.with["if-no-files-found"], "error");
  const job = completedCutoverJob(identity);
  const check = (attempt = run, isolated = job) =>
    verifyProducer(identity, "synthetic", async (url) => {
      const parsed = new URL(url);
      const path = parsed.pathname;
      if (path.endsWith("/runs/21/attempts/3")) return Response.json(attempt);
      assert.ok(path.endsWith("/runs/21/attempts/3/jobs"));
      assert.equal(parsed.search, "?per_page=100&page=1");
      return Response.json({ total_count: 1, jobs: [isolated] });
    });
  assert.equal((await check()).runAttempt, "3");
  await assert.rejects(check({ ...run, run_attempt: 2 }), /attempt metadata/);
  await assert.rejects(check({ ...run, conclusion: "failure" }), /attempt metadata/);
  for (const event of ["push", "pull_request"]) {
    await assert.rejects(check({ ...run, event }), /attempt metadata/);
  }
  for (const changes of [
    { steps: [] },
    { steps: [{ ...proofUpload, conclusion: "failure" }] },
    { steps: [{ ...proofUpload, conclusion: "skipped" }] },
    { conclusion: "skipped", steps: [] },
    { run_attempt: 2 },
  ]) {
    await assert.rejects(check(run, { ...job, ...changes }), /proof upload did not succeed/);
  }
  const mismatches = {
    "wrong source SHA": { head_sha: "d".repeat(40) },
    "wrong source branch": { head_branch: "release" },
    "different workflow": { path: ".github/workflows/archive-hono-recovery.yml" },
    "XFS workflow on another ref": { path: run.path + "@release" },
    "push event": { event: "push" },
    "pull request event": { event: "pull_request" },
    "foreign run repository": { repository: { ...own, full_name: "Elsewhere/repo" } },
    "forked head repository": { head_repository: { ...own, fork: true } },
    "different head repository ID": { head_repository: { ...own, id: 24 } },
    "unfinished run": { status: "in_progress" },
    "cancelled run": { conclusion: "cancelled" },
  };
  for (const [label, mismatch] of Object.entries(mismatches)) {
    await t.test("refuses " + label, async () => {
      await assert.rejects(
        verifyProducer(identity, "synthetic", async () => Response.json({ ...run, ...mismatch })),
        { message: "pure Hono recovery run refused: inconsistent GitHub attempt metadata" },
      );
    });
  }
});
test("a newer main tip and a newer staging allocation have different effects on cutover evidence", async () => {
  const successor = "d".repeat(40);
  const repository = preRollback.head_repository.full_name;
  const context = { repository, ref: "refs/heads/main", sha: successor };
  const ciRun = {
    ...preRollback,
    event: "push",
    path: ".github/workflows/ci.yml",
  };
  const trigger = { repository: { full_name: repository }, workflow_run: ciRun };
  assert.equal(
    deploymentTarget({
      ...context,
      eventName: "workflow_run",
      event: trigger,
      checkoutSha: sourceSha,
    }),
    sourceSha,
  );
  const deployRun = { ...ciRun, head_sha: successor, display_title: `deploy ${sourceSha}` };
  assert.equal(
    resolveStagingCandidate({
      ...context,
      eventName: "workflow_run",
      event: { workflow_run: deployRun },
    }),
    sourceSha,
  );
  assert.equal(resolveStagingCandidate({ ...context, eventName: "workflow_dispatch" }), successor);

  const own = { full_name: "TogetherWeOwn/two-web-next", fork: false, id: 23 };
  const successorPin = { ...identity, sourceSha: successor, runId: "22" };
  const readIsolatedRun = async (input) => {
    const { pathname, search } = new URL(input);
    const path = pathname.replace(/\/jobs$/, "");
    const pin = [identity, successorPin].find(
      ({ runId, runAttempt }) =>
        path === `/repos/${own.full_name}/actions/runs/${runId}/attempts/${runAttempt}`,
    );
    assert.ok(pin);
    if (pathname !== path) {
      assert.equal(search, "?per_page=100&page=1");
      return Response.json({ total_count: 1, jobs: [completedCutoverJob(pin)] });
    }
    return Response.json({
      id: Number(pin.runId),
      run_attempt: Number(pin.runAttempt),
      repository: own,
      head_repository: own,
      head_sha: pin.sourceSha,
      head_branch: "main",
      path: ".github/workflows/xfs-qualification.yml",
      event: "workflow_dispatch",
      status: "completed",
      conclusion: "success",
    });
  };
  await verifyProducer(successorPin, "synthetic", readIsolatedRun);
  await assert.rejects(
    verifyProducer({ ...successorPin, sourceSha }, "synthetic", readIsolatedRun),
    /attempt metadata/,
  );
  await verifyProducer(identity, "synthetic", readIsolatedRun);
  const isolatedHono = "77777777-7777-7777-7777-777777777777";
  const proof = {
    identity,
    schema: 1,
    worker: `two-web-kit-cutover-proof-${identity.runId}-${identity.runAttempt}`,
    hono: isolatedHono,
    kit,
    configs: { hono: digest, kit: digest },
    routeCount: 1,
    bindingCheck: "isolated-and-all-off",
    kitReadinessSamples: 6,
    checks: ["1033", "1037"].flatMap((state) =>
      ["hono", "kit", "undo"].map((step) => ({
        state,
        step,
        version: step === "kit" ? kit : isolatedHono,
        status: 200,
        pending: 0,
        smoke: "passed",
      })),
    ),
  };
  verifyStagingProof(proof, identity);
  assert.throws(() => verifyStagingProof(proof, { ...identity, sourceSha: successor }), /identity/);

  const run = { ...preRollback, id: 103, head_sha: successor };
  const floor = Date.parse(run.updated_at) + 30 * 60 * 1000;
  const sharedVersion = first.versions[0].version_id;
  const env = soakEnv({ accountId: "c".repeat(32), token: "synthetic-cloudflare-token" });
  let analyticsReads = 0;
  const fetchImpl = async (input, init) => {
    const url = String(input);
    if (url === `${STAGING_ORIGIN}/version`) {
      return Response.json({ sha: sourceSha, deployedAt: "2026-01-01T10:00:00.000Z" });
    }
    if (url === `${STAGING_ORIGIN}/up`) {
      return Response.json(
        { revision: { commit: sourceSha, version_id: sharedVersion } },
        { headers: { "x-two-origin": "two-web-next", "cache-control": "no-store" } },
      );
    }
    assert.equal(url, "https://api.cloudflare.com/client/v4/graphql");
    const { versionId, since, until } = JSON.parse(init.body).variables;
    assert.equal(versionId, sharedVersion);
    assert.equal(since, run.run_started_at);
    assert.equal(Date.parse(until), floor);
    analyticsReads += 1;
    const sample = {
      dimensions: { scriptVersion: sharedVersion },
      sum: { requests: 250, errors: 0 },
    };
    return Response.json({
      data: { viewer: { accounts: [{ workersInvocationsAdaptive: [sample] }] } },
    });
  };
  const sample = (nowMs, allocations) =>
    verifyAllocationSoak(env, {
      now: () => nowMs,
      fetchImpl: trustedReads({ fetchImpl }, { run, deployments: () => allocations }),
    });

  // A successor takes 100% after A's E2E passes and one second before A's floor.
  const replacement = {
    id: "66666666-6666-6666-6666-666666666666",
    created_on: new Date(floor - 1000).toISOString(),
    versions: [{ version_id: "88888888-8888-8888-8888-888888888888", percentage: 100 }],
  };
  await assert.rejects(sample(floor, [first, replacement]), /fresh E2E is required/);
  await assert.rejects(sample(floor - 1, [first]), /has not soaked 30 minutes/);
  assert.equal(analyticsReads, 0);

  // The same executed E2E and isolated proof pair if only main advances.
  const receipt = await sample(floor, [first]);
  assert.equal(receipt.sha, proof.identity.sourceSha);
  assert.equal(receipt.allocationId, first.id);
  assert.equal(receipt.e2e.runId, run.id);
  assert.deepEqual([receipt.sample.requests, receipt.sample.errors], [250, 0]);
  assert.equal(analyticsReads, 1);
});

test("only undo preparation may admit confirmed deferred migrations", () => {
  const prefixes = { 1033: [1], 1037: [1, 2, 3, 4, 5] };
  const body = { db: "ok", pending_migrations: 1, migration_ledger: prefixes[1037] };
  assert.equal(verifyReady(503, body, prefixes, { allowDeferred: true }), "1037");
  assert.throws(() => verifyReady(503, body, prefixes), /readiness/);
  assert.throws(
    () => verifyReady(503, { ...body, pending_migrations: 2 }, prefixes, { allowDeferred: true }),
    /deferred/,
  );
});

test("ordinary promotion requires the full ledger for an Ember undo version", async (t) => {
  const version = { annotations: { "workers/message": `two-web-cutover-kit:${digest}` } };
  await assert.rejects(
    verifyOrdinaryLedger(version, async () => []),
    /full ledger/,
  );

  const { entries } = JSON.parse(
    readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
  );
  const ledger = entries.map(({ when }) => when);
  await assert.rejects(
    verifyOrdinaryLedger(emberUndoVersion, async () => ledger.slice(0, -1)),
    /full ledger/,
  );
  const readLedger = t.mock.fn(async () => ledger);
  await verifyOrdinaryLedger(emberUndoVersion, readLedger);
  assert.equal(readLedger.mock.callCount(), 1);

  await verifyOrdinaryLedger({}, () => assert.fail("ordinary rollback target must not probe"));
});

test("Ember upload validates the deployment attempt before writing the package config", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "ember-upload-attempt-"));
  t.after(() => rm(scratch, { recursive: true, force: true }));
  const directory = join(scratch, "kit");
  const configPath = join(directory, "wrangler.json");
  const env = {
    GITHUB_RUN_ID: "99",
    GITHUB_RUN_ATTEMPT: "2",
    GITHUB_OUTPUT: join(scratch, "step-output"),
    WRANGLER_OUTPUT_FILE_PATH: join(scratch, "upload-receipt"),
  };
  const pin = { ...identity, mode: "ember" };
  const inputs = {
    root: { env: { production: {} } },
    kit: { name: "fixture-worker", vars: { KIT_ROUTE_EMBER_PAGES: "false" } },
  };
  const upload = t.mock.fn(() => kit);
  await mkdir(directory);
  await writeFile(env.GITHUB_OUTPUT, "mode=ember\n");
  for (const invalid of [
    { GITHUB_RUN_ID: undefined },
    { GITHUB_RUN_ATTEMPT: undefined },
    { GITHUB_RUN_ID: "9e1" },
    { GITHUB_RUN_ATTEMPT: "02" },
  ]) {
    await assert.rejects(
      uploadCutover(scratch, "kit", pin, inputs, { ...env, ...invalid }, upload),
      /invalid deployment attempt/,
    );
    assert.deepEqual(await readdir(directory), []);
    assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), "mode=ember\n");
    await assert.rejects(readFile(env.WRANGLER_OUTPUT_FILE_PATH), { code: "ENOENT" });
    assert.equal(upload.mock.callCount(), 0);
  }

  assert.equal(await uploadCutover(scratch, "kit", pin, inputs, env, upload), kit);
  const config = productionUploadConfig("kit", inputs, "ember");
  assert.equal(await readFile(configPath, "utf8"), JSON.stringify(config));
  assert.equal(upload.mock.callCount(), 1);
  assert.deepEqual(upload.mock.calls[0].arguments, [
    "kit",
    directory,
    config,
    `${sourceSha}-99-2`,
    { message: `two-web-cutover-kit:${digest}`, output: env.WRANGLER_OUTPUT_FILE_PATH },
  ]);
  assert.equal(await readFile(env.GITHUB_OUTPUT, "utf8"), `mode=ember\nversion_id=${kit}\n`);
});
