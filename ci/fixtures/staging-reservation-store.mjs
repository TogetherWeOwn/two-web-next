import assert from "node:assert/strict";
import { test } from "node:test";
import { createStagingReservationStore } from "../staging-reservation-store.mjs";

const lease = {
  sha: "a".repeat(40),
  allocationId: "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa",
  ownerId: 101,
  issuedAt: "2026-11-01T10:00:00Z",
  expiresAt: "2026-11-01T11:00:00Z",
};
const renewed = {
  ...lease,
  issuedAt: lease.expiresAt,
  expiresAt: "2026-11-01T12:00:00Z",
};

// Match the reservation parser's return shape. The guard tests the full grammar.
function parseLease(record) {
  assert.ok(record && typeof record === "object", "invalid synthetic lease");
  const { sha, allocationId, ownerId, issuedAt, expiresAt } = record;
  const issuedAtMs = Date.parse(issuedAt);
  const expiresAtMs = Date.parse(expiresAt);
  assert.ok(Number.isFinite(issuedAtMs) && expiresAtMs > issuedAtMs, "invalid synthetic lifetime");
  return { sha, allocationId, ownerId, issuedAtMs, expiresAtMs };
}

function backingStore({ value = null, readError, commitError } = {}) {
  let tail = Promise.resolve();
  const mutations = [];
  return {
    mutations,
    transaction(callback) {
      const pending = tail.then(async () => {
        let next = value;
        const result = await callback({
          async read() {
            if (readError) throw readError;
            return value;
          },
          async write(json) {
            next = json;
          },
          async delete() {
            next = null;
          },
        });
        if (next !== value) {
          value = next;
          mutations.push(next);
          if (commitError) throw commitError;
        }
        return result;
      });
      tail = pending.catch(() => {});
      return pending;
    },
  };
}

const adapter = (store) => createStagingReservationStore({ store, parseLease });

test("staging reservation store admits one of two concurrent writers to an empty slot", async () => {
  const store = backingStore();
  const first = adapter(store);
  const second = adapter(store);
  const other = { ...lease, ownerId: 102 };
  assert.deepEqual(await Promise.all([first.readLease(), second.readLease()]), [null, null]);
  const results = await Promise.all([
    first.compareAndSwapLease(null, lease),
    second.compareAndSwapLease(null, other),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? lease : other;
  assert.deepEqual(await second.readLease(), winner);
  assert.deepEqual(store.mutations, [JSON.stringify(winner)]);
});

test("staging reservation store preserves a same-owner renewal during stale cleanup", async () => {
  const store = backingStore({ value: JSON.stringify(lease) });
  const writer = adapter(store);
  const cleanup = adapter(store);
  const stale = await cleanup.readLease();
  assert.equal(await writer.compareAndSwapLease(lease, renewed), true);
  assert.equal(await cleanup.compareAndSwapLease(stale, null), false);
  assert.deepEqual(await cleanup.readLease(), renewed);
  assert.deepEqual(store.mutations, [JSON.stringify(renewed)]);
  assert.equal(await cleanup.compareAndSwapLease(renewed, null), true);
  assert.equal(await writer.readLease(), null);
  assert.equal(await cleanup.compareAndSwapLease(renewed, null), false);
  assert.deepEqual(store.mutations, [JSON.stringify(renewed), null]);
});

test("staging reservation store compares every lease field before mutation", async () => {
  const store = backingStore({ value: JSON.stringify(lease) });
  const reservations = adapter(store);
  const differences = {
    sha: "b".repeat(40),
    allocationId: "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb",
    ownerId: 102,
    issuedAt: "2026-11-01T10:01:00Z",
    expiresAt: "2026-11-01T10:59:00Z",
  };
  for (const [field, value] of Object.entries(differences)) {
    const stale = { ...lease, [field]: value };
    assert.equal(await reservations.compareAndSwapLease(stale, renewed), false, field);
    assert.equal(await reservations.compareAndSwapLease(stale, null), false, field);
  }
  assert.deepEqual(store.mutations, []);
  const sameInstant = { ...lease, issuedAt: "2026-11-01T10:00:00.000Z" };
  assert.equal(await reservations.compareAndSwapLease(sameInstant, renewed), true);
});

test("staging reservation store refuses failed and corrupt reads", async () => {
  const readError = new Error("synthetic read failure");
  const unavailable = backingStore({ readError });
  await assert.rejects(adapter(unavailable).readLease(), readError);
  await assert.rejects(adapter(unavailable).compareAndSwapLease(null, lease), readError);
  assert.deepEqual(unavailable.mutations, []);

  for (const value of [false, "{", "null", "x".repeat(257)]) {
    const corrupt = backingStore({ value });
    await assert.rejects(adapter(corrupt).readLease(), /invalid/i);
    await assert.rejects(adapter(corrupt).compareAndSwapLease(null, lease), /invalid/i);
    assert.deepEqual(corrupt.mutations, []);
  }
});

test("staging reservation store propagates an uncertain commit and supports readback", async () => {
  const commitError = new Error("synthetic lost commit acknowledgement");
  const store = backingStore({ commitError });
  const reservations = adapter(store);
  await assert.rejects(reservations.compareAndSwapLease(null, lease), commitError);
  assert.deepEqual(await reservations.readLease(), lease);
  assert.equal(await reservations.compareAndSwapLease(null, renewed), false);
  assert.deepEqual(store.mutations, [JSON.stringify(lease)]);
});
