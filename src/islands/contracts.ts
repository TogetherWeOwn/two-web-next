/**
 * W10 island contracts: Livewire → islands re-spec.
 *
 * There is no Livewire protocol on Workers. Each island is SSR HTML plus a
 * progressive-enhancement binder in `public/islands/*` with an explicit
 * request budget. This module is the single source of truth for the shared
 * mount attribute, island names and polling budgets, and the re-export barrel
 * for the per-island contracts (`./contracts-*.ts`) — the SSR slices
 * (W7 member journeys, W8 events, W9 RSVP) and the binders build from here.
 * The drift tests (`test/islands-*.test.ts`) pin it.
 *
 * Legacy sources (two-web, maintenance-only): `app/Livewire/*.php`,
 * `resources/views/livewire/*.blade.php`, `tests/Feature/Livewire/*`.
 */

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

/* ------------------------------------------------------------------ endpoints
 * Frozen URLs from the TOG-9671 URL freeze live with their islands;
 * query-surface additions (q, month, page) are proposed in the W10 spec
 * doc; W8 finalizes them there.
 */

export * from "./contracts-calendar";
export * from "./contracts-past-events";
export * from "./contracts-going-count";
export * from "./contracts-rsvp-button";
export * from "./contracts-member-profile";
