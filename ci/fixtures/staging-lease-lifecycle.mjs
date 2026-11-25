import assert from "node:assert/strict";
import { test } from "node:test";
import { createStagingLeaseLifecycle } from "../staging-lease-lifecycle.mjs";

const previous = Object.freeze({
  sha: "a".repeat(40),
  allocationId: "11111111-1111-4111-8111-111111111111",
  ownerId: 101,
  issuedAt: "2026-11-01T10:00:00.000Z",
  expiresAt: "2026-11-01T10:30:00.000Z",
});
const renewal = Object.freeze({
  ...previous,
  issuedAt: previous.expiresAt,
  expiresAt: "2026-11-01T11:00:00.000Z",
});
const expiry = Date.parse(previous.expiresAt);

function fixture({ nowMs = expiry, readError, writeError, deleteError } = {}) {
  let lease = structuredClone(previous);
  let queue = Promise.resolve();
  let inLane = false;
  const mutations = [];
  const lifecycle = createStagingLeaseLifecycle({
    inMutationLane(change) {
      const run = queue.then(async () => {
        inLane = true;
        try {
          return await change();
        } finally {
          inLane = false;
        }
      });
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
    async readLease() {
      assert.equal(inLane, true);
      if (readError) throw readError;
      return structuredClone(lease);
    },
    async writeLease(record) {
      await Promise.resolve();
      assert.equal(inLane, true);
      mutations.push("write");
      lease = structuredClone(record);
      if (writeError) throw writeError;
    },
    async deleteLease() {
      await Promise.resolve();
      assert.equal(inLane, true);
      mutations.push("delete");
      lease = null;
      if (deleteError) throw deleteError;
    },
    // Stub only the parsed identity and times that the lifecycle consumes.
    parseLease({ sha, allocationId, ownerId, issuedAt, expiresAt }) {
      return {
        sha,
        allocationId,
        ownerId,
        issuedAtMs: Date.parse(issuedAt),
        expiresAtMs: Date.parse(expiresAt),
      };
    },
    now: () => nowMs,
  });
  return { lifecycle, mutations, readState: () => structuredClone(lease) };
}

test("staging lease replacement survives queued release and cleanup from the previous owner", async () => {
  const { lifecycle, mutations, readState } = fixture();
  const replacement = { ...renewal, ownerId: 102 };
  const results = await Promise.all([
    lifecycle.replaceExpired(previous, replacement),
    lifecycle.release(previous),
    lifecycle.cleanupExpired(previous),
  ]);

  assert.deepEqual(results, ["replaced", "different-lease", "different-lease"]);
  assert.deepEqual(mutations, ["write"]);
  assert.deepEqual(readState(), replacement);
});

test("staging lease release and cleanup distinguish a renewal by the same owner", async () => {
  const { lifecycle, mutations, readState } = fixture();
  assert.equal(await lifecycle.replaceExpired(previous, renewal), "replaced");
  assert.equal(await lifecycle.release(previous), "different-lease");
  assert.equal(await lifecycle.cleanupExpired(previous), "different-lease");
  assert.deepEqual(readState(), renewal);
  assert.equal(await lifecycle.release(renewal), "released");
  assert.equal(await lifecycle.release(renewal), "absent");
  assert.deepEqual(mutations, ["write", "delete"]);
  assert.equal(readState(), null);
});

test("staging lease cleanup is idempotent at expiry", async () => {
  const { lifecycle, mutations, readState } = fixture();
  const results = await Promise.all([
    lifecycle.cleanupExpired(previous),
    lifecycle.cleanupExpired(previous),
  ]);

  assert.deepEqual(results, ["released", "absent"]);
  assert.deepEqual(mutations, ["delete"]);
  assert.equal(readState(), null);
});

test("staging lease retirement compares every identity field", async () => {
  const { lifecycle, mutations, readState } = fixture();
  const differences = {
    ownerId: 102,
    sha: "b".repeat(40),
    allocationId: "22222222-2222-4222-8222-222222222222",
    issuedAt: "2026-11-01T10:00:00.001Z",
    expiresAt: "2026-11-01T10:29:59.999Z",
  };
  for (const [field, value] of Object.entries(differences)) {
    const stale = { ...previous, [field]: value };
    assert.equal(await lifecycle.release(stale), "different-lease", `release checks ${field}`);
    assert.equal(
      await lifecycle.cleanupExpired(stale),
      "different-lease",
      `cleanup checks ${field}`,
    );
  }
  assert.deepEqual(mutations, []);
  assert.deepEqual(readState(), previous);
});

test("staging lease retries recognize mutations after lost acknowledgements", async () => {
  const writeError = new Error("synthetic write acknowledgement lost");
  const deleteError = new Error("synthetic delete acknowledgement lost");
  const { lifecycle, mutations, readState } = fixture({ writeError, deleteError });
  await assert.rejects(lifecycle.replaceExpired(previous, renewal), writeError);
  assert.equal(await lifecycle.replaceExpired(previous, renewal), "already-replaced");
  assert.deepEqual(readState(), renewal);

  await assert.rejects(lifecycle.release(renewal), deleteError);
  assert.equal(await lifecycle.release(renewal), "absent");
  assert.deepEqual(mutations, ["write", "delete"]);
  assert.equal(readState(), null);
});

test("staging lease expiry is required for replacement or cleanup", async () => {
  const { lifecycle, mutations, readState } = fixture({ nowMs: expiry - 1 });
  const active = { ...renewal, issuedAt: "2026-11-01T10:29:00.000Z" };
  assert.equal(await lifecycle.replaceExpired(previous, active), "not-expired");
  assert.equal(await lifecycle.cleanupExpired(previous), "not-expired");
  assert.deepEqual(mutations, []);
  assert.deepEqual(readState(), previous);
});

test("staging lease replacement must be active at the write decision", async () => {
  const { lifecycle, mutations, readState } = fixture();
  const future = { ...renewal, issuedAt: "2026-11-01T10:30:00.001Z" };
  assert.equal(await lifecycle.replaceExpired(previous, future), "replacement-inactive");
  assert.equal(await lifecycle.replaceExpired(previous, previous), "replacement-inactive");
  assert.deepEqual(mutations, []);
  assert.deepEqual(readState(), previous);
});

test("staging lease replacement refuses a still-active record issued before the prior expiry", async () => {
  const { lifecycle, mutations, readState } = fixture();
  const reused = { ...renewal, issuedAt: previous.issuedAt };
  assert.equal(
    await lifecycle.replaceExpired(previous, reused),
    "replacement-issued-before-expiry",
  );
  assert.deepEqual(mutations, []);
  assert.deepEqual(readState(), previous);
});

test("staging lease read failure prevents any mutation", async () => {
  const readError = new Error("synthetic state read failed");
  const { lifecycle, mutations, readState } = fixture({ readError });
  await assert.rejects(lifecycle.release(previous), readError);
  await assert.rejects(lifecycle.cleanupExpired(previous), readError);
  await assert.rejects(lifecycle.replaceExpired(previous, renewal), readError);
  assert.deepEqual(mutations, []);
  assert.deepEqual(readState(), previous);
});
