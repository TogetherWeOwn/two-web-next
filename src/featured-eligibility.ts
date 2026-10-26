// Saved-slot eligibility wording shared by the Hono and Kit admin edit panels.
//
// Finite windows use the existing status authority (featuredStatus: unpublished
// precedence, start inclusive, end exclusive). Published windows the driver
// cannot decode withhold the admin verdict rather than falling through to live.
// Eligibility is a point-in-time verdict, never proof of guest homepage delivery.
import { featuredStatus, type FeaturedStatus, type FeaturedWindow } from "./featured-status";

export type FeaturedEligibilityStatus = FeaturedStatus | "unavailable";

/** Admin-only admission: NaN comparisons must not invent a positive verdict. */
export function featuredEligibilityStatus(
  row: FeaturedWindow,
  now: Date = new Date(),
): FeaturedEligibilityStatus {
  if (!row.isPublished) return "unpublished";
  for (const bound of [row.startsAt, row.endsAt]) {
    if (bound !== null && (!(bound instanceof Date) || !Number.isFinite(bound.getTime()))) {
      return "unavailable";
    }
  }
  return featuredStatus(row, now);
}

export function featuredEligibilityReason(row: FeaturedWindow, now: Date = new Date()): string {
  return featuredEligibilityReasonFor(featuredEligibilityStatus(row, now));
}

// Latest instant a JavaScript Date represents, in milliseconds (±8.64e15).
// Mirrors the MAX_JS_INSTANT bound the inventory SQL predicate uses.
const MAX_DATE_MS = 8.64e15;

// Saved bound text the list/edit projection carries: UTC wall time at
// microsecond precision (to_char 'YYYY-MM-DD HH24:MI:SS.US'). Anything else —
// infinities, BC eras, out-of-range or malformed text — is undecodable.
const SAVED_BOUND_TEXT = /^(\d{4,6})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{6})$/;

type InventoryInstant = { epochSecond: number; microsecond: number };
const UNDECODABLE = "undecodable" as const;

function toInventoryInstant(ms: number): InventoryInstant {
  const epochSecond = Math.floor(ms / 1000);
  return { epochSecond, microsecond: (ms - epochSecond * 1000) * 1000 };
}

function inventoryBoundInstant(
  bound: Date | null,
  exactText: string | null | undefined,
): InventoryInstant | null | typeof UNDECODABLE {
  if (typeof exactText === "string" && exactText !== "") {
    const match = SAVED_BOUND_TEXT.exec(exactText);
    if (!match) return UNDECODABLE;
    const [, year, month, day, hour, minute, second, micro] = match.map(Number);
    // setUTCFullYear: Date.UTC remaps years 0-99 onto the 1900s.
    const probe = new Date(0);
    probe.setUTCFullYear(year!, month! - 1, day!);
    probe.setUTCHours(hour!, minute!, second!, 0);
    const ms = probe.getTime();
    // Reject normalized overflows (month 13, day 32) and out-of-range years.
    if (
      !Number.isFinite(ms) ||
      Math.abs(ms) > MAX_DATE_MS ||
      probe.getUTCFullYear() !== year ||
      probe.getUTCMonth() !== month! - 1 ||
      probe.getUTCDate() !== day ||
      probe.getUTCHours() !== hour ||
      probe.getUTCMinutes() !== minute ||
      probe.getUTCSeconds() !== second
    ) {
      return UNDECODABLE;
    }
    return { epochSecond: ms / 1000, microsecond: micro! };
  }
  if (bound === null || bound === undefined) return null;
  if (!(bound instanceof Date) || !Number.isFinite(bound.getTime())) return UNDECODABLE;
  return toInventoryInstant(bound.getTime());
}

function instantAfter(a: InventoryInstant, b: InventoryInstant): boolean {
  return (
    a.epochSecond > b.epochSecond ||
    (a.epochSecond === b.epochSecond && a.microsecond > b.microsecond)
  );
}

/**
 * Inventory verdict at saved database precision: start inclusive, end
 * exclusive, unpublished precedence, scheduled before expired — the same
 * verdict the list SQL predicate applies. The decoded Dates alone cannot
 * carry microseconds, so the exact saved bound text (when the projection
 * carries it) is the authoritative bound; without it the verdict matches
 * featuredEligibilityStatus exactly. A published undecodable window
 * withholds the verdict (unavailable, never live).
 */
export function featuredInventoryStatus(
  row: FeaturedWindow & { startsAtText?: string | null; endsAtText?: string | null },
  now: Date = new Date(),
): FeaturedEligibilityStatus {
  if (!row.isPublished) return "unpublished";
  const starts = inventoryBoundInstant(row.startsAt, row.startsAtText);
  const ends = inventoryBoundInstant(row.endsAt, row.endsAtText);
  if (starts === UNDECODABLE || ends === UNDECODABLE) return "unavailable";
  const at = toInventoryInstant(now.getTime());
  if (starts && instantAfter(starts, at)) return "scheduled";
  if (ends && !instantAfter(ends, at)) return "expired";
  return "live";
}

export function featuredEligibilityReasonFor(status: FeaturedEligibilityStatus): string {
  switch (status) {
    case "unpublished":
      return "Not published — publication is off for this saved slot. Publish it before the slot can become eligible for the homepage.";
    case "scheduled":
      return "Not started — the saved window starts in the future. The slot becomes eligible when its start time is reached.";
    case "expired":
      return "Ended — the saved window has closed; its Show until time has passed.";
    case "live":
      return "Eligible — the saved slot is inside its publication window at this check time. Eligibility is not proof of guest homepage delivery: verify the homepage as a guest.";
    case "unavailable":
      return "Eligibility cannot be determined — a saved window bound cannot be decoded as a finite UTC instant. Inspect the exact saved bounds before making an authorized correction.";
    default:
      return `Status ${status} — the saved eligibility verdict is unavailable; verify the homepage as a guest.`;
  }
}

/** Mid-sentence fragments for an open saved window bound (lowercase by design). */
export const FEATURED_OPEN_START_COPY = "no start time — the window has no lower bound";
export const FEATURED_OPEN_END_COPY = "no end time — the slot does not expire";
export const FEATURED_WINDOW_RULES_COPY =
  "The saved start is inclusive and the saved end is exclusive.";

export type FeaturedBoundDisplay =
  | { kind: "open" }
  | { kind: "instant"; iso: string }
  | { kind: "text"; text: string };

/**
 * Saved window bound for the edit-panel display.
 *
 * Finite decoded Dates render as UTC ISO instants (the `<time datetime>`
 * value the saved-preview contract parses). Driver-undecodable bounds — BC
 * eras and infinities, which Date decoding cannot represent
 * (src/admin/store-featured.ts keeps the exact SQL text for them) — fall back
 * to that exact text so the panel never throws: a render throw inside the
 * member-read boundary answers 503. Null stays open.
 */
export function featuredBoundDisplay(
  bound: Date | null,
  exactText: string | null | undefined,
): FeaturedBoundDisplay {
  if (bound instanceof Date && Number.isFinite(bound.getTime())) {
    return { kind: "instant", iso: bound.toISOString() };
  }
  if (typeof exactText === "string" && exactText !== "") {
    return { kind: "text", text: exactText };
  }
  if (bound === null) return { kind: "open" };
  return { kind: "text", text: String(bound) };
}
