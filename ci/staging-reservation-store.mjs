import { isDeepStrictEqual } from "node:util";

// A compact JSON record with all five reservation fields fits within this bound.
const MAX_RECORD_LENGTH = 256;

/**
 * Persist one staging reservation. Inject the reservation guard's parser, which
 * validates the five fields and returns the full lease identity (including both
 * timestamps in milliseconds).
 *
 * store.transaction(callback) must serialize access to the same dedicated slot
 * across all writers and resolve only after commit. Its callback receives
 * read(), write(json) and delete(). read() returns JSON or null after verifying
 * absence. Failed reads and uncertain commits must reject. Every writer must
 * use the same transaction boundary.
 *
 * Authorization, expiry and staging admission belong to the caller. Issuance
 * must not reuse a lease identity, even when the previous record is absent.
 */
export function createStagingReservationStore({ store, parseLease }) {
  async function readRecord(tx) {
    const value = await tx.read();
    if (value === null) return null;
    if (typeof value !== "string" || value.length > MAX_RECORD_LENGTH) {
      throw new Error("Invalid stored staging reservation");
    }
    let record;
    try {
      record = JSON.parse(value);
    } catch {
      throw new Error("Invalid stored staging reservation JSON");
    }
    return { record, identity: parseLease(record) };
  }

  return {
    readLease() {
      return store.transaction(async (tx) => {
        const current = await readRecord(tx);
        return current === null ? null : current.record;
      });
    },

    // Match all five identity fields as the lifecycle does, including the
    // instants represented by both timestamps. null expects an empty slot or
    // requests deletion. false means a conflict without a mutation attempt.
    async compareAndSwapLease(expected, replacement) {
      const expectedIdentity = expected === null ? null : parseLease(expected);
      let value = null;
      if (replacement !== null) {
        parseLease(replacement);
        value = JSON.stringify(replacement);
        if (value.length > MAX_RECORD_LENGTH) throw new Error("Staging reservation is too large");
      }
      return store.transaction(async (tx) => {
        const current = await readRecord(tx);
        const currentIdentity = current === null ? null : current.identity;
        if (!isDeepStrictEqual(currentIdentity, expectedIdentity)) return false;
        if (value !== null) await tx.write(value);
        else if (current !== null) await tx.delete();
        return true;
      });
    },
  };
}
