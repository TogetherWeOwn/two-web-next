// Content-derived save precondition for the moderator event form. Two
// moderators editing the same event silently overwrote each other: the form
// carried no baseline and the committing update overwrote every field. The
// edit form now carries a server-minted hash of exactly the saved content it
// displays (all twelve editable fields), and the POST compares it inside the
// committing row lock. A mismatch refuses the save before any mutation; a
// missing or malformed baseline can never silently save.
//
// Deliberately wall-clock-free: updated_at is not an input, so a content
// change is detected even when the timestamp shares the same millisecond.
// Status, agent_version and recurrence live outside the form's editable fields
// and stay out of the baseline (publish/cancel keep their own guards).
// Moderators are authorized to save from a fresh read, so the mint is a plain
// content hash, not a signed token: there is nothing to forge that a GET
// would not hand out.

import { sha256Hex } from "../bot/signer";

/** Hidden carrier name on the edit Save form (Hono and Kit alike). */
export const EVENT_BASELINE_FIELD = "saved_baseline";

/**
 * Exactly the stored content the edit form displays. Newer optional columns
 * may be absent in older in-memory fixtures; the mint normalizes a missing
 * carrier to null, matching the stored default.
 */
export type BaselineContent = {
  title: string;
  game: string | null;
  description: string | null;
  accessibilityNotes?: string | null;
  organizer_name?: string | null;
  join_url?: string | null;
  join_instructions?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  capacity: number | null;
};

/**
 * Stored instants can be nonfinite (legacy ±Infinity rows under repair):
 * toISOString() throws on those, so encode them by their distinct time value
 * instead. Finite instants keep hashing as UTC ISO strings, so a fold-second
 * occurrence keeps its exact instant in the comparison.
 */
function instantToken(value: Date): string {
  const time = value.getTime();
  return Number.isFinite(time) ? value.toISOString() : `nonfinite:${String(time)}`;
}

/**
 * Mint the baseline for a row. Nulls stay null (distinct from "") and
 * instants hash as UTC ISO strings, so a fold-second occurrence keeps its
 * exact instant in the comparison.
 */
export async function eventContentBaseline(row: BaselineContent): Promise<string> {
  return sha256Hex(
    JSON.stringify([
      row.title,
      row.game,
      row.description,
      row.accessibilityNotes ?? null,
      instantToken(row.startsAt),
      instantToken(row.endsAt),
      row.timezone,
      row.location,
      row.capacity,
      row.organizer_name ?? null,
      row.join_url ?? null,
      row.join_instructions ?? null,
    ]),
  );
}

/** A mint is 64 lowercase hex; anything else fails closed at the route. */
export function isWellFormedBaseline(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}
