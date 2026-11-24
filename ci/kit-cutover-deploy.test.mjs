import assert from "node:assert/strict";
import test from "node:test";
import { verifyOrdinaryLedger } from "./check-production-secrets.mjs";
import { verifyReady } from "./kit-cutover-evidence.mjs";
import {
  selection,
  undoMessage,
  verifyProducer,
  verifyUndoVersion,
} from "./kit-cutover-deploy.mjs";

const sourceSha = "a".repeat(40);
const digest = "b".repeat(64);
const hono = "11111111-1111-1111-1111-111111111111";
const kit = "22222222-2222-2222-2222-222222222222";
const identity = { sourceSha, runId: "21", runAttempt: "3", digest };

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
  assert.equal(
    selection({ ...active, CUTOVER_MODE: "hono", CUTOVER_UNDO_VERSION: "" }).mode,
    "hono",
  );
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
  assert.equal(
    (await verifyProducer(identity, "synthetic", async () => Response.json(run))).runAttempt,
    "3",
  );
  await assert.rejects(
    verifyProducer(identity, "synthetic", async () => Response.json({ ...run, run_attempt: 2 })),
    /attempt metadata/,
  );
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

test("ordinary promotion from cutover checks the live ledger even for equal journals", async () => {
  const version = { annotations: { "workers/message": `two-web-cutover-kit:${digest}` } };
  await assert.rejects(
    verifyOrdinaryLedger(version, async () => []),
    /full ledger/,
  );
  await verifyOrdinaryLedger({}, () => assert.fail("ordinary rollback target must not probe"));
});
