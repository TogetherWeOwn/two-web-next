/**
 * Acquire an empty reservation slot. The caller authorizes the request and supplies
 * the verified SHA, allocation UUID and numeric owner ID, the reservation parser,
 * and a fresh observation of the serving SHA and allocation. All deployment and
 * lease mutations must share the same exclusive lane for the full async callback.
 * Use a fresh issuance instant for each new lease identity, even after release.
 * On an uncertain commit, read back the slot before making another decision.
 */
export async function acquireStagingReservation(
  { verified, proposed },
  { parseLease, inMutationLane, observeAllocation, now, reservationStore },
) {
  // Write exactly the copy that was parsed and matched, never a second read of the input.
  const record = { ...proposed };
  const lease = parseLease(record);
  if (
    verified?.sha !== lease.sha ||
    verified?.allocationId !== lease.allocationId ||
    verified?.ownerId !== lease.ownerId
  ) {
    return "unverified-lease";
  }

  return inMutationLane(async () => {
    const observed = await observeAllocation();
    if (observed?.sha !== lease.sha || observed?.allocationId !== lease.allocationId) {
      return "staging-allocation-changed";
    }

    const nowMs = now();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new Error("Invalid staging lease clock");
    if (nowMs < lease.issuedAtMs || nowMs >= lease.expiresAtMs) return "lease-inactive";

    // Null expects confirmed absence. The lease lifecycle owns expiry and replacement.
    const committed = await reservationStore.compareAndSwapLease(null, record);
    return committed === true ? "acquired" : "lease-conflict";
  });
}
