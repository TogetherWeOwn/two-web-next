import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { verifyOrdinaryLedger } from "./check-production-secrets.mjs";
import { verifyReady } from "./kit-cutover-evidence.mjs";
import {
  selection,
  undoMessage,
  verifyEmberUndoVersion,
  verifyProducer,
  verifyUndoVersion,
} from "./kit-cutover-deploy.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const undoDigest = "c".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };
const emberUndoVersion = {
  id: kit,
  annotations: {
    "workers/tag": `${sourceSha}-99-1`,
    "workers/message": `two-web-cutover-kit:${undoDigest}`,
  },
};

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

test("only exact successful main XFS dispatch metadata can produce a cutover packet", async (t) => {
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
  assert.equal(
    (await verifyProducer(identity, "synthetic", async () => Response.json(run))).runAttempt,
    "3",
  );
  await assert.rejects(
    verifyProducer(identity, "synthetic", async () => Response.json({ ...run, run_attempt: 2 })),
    /attempt metadata/,
  );

  const mismatches = {
    "wrong source SHA": { head_sha: "d".repeat(40) },
    "wrong source branch": { head_branch: "release" },
    "different workflow": { path: ".github/workflows/archive-hono-recovery.yml" },
    "XFS workflow on another ref": { path: `${run.path}@release` },
    "push event": { event: "push" },
    "pull request event": { event: "pull_request" },
    "foreign run repository": { repository: { ...own, full_name: "Elsewhere/repo" } },
    "forked head repository": { head_repository: { ...own, fork: true } },
    "different head repository ID": { head_repository: { ...own, id: 24 } },
    "unfinished run": { status: "in_progress" },
    "cancelled run": { conclusion: "cancelled" },
  };

  for (const [label, mismatch] of Object.entries(mismatches)) {
    await t.test(`refuses ${label}`, async () => {
      await assert.rejects(
        verifyProducer(identity, "synthetic", async () => Response.json({ ...run, ...mismatch })),
        { message: "pure Hono recovery run refused: inconsistent GitHub attempt metadata" },
      );
    });
  }
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
