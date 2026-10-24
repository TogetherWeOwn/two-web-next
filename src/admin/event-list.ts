export const EVENT_PAGE_SIZE = 25;

export type EventSort = "title" | "starts_at" | "status";
export type EventListQuery = {
  q: string;
  status: "" | "draft" | "published" | "cancelled" | "past";
  series: "" | "parent" | "child" | "standalone";
  fill: "" | "full" | "has_seats" | "unlimited";
  rsvp_open: "" | "1" | "0";
  /**
   * Exact-series scope: null when the inventory is unscoped, otherwise the
   * requested raw event key (possibly invalid — resolution, never parsing,
   * decides that). Distinct from `series`, which classifies rows; this names
   * one persisted recurrence via a stored key.
   */
  series_event: string | null;
  sort: EventSort;
  order: "asc" | "desc";
  page: number;
};
export type EventListParams = Partial<Record<keyof EventListQuery, string>>;

// Free-text search is bounded before the leading-wildcard ILIKE scan and
// before reflection into navigation links. Measured on the normalized value
// (NULs stripped, then trimmed); overlong falls back to absent, never truncated.
const EVENT_FREE_TEXT_MAX_LENGTH = 128;
const boundEventFreeText = (value: string): string =>
  value.length > EVENT_FREE_TEXT_MAX_LENGTH ? "" : value;

/** Only known query values reach the store or the navigation links. */
export function parseEventListQuery(params: EventListParams): EventListQuery {
  const status = params.status;
  const series = params.series;
  const fill = params.fill;
  const sort = params.sort;
  const page = Number(params.page);
  // Presence (not validity) requests the exact series: even an empty or
  // malformed value must resolve to an explicit recovery, never silently to
  // the unscoped inventory.
  const scoped = params.series_event !== undefined;
  return {
    // PostgreSQL text cannot contain NUL; retain the rest as literal input.
    q: boundEventFreeText((params.q ?? "").replaceAll("\u0000", "").trim()),
    status:
      status === "draft" || status === "published" || status === "cancelled" || status === "past"
        ? status
        : "",
    series: series === "parent" || series === "child" || series === "standalone" ? series : "",
    fill: fill === "full" || fill === "has_seats" || fill === "unlimited" ? fill : "",
    rsvp_open: params.rsvp_open === "1" || params.rsvp_open === "0" ? params.rsvp_open : "",
    series_event: scoped
      ? boundEventFreeText((params.series_event ?? "").replaceAll("\u0000", "").trim())
      : null,
    sort: sort === "title" || sort === "status" || sort === "starts_at" ? sort : "starts_at",
    // A scoped series reads oldest-first by default; the unscoped inventory
    // keeps newest-first. An explicit order always wins on either view.
    order:
      params.order === "asc" ? "asc" : params.order === "desc" ? "desc" : scoped ? "asc" : "desc",
    // Keep the offset within a safe integer, even for adversarial page values.
    page:
      /^\d+$/.test(params.page ?? "") &&
      Number.isSafeInteger(page) &&
      page > 0 &&
      Number.isSafeInteger(page * EVENT_PAGE_SIZE)
        ? page
        : 1,
  };
}

export function eventListUrl(query: EventListQuery, changes: Partial<EventListQuery> = {}): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  for (const key of ["q", "status", "series", "fill", "rsvp_open"] as const) {
    if (next[key]) params.set(key, next[key]);
  }
  // Exact-series scope rides every navigation link (sorts, pager, clear)
  // until the explicit All events escape drops it.
  if (next.series_event) params.set("series_event", next.series_event);
  params.set("sort", next.sort);
  params.set("order", next.order);
  if (next.page > 1) params.set("page", String(next.page));
  return `/admin/events?${params}`;
}

/** Recovery reasons the scoped inventory can report; each names an explicit escape. */
export type EventScopeRecovery = "invalid" | "not-found" | "not-in-series";

/** Shared Hono/Kit copy: an unusable series scope says so, never lists All events as the series. */
export function eventScopeRecoveryText(reason: EventScopeRecovery): string {
  switch (reason) {
    case "invalid":
      return "This series is unavailable: the series link is invalid. Choose All events to return to the full inventory.";
    case "not-found":
      return "This series is unavailable: no saved event matches that series link. Choose All events to return to the full inventory.";
    case "not-in-series":
      return "This series cannot be shown: the requested event is not part of a series. Choose All events to return to the full inventory.";
  }
}

/** Query is normalized by parseEventListQuery before reaching the page. */
export function eventListHasFilters(query: EventListQuery): boolean {
  return Boolean(query.q || query.status || query.series || query.fill || query.rsvp_open);
}

export function eventListClearUrl(query: EventListQuery): string {
  return eventListUrl(query, { q: "", status: "", series: "", fill: "", rsvp_open: "", page: 1 });
}

/** A successful empty later page says nothing about the inventory as a whole. */
export function eventEmptyText(query: EventListQuery): string {
  if (query.page > 1) return "No results on this page.";
  return eventListHasFilters(query) ? "No events match these filters." : "No events yet.";
}
