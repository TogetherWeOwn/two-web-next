/**
 * going-count island contract: badge testids, broadcast event, collection
 * aggregate refresh. Part of the island contract family; re-exported from
 * `./contracts` so existing import paths keep working.
 */

import { MOUNT_ATTR } from "./contracts-shared";

/** Collection JSON. Carries `going_count` per row (EventResource contract). */
export const EVENTS_JSON_URL = "/events.json";

/* --------------------------------------------------------------- going-count
 * Legacy: app/Livewire/GoingCount.php + going-count.blade.php (TOG-7966).
 * The badge lives outside the RSVP control, so a write must refresh it.
 * Re-spec: the button island broadcasts a DOM CustomEvent; this island
 * re-reads the aggregate from the frozen collection — never trusts the
 * writer's copy.
 */

export const GOING_COUNT_ISLAND = "going-count";
export const GOING_COUNT_TESTID = "event-going-count";
export const SPOTS_LEFT_TESTID = "event-spots-left";
/** Schedule availability line on calendar cards and month-grid entries
 * ("2 seats left", "RSVPs paused", "Ended", "No seat limit",
 * "Discord-managed"): a server-rendered snapshot from existing row data,
 * never a reservation. Distinct from {@link SPOTS_LEFT_TESTID}, which stays
 * the Full-only marker shared with the detail lineup. */
export const SCHEDULE_AVAILABILITY_TESTID = "event-schedule-availability";
/** Stale-qualification note the binder renders inside the badge on refresh
 * failure (`role="status"`, "could not refresh" copy with last-saved
 * context). Mirrors the attendees-live stale/retry precedent. */
export const GOING_COUNT_STALE_TESTID = "event-going-count-stale";
/** Explicit aggregate-only retry button inside the stale note (`Try again`,
 * keyboard-reachable native button; re-issues the same keyed GET, never an
 * RSVP write). */
export const GOING_COUNT_RETRY_TESTID = "event-going-count-retry";
/** DOM CustomEvent replacing the Livewire `going-count-updated` broadcast. */
export const GOING_UPDATED_EVENT = "going-count-updated";

export type GoingViewerState = "going" | "waitlisted" | "none" | "other";

export interface GoingCountState {
  going: number;
  /** Seat occupancy for the spots-left line; defaults to `going` when absent
   * (older fixtures). Counts every going row like the write path, so spots
   * never offer a seat a nameless row already holds. Aggregate only. */
  occupancy?: number;
  capacity: number | null;
  showSpotsLeft: boolean;
  announcement: GoingViewerState | null;
}

export function goingAnnouncementText(a: GoingViewerState | null): string {
  switch (a) {
    case "going":
      return "You're going.";
    case "waitlisted":
      return "You're on the waitlist.";
    case "none":
      return "RSVP removed.";
    default:
      return "";
  }
}

/** "N of M going" with a cap, "N going" without — never invents a number. */
export function goingCountText(going: number, capacity: number | null): string {
  return capacity !== null ? `${going} of ${capacity} going` : `${going} going`;
}

/** Cancelled schedule rows keep their retained answers visible as history,
 * never as attendance, places, or an invitation: "N existing responses"
 * ("1 existing response" in the singular).
 * Capacity is meaningless after cancellation, so it is never shown here. */
export function existingResponsesText(responses: number): string {
  return `${responses} existing ${responses === 1 ? "response" : "responses"}`;
}

export function spotsLeftText(going: number, capacity: number): string {
  const left = Math.max(0, capacity - going);
  return left <= 0 ? "Full" : `${left} of ${capacity} spots left`;
}

/**
 * Server-rendered badge HTML (the event page renders this; the binder only
 * patches the [data-count]/[data-spots]/[data-announcement] nodes in place).
 * `role="status"`: updates announce politely, never as an alert. The
 * announcement node is always rendered (empty before any write) so the
 * binder has a stable target; an empty node announces nothing, so page
 * load stays quiet — same observable behavior the legacy test pins.
 * The spots-left line sits inside the mount so the binder reaches it with
 * one querySelector and patches only its own island.
 */
export function renderGoingCount(eventKey: string, s: GoingCountState): string {
  const announcement = goingAnnouncementText(s.announcement);
  const safeKey = eventKey.replace(/"/g, "&quot;");
  const occupancy = s.occupancy ?? s.going;
  const spots =
    s.showSpotsLeft && s.capacity !== null
      ? ` · <span data-testid="${SPOTS_LEFT_TESTID}" data-spots>${spotsLeftText(occupancy, s.capacity)}</span>`
      : "";
  return (
    `<span role="status" data-testid="${GOING_COUNT_TESTID}" ` +
    `${MOUNT_ATTR}="${GOING_COUNT_ISLAND}" data-event-key="${safeKey}" data-capacity="${s.capacity ?? ""}">` +
    `<span class="sr-only" data-announcement>${announcement}${announcement ? " " : ""}</span>` +
    `<span data-count>${goingCountText(s.going, s.capacity)}</span>${spots}</span>`
  );
}

/* -------------------------------------------------------- going-count fetch */

/** Owned overall read deadline for one aggregate refresh: headers plus
 * response-body completion, at most 5 seconds. On expiry the binder aborts
 * the owned fetch and keeps the last good numbers, qualified as stale via
 * {@link GOING_COUNT_STALE_TESTID} with an aggregate-only retry; a confirmed
 * RSVP state is never retracted. */
export const GOING_COUNT_READ_DEADLINE_MS = 5_000;

export interface GoingRefreshRequest {
  method: "GET";
  url: string;
  eventKey: string;
}

/** One request per answered event, filtered before collection pagination. */
export function goingRefreshRequest(eventKey: string): GoingRefreshRequest {
  return {
    method: "GET",
    url: `${EVENTS_JSON_URL}?event_key=${encodeURIComponent(eventKey)}`,
    eventKey,
  };
}

export interface EventJsonRow {
  event_key: string;
  going_count: number;
  /** Seat occupancy for spots/full; absent on older snapshots. */
  going_occupancy?: number;
}

/** Pick this island's aggregate out of the collection; null when absent. */
export function applyGoingRefresh(rows: EventJsonRow[], eventKey: string): number | null {
  const row = rows.find((r) => r.event_key === eventKey);
  return row ? row.going_count : null;
}

/** Pick the seat-occupancy aggregate out of the collection, falling back to
 * the attributable count on older snapshots; null when absent. */
export function applyGoingOccupancyRefresh(rows: EventJsonRow[], eventKey: string): number | null {
  const row = rows.find((r) => r.event_key === eventKey);
  if (!row) return null;
  return row.going_occupancy ?? row.going_count;
}

/** Listener-side skip: another card's answer fires no request here. */
export function shouldRefreshGoing(detailKey: string, islandKey: string): boolean {
  return detailKey === islandKey;
}
