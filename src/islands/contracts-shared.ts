/** Shared island mount attribute, names and explicit polling budgets. */

/** SSR marks hydratable regions with this attribute, e.g. data-island="going-count". */
export const MOUNT_ATTR = "data-island";

export const ISLANDS = [
  "events-calendar",
  "past-events",
  "going-count",
  "rsvp-button",
  "member-profile",
  "attendees-live",
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
  "attendees-live": {
    pollMs: null,
    reason:
      "Event-driven fragment refresh on the going-count-updated CustomEvent; one non-rotating " +
      "GET /e/:key (x-two-island fragment header) per answered event with a single bounded " +
      "retry, non-matching keys fire no request.",
  },
};

/**
 * Finite byte cap on one discovery read's HTML body (events calendar fragment
 * and past-events archive page), mirrored as HTML_MAX_BYTES in
 * assets/islands/events-calendar.js and assets/islands/past-events.js.
 *
 * Measured (2026-10-27, local fixtures, maximal admin-capped fields in 2-byte
 * UTF-8): /events/past?page=1 31,962 B; /events 93,131 B;
 * /events?view=calendar&month=2030-01 39,803 B; /events?past=1 177,177 B
 * (largest). 1 MiB leaves about 5.9x headroom for member views, search states
 * and Discord transients while keeping a parse-time memory ceiling. It is not
 * the JSON read cap. The islands count bytes consumed from the body stream
 * and cancel on overflow; Content-Length is ignored. A body-less response
 * falls back to text(), which only bounds the parse, not the download.
 */
export const DISCOVERY_HTML_MAX_BYTES = 1_048_576;
