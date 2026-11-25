import assert from "node:assert/strict";
import { test } from "node:test";
import { acquireStagingReservation } from "../staging-reservation-acquisition.mjs";

const verified = {
  sha: "a".repeat(40),
  allocationId: "12345678-1234-4567-8abc-123456789abc",
  ownerId: 19,
};
const proposed = {
  ...verified,
  issuedAt: "2026-11-25T10:00:00Z",
  expiresAt: "2026-11-25T11:00:00Z",
};
const issuedAtMs = Date.parse(proposed.issuedAt);
const expiresAtMs = Date.parse(proposed.expiresAt);
const allocation = { sha: verified.sha, allocationId: verified.allocationId };

function fixture(request = { verified, proposed }) {
  const observations = [];
  const writes = [];
  let held = false;
  const adapters = {
    parseLease(record) {
      assert.deepEqual(record, proposed);
      return { ...verified, issuedAtMs, expiresAtMs };
    },
    async inMutationLane(callback) {
      assert.equal(held, false);
      held = true;
      try {
        return await callback();
      } finally {
        held = false;
      }
    },
    async observeAllocation() {
      assert.equal(held, true);
      observations.push(state.observed);
      return state.observed;
    },
    now() {
      assert.equal(held, true);
      return state.nowMs;
    },
    reservationStore: {
      async compareAndSwapLease(expected, replacement) {
        assert.equal(held, true);
        assert.equal(observations.length, 1);
        assert.equal(expected, null);
        if (state.current !== null) return false;
        state.current = replacement;
        writes.push(replacement);
        return true;
      },
    },
  };
  const state = {
    observed: allocation,
    nowMs: issuedAtMs,
    current: null,
    observations,
    writes,
    adapters,
    acquire: () => acquireStagingReservation(request, adapters),
  };
  return state;
}

test("staging acquisition commits the verified lease from inside the mutation lane", async () => {
  const state = fixture();
  assert.equal(await state.acquire(), "acquired");
  assert.deepEqual(state.writes, [proposed]);
  assert.deepEqual(state.current, proposed);
});

test("staging acquisition refuses a changed allocation even when the staged SHA is unchanged", async () => {
  const state = fixture();
  const enter = state.adapters.inMutationLane;
  state.adapters.inMutationLane = (callback) => {
    // A queued deployment takes the lane first and redeploys the same revision.
    state.observed = { ...allocation, allocationId: "12345678-1234-4567-8abc-123456789abd" };
    return enter(callback);
  };
  assert.equal(await state.acquire(), "staging-allocation-changed");
  assert.deepEqual(state.observations, [state.observed]);
  assert.deepEqual(state.writes, []);
});

test("staging acquisition rejects unverified proposal fields and a missing or wrong staged identity", async () => {
  for (const fields of [{ sha: "b".repeat(40) }, { allocationId: "different" }, { ownerId: 20 }]) {
    const state = fixture({ proposed, verified: { ...verified, ...fields } });
    assert.equal(await state.acquire(), "unverified-lease");
    assert.deepEqual(state.observations, []);
    assert.deepEqual(state.writes, []);
  }
  for (const observation of [null, { ...allocation, sha: "b".repeat(40) }]) {
    const state = fixture();
    state.observed = observation;
    assert.equal(await state.acquire(), "staging-allocation-changed");
    assert.deepEqual(state.writes, []);
  }
});

test("staging acquisition checks activity after observation and preserves an occupied slot", async () => {
  const early = fixture();
  early.nowMs = issuedAtMs - 1;
  assert.equal(await early.acquire(), "lease-inactive");
  assert.deepEqual(early.writes, []);

  const expired = fixture();
  const observe = expired.adapters.observeAllocation;
  expired.adapters.observeAllocation = async () => {
    expired.nowMs = expiresAtMs;
    return observe();
  };
  assert.equal(await expired.acquire(), "lease-inactive");
  assert.deepEqual(expired.writes, []);

  const state = fixture();
  const previous = { ...proposed, issuedAt: "2026-11-25T09:00:00Z", expiresAt: proposed.issuedAt };
  state.current = previous;
  assert.equal(await state.acquire(), "lease-conflict");
  assert.equal(state.current, previous);
  assert.deepEqual(state.writes, []);
});

test("staging acquisition propagates observation and ambiguous commit failures", async () => {
  const state = fixture();
  const error = new Error("synthetic failure");
  const observe = state.adapters.observeAllocation;
  state.adapters.observeAllocation = async () => {
    throw error;
  };
  await assert.rejects(state.acquire(), (failure) => failure === error);
  assert.deepEqual(state.writes, []);

  state.adapters.observeAllocation = observe;
  const compareAndSwap = state.adapters.reservationStore.compareAndSwapLease;
  state.adapters.reservationStore.compareAndSwapLease = async (...args) => {
    await compareAndSwap(...args);
    throw error;
  };
  await assert.rejects(state.acquire(), (failure) => failure === error);
  assert.deepEqual(state.writes, [proposed]);
  assert.deepEqual(state.current, proposed);
});
