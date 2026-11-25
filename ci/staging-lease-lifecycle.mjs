function sameLease(a, b) {
  return (
    a.ownerId === b.ownerId &&
    a.sha === b.sha &&
    a.allocationId === b.allocationId &&
    a.issuedAtMs === b.issuedAtMs &&
    a.expiresAtMs === b.expiresAtMs
  );
}

/**
 * The caller authorizes each request and supplies the reservation parser, which
 * returns the lease identity with issuedAtMs and expiresAtMs. Give each new lease
 * a fresh issuedAt, even for the same owner and allocation, and retain the
 * original lease as the expected record for retry or retirement.
 * The lane adapter must exclude every staging mutation in `deploy-staging` for
 * the full async callback. Only a successful read of absent state returns null.
 */
export function createStagingLeaseLifecycle({
  inMutationLane,
  readLease,
  writeLease,
  deleteLease,
  parseLease,
  now,
}) {
  function withStoredLease(change) {
    return inMutationLane(async () => {
      const stored = await readLease();
      if (stored === null) return "absent";
      return change(parseLease(stored));
    });
  }

  function readClock() {
    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid staging lease clock");
    return nowMs;
  }

  function retire(record, expiredOnly) {
    const expected = parseLease(record);
    return withStoredLease(async (current) => {
      if (!sameLease(current, expected)) return "different-lease";
      if (expiredOnly && readClock() < current.expiresAtMs) return "not-expired";
      await deleteLease();
      return "released";
    });
  }

  return {
    async replaceExpired(expected, replacement) {
      const previous = parseLease(expected);
      const next = parseLease(replacement);
      const record = { ...replacement };
      return withStoredLease(async (current) => {
        const matchesPrevious = sameLease(current, previous);
        if (!matchesPrevious && !sameLease(current, next)) return "different-lease";
        const nowMs = readClock();
        if (nowMs < previous.expiresAtMs) return "not-expired";
        if (nowMs < next.issuedAtMs || nowMs >= next.expiresAtMs) return "replacement-inactive";
        if (!matchesPrevious) return "already-replaced";
        await writeLease(record);
        return "replaced";
      });
    },
    async release(expected) {
      return retire(expected, false);
    },
    async cleanupExpired(expected) {
      return retire(expected, true);
    },
  };
}
