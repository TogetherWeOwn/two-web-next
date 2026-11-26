import { isDeepStrictEqual } from "node:util";
import { parseWindowStartIso } from "../.github/actions/gradual-promote/gradual-promote.mjs";

const REFUSED = "Staging E2E reservation binding refused";

function e2eTime(value) {
  if (
    typeof value !== "string" ||
    (value.length !== 20 && value.length !== 24) ||
    !value.endsWith("Z")
  ) {
    throw new Error(REFUSED);
  }
  return parseWindowStartIso(value);
}

/**
 * Bind a verified, completed E2E receipt (sha, allocationId, and e2e start/end)
 * using the staging-reservation admission module. The caller holds the staging
 * lane and supplies authoritative before/after reservation reads with independently
 * verified owner IDs. Each read is { record, verifiedOwnerId } or null for
 * confirmed absence. A failed read cannot be represented by null.
 */
export function bindStagingE2eReservation(receipt, evidence) {
  try {
    const { admission } = evidence;
    if (Object.hasOwn(receipt, "reservation")) throw new Error(REFUSED);
    if (evidence.before === null && evidence.after === null) return receipt;

    // Validate and bind one plain-data copy of each input so later reads cannot diverge.
    const snapshot = ({ record, verifiedOwnerId }) => structuredClone({ record, verifiedOwnerId });
    const before = snapshot(evidence.before);
    const after = snapshot(evidence.after);
    receipt = structuredClone(receipt);
    const startedAtMs = e2eTime(receipt.e2e.startedAt);
    const completedAtMs = e2eTime(receipt.e2e.completedAt);
    const reservation = admission.parseStagingReservation(before.record);
    const observed = { sha: receipt.sha, allocationId: receipt.allocationId };
    const admits = (snapshot, nowMs) =>
      admission.canAdmitStagingOperation(snapshot.record, {
        operation: "e2e",
        nowMs,
        verifiedOwnerId: snapshot.verifiedOwnerId,
        observed,
        e2eSha: receipt.sha,
      }) === true;

    // Ordinary admission reopens at expiry. Reserved evidence needs an active
    // lease through completion and the same canonical lease at both reads.
    if (
      startedAtMs >= completedAtMs ||
      reservation.sha !== receipt.sha ||
      reservation.allocationId !== receipt.allocationId ||
      completedAtMs >= reservation.expiresAtMs ||
      !isDeepStrictEqual(reservation, admission.parseStagingReservation(after.record)) ||
      !admits(before, startedAtMs) ||
      !admits(after, completedAtMs)
    ) {
      throw new Error(REFUSED);
    }

    return { ...receipt, reservation };
  } catch {
    throw new Error(REFUSED);
  }
}
