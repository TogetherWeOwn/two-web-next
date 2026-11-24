/**
 * past-events island contract: archive testids, copy and page-turn requests.
 * Part of the island contract family; re-exported from `./contracts` so
 * existing import paths keep working.
 */

export const pastEventsUrl = (page: number, q = ""): string => {
  const params = new URLSearchParams();
  if (page > 1) params.set("page", String(page));
  if (q) params.set("q", q);
  const search = params.toString();
  return `/events/past${search ? `?${search}` : ""}`;
};

/* ---------------------------------------------------------------- past-events */

export const PAST_EVENTS_ISLAND = "past-events";
export const PAST_EVENTS_PAGE_SIZE = 20;
export const PAST_EVENTS_TESTID = "past-events";
export const PAST_EVENTS_LIST_TESTID = "past-events-list";
export const PAST_EVENTS_EMPTY_TESTID = "past-events-empty";
export const PAST_EVENTS_OUT_OF_RANGE_TESTID = "past-events-out-of-range";
export const PAST_EVENTS_UNREADABLE_TESTID = "past-events-unreadable";
export const PAST_EVENTS_PAGER_TESTID = "past-events-pager";
export const PAST_EVENTS_PAGER_NEWER_TESTID = "past-events-pager-newer";
export const PAST_EVENTS_PAGER_OLDER_TESTID = "past-events-pager-older";
export const PAST_EVENTS_BACK_TESTID = "past-events-back";
export const PAST_EVENTS_SEARCH_MISS_TESTID = "past-events-search-miss";
export const PAST_EVENTS_COPY = {
  empty: "No past events yet.",
  join: "Join the community and help make the next one happen.",
  failed: "Could not load that page. Your current events are still here — try the page link again.",
} as const;

export function pastEventsState(
  page: number,
  totalPages: number,
  rowCount: number,
  q: string,
): "populated" | "empty" | "search-miss" | "out-of-range" | "unreadable" {
  if (rowCount > 0) return "populated";
  if (totalPages === 0) return q ? "search-miss" : "empty";
  if (page > totalPages) return "out-of-range";
  // The count includes in-range rows that the read may refuse to render.
  return "unreadable";
}

export function pastEventsHasNewer(page: number, totalPages: number): boolean {
  return page > 1 && totalPages > 0;
}

export function pastEventsUnreadableCopy(
  page: number,
  totalPages: number,
  hasMore: boolean,
): string {
  if (totalPages === 1 && !hasMore)
    return "We can’t show the events in this part of the archive right now.";
  const message = `We can’t show the events on page ${page} of ${totalPages} right now.`;
  const hasNewer = pastEventsHasNewer(page, totalPages);
  if (hasMore) return `${message} Try ${hasNewer ? "Newer or Older" : "Older"}.`;
  return hasNewer ? `${message} Try Newer.` : message;
}

export function pastEventsOutOfRangeCopy(page: number, totalPages: number): string {
  return `Page ${page} is outside the archive. There ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}.`;
}

/** Page turns read SSR HTML; the archive never fetches viewer answers. */
export function pastEventsRequest(page: number): { method: "GET"; url: string } {
  return { method: "GET", url: pastEventsUrl(page) };
}
