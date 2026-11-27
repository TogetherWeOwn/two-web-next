import { parseWindowStartIso } from "../.github/actions/gradual-promote/gradual-promote.mjs";
import { EXPECTED_VERSION_ID_PATTERN } from "../bin/smoke.mjs";
import { isSha } from "./staging-provenance.mjs";

// Budget for staged E2E and the 30-minute post-E2E soak after allocation.
const MAX_RESERVATION_MS = 60 * 60_000;
const FIELDS = ["sha", "allocationId", "ownerId", "issuedAt", "expiresAt"];

function reservationTime(value) {
  if (
    typeof value !== "string" ||
    (value.length !== 20 && value.length !== 24) ||
    !value.endsWith("Z")
  ) {
    throw new Error("Invalid staging reservation timestamp");
  }
  return parseWindowStartIso(value);
}

/** Parse a decoded reservation record. Throws on malformed or overlong records. */
export function parseStagingReservation(record) {
  if (
    record === null ||
    typeof record !== "object" ||
    Object.getPrototypeOf(record) !== Object.prototype ||
    Reflect.ownKeys(record).length !== FIELDS.length ||
    !FIELDS.every((key) => {
      const property = Object.getOwnPropertyDescriptor(record, key);
      return property?.enumerable && Object.hasOwn(property, "value");
    })
  ) {
    throw new Error("Invalid staging reservation record");
  }
  const { sha, allocationId, ownerId, issuedAt, expiresAt } = record;
  if (
    !isSha(sha) ||
    typeof allocationId !== "string" ||
    allocationId.length !== 36 ||
    !EXPECTED_VERSION_ID_PATTERN.test(allocationId) ||
    !Number.isSafeInteger(ownerId) ||
    ownerId <= 0
  ) {
    throw new Error("Invalid staging reservation identity");
  }

  const issuedAtMs = reservationTime(issuedAt);
  const expiresAtMs = reservationTime(expiresAt);
  const lifetimeMs = expiresAtMs - issuedAtMs;
  if (lifetimeMs <= 0 || lifetimeMs > MAX_RESERVATION_MS) {
    throw new Error("Invalid staging reservation lifetime");
  }
  return { sha, allocationId, ownerId, issuedAtMs, expiresAtMs };
}

/**
 * Decide the reservation gate only. The caller supplies a trusted clock, an independently
 * verified numeric GitHub owner ID for this record, and the currently serving allocation.
 * Pass null only after confirming absence or a verified release. Preserve read failures as errors.
 * A serving identity change denies reserved E2E and leaves the mutation hold in force until
 * verified expiry or release. A record with unverifiable ownership requires verified removal.
 */
export function canAdmitStagingOperation(record, context) {
  try {
    const { operation, nowMs, verifiedOwnerId, observed, e2eSha } = context;
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) return false;
    if (operation !== "mutation" && (operation !== "e2e" || !isSha(e2eSha))) return false;
    if (record === null) return true;

    const reservation = parseStagingReservation(record);
    if (verifiedOwnerId !== reservation.ownerId || nowMs < reservation.issuedAtMs) return false;
    if (nowMs >= reservation.expiresAtMs) return true;

    // Even a redeploy of the same SHA can replace the reserved allocation.
    return (
      operation === "e2e" &&
      e2eSha === reservation.sha &&
      observed?.sha === reservation.sha &&
      observed?.allocationId === reservation.allocationId
    );
  } catch {
    return false;
  }
}
