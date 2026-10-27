// Capacity guidance for the saved-event edit twins (Hono and Kit share it).
//
// The numbers are a snapshot of Going-only occupancy read when the page was
// served. They explain a proposed cap; they never reserve a seat. The locked
// update (store-event-writes.ts, commitLockedUpdate) re-counts under the event
// row lock and stays the only authority: a response that lands after the
// snapshot is still handled there. Maybe, Waitlist and Not going responses do
// not occupy seats, matching that guard.
//
// The progressive island (assets/islands/admin-event-capacity.js) repeats the
// proposed-cap sentences below; test/admin-event-capacity-acceptance.test.ts
// drives both.
import { rosterUrl, type RosterQuery } from "./table-list";

export const CAPACITY_RANGE_HINT =
  "Capacity is a headcount from 1 to 2147483647, or empty for unlimited.";

export const CAPACITY_REVIEW_LABEL = "Review Going responses";

/** Static seat rules shown beside the input, also useful with JavaScript off. */
export const CAPACITY_SEAT_NOTE =
  "Only Going responses occupy seats. Maybe and Waitlist responses do not occupy seats, and raising the capacity can promote the waitlist.";

export const CAPACITY_REVIEW_NOTE =
  "Opens the Going responses on this page. Save your changes first.";

export type CapacityPanel = {
  /** Going-only occupancy when the page was served. */
  occupied: number;
  /** Saved cap; null = unlimited. */
  capacity: number | null;
  snapshot: string;
  advice: string;
  seatNote: string;
  reviewLabel: string;
  reviewNote: string;
  /** Existing roster-status URL: Going facet, first page, sort/order kept. */
  reviewUrl: string;
};

const seats = (n: number) => (n === 1 ? "1 seat" : `${n} seats`);

/** Saved-state sentence; the island rewrites it as the moderator types. */
export function capacityAdvice(occupied: number, capacity: number | null): string {
  if (capacity === null) {
    return `Unlimited: no cap applies. ${CAPACITY_RANGE_HINT}`;
  }
  const left = capacity - occupied;
  if (left > 0) return `${left} of ${capacity} seats left at the snapshot. ${CAPACITY_RANGE_HINT}`;
  if (left === 0)
    return `Full: ${occupied} of ${capacity} seats taken at the snapshot. ${CAPACITY_RANGE_HINT}`;
  return `Over the saved cap: ${occupied} are going on ${seats(capacity)}. ${CAPACITY_RANGE_HINT}`;
}

export function capacityPanel(
  eventKey: string,
  query: RosterQuery,
  occupied: number,
  capacity: number | null,
): CapacityPanel {
  return {
    occupied,
    capacity,
    snapshot:
      capacity === null
        ? `Snapshot when this page loaded: ${occupied} Going. Saved capacity: Unlimited.`
        : `Snapshot when this page loaded: ${occupied} Going of ${seats(capacity)}.`,
    advice: capacityAdvice(occupied, capacity),
    seatNote: CAPACITY_SEAT_NOTE,
    reviewLabel: CAPACITY_REVIEW_LABEL,
    reviewNote: CAPACITY_REVIEW_NOTE,
    reviewUrl: rosterUrl(eventKey, query, { status: "going", q: "", page: 1 }),
  };
}
