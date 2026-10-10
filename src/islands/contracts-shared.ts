/** Shared island mount attribute, names and explicit polling budgets. */

/** SSR marks hydratable regions with this attribute, e.g. data-island="going-count". */
export const MOUNT_ATTR = "data-island";

export const ISLANDS = [
  "events-calendar",
  "past-events",
  "going-count",
  "rsvp-button",
  "member-profile",
] as const;

export type IslandName = (typeof ISLANDS)[number];

/**
 * Explicit polling contract per island. `pollMs: null` means NO polling, with
 * the reason recorded — "explicit polling contracts" includes pinning where
 * polling was deliberately not built.
 */
export const POLLING: Record<IslandName, { pollMs: number | null; reason: string }> = {
  "events-calendar": {
    pollMs: null,
    reason:
      "User-driven fetches only (month step, settled search, past drawer, retry); " +
      "at most one request in flight, abort the previous. Events change slowly; Discord is the live channel.",
  },
  "past-events": {
    pollMs: null,
    reason: "Append-only archive; page-turn fetches only, no read loop.",
  },
  "going-count": {
    pollMs: null,
    reason:
      "Event-driven refresh on the going-count-updated CustomEvent; one GET /events.json " +
      "per answered event, non-matching keys fire no request.",
  },
  "rsvp-button": {
    pollMs: null,
    reason: "Writes only against the singular RSVP resource; optimistic states, no read loop.",
  },
  "member-profile": {
    pollMs: null,
    reason: "Edit/save/cancel PATCH flow; no read loop.",
  },
};
