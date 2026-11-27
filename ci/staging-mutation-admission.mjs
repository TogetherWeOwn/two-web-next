const REFUSED = "Staging mutation reservation check refused";

/**
 * Await this check after taking the shared deploy-staging lane and before the
 * first staging mutation. Keep the lane through the mutation. Reservation
 * writers must use the same lane.
 *
 * verifiedCaller comes from trusted workflow admission. Its operation must be
 * "mutation", and its numeric owner ID must be independently verified, including
 * against the lease owner when a lease exists. Event inputs and stored owner
 * fields alone supply no verification.
 *
 * reservationStore.readLease() returns a decoded lease or exactly null for
 * confirmed absence. Read failures reject. canAdmitStagingOperation is the
 * synchronous reservation decision. Success lets the existing staging checks
 * continue.
 */
export async function assertStagingMutationAllowed(options) {
  try {
    const { verifiedCaller, reservationStore, canAdmitStagingOperation, now = Date.now } = options;
    const { operation, verifiedOwnerId } = verifiedCaller;
    if (operation === "mutation" && Number.isSafeInteger(verifiedOwnerId) && verifiedOwnerId > 0) {
      const record = await reservationStore.readLease();
      if (
        record !== undefined &&
        canAdmitStagingOperation(record, { operation, nowMs: now(), verifiedOwnerId }) === true
      ) {
        return;
      }
    }
  } catch {
    throw new Error(REFUSED);
  }
  throw new Error(REFUSED);
}
