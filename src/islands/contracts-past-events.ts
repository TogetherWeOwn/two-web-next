/**
 * past-events island contract: archive testids, copy and page-turn requests.
 * Part of the island contract family; re-exported from `./contracts` so
 * existing import paths keep working.
 */

export const pastEventsUrl = (page: number): string =>
  page > 1 ? `/events/past?page=${page}` : "/events/past";

/* ---------------------------------------------------------------- past-events */

export const PAST_EVENTS_ISLAND = "past-events";
export const PAST_EVENTS_PAGE_SIZE = 20;
export const PAST_EVENTS_TESTID = "past-events";
export const PAST_EVENTS_LIST_TESTID = "past-events-list";
export const PAST_EVENTS_EMPTY_TESTID = "past-events-empty";
export const PAST_EVENTS_OUT_OF_RANGE_TESTID = "past-events-out-of-range";
export const PAST_EVENTS_COPY = {
  empty: "No past events yet.",
  join: "Join the community and help make the next one happen.",
  failed: "Could not load that page. Your current events are still here — try the page link again.",
} as const;

export function pastEventsOutOfRangeCopy(page: number, totalPages: number): string {
  return `Page ${page} is outside the archive. There ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}.`;
}

/** Page turns read SSR HTML; the archive never fetches viewer answers. */
export function pastEventsRequest(page: number): { method: "GET"; url: string } {
  return { method: "GET", url: pastEventsUrl(page) };
}
