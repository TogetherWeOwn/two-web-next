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
