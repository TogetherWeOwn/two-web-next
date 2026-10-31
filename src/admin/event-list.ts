export const EVENT_PAGE_SIZE = 25;

export type EventSort = "title" | "starts_at" | "status";
/**
 * The Starts from / Starts before window, normalized by the one authority below.
 * `from` and `before` are canonical UTC calendar dates (`YYYY-MM-DD`); a window
 * with an `error` must never reach the store. Absent from the query when
 * neither bound was supplied, so ordinary unfiltered queries are unchanged.
 */
export type EventStartsWindow = {
  from?: string;
  before?: string;
  error?: string;
  /** Correction-only bitmask: 1 lower, 2 upper. Never a database predicate. */
  required?: number;
};
export type EventListQuery = {
  q: string;
  status: "" | "draft" | "published" | "cancelled" | "past";
  series: "" | "parent" | "child" | "standalone";
  fill: "" | "full" | "has_seats" | "unlimited";
  rsvp_open: "" | "1" | "0";
  sort: EventSort;
  order: "asc" | "desc";
  page: number;
  startsWindow?: EventStartsWindow;
};
/** A repeated date parameter arrives as an array so duplicates stay detectable. */
export type EventListParams = Partial<
  Record<Exclude<keyof EventListQuery, "startsWindow" | "page">, string> & {
    page: string;
    starts_from: string | readonly string[];
    starts_before: string | readonly string[];
    starts_required: string | readonly string[];
  }
>;

/** First value wins per key, except the date bounds, where a repeat is an error. */
export function eventListParams(search: URLSearchParams): EventListParams {
  const raw: Record<string, string | string[]> = {};
  for (const [key, value] of search) {
    const seen = raw[key];
    if (seen === undefined) raw[key] = value;
    else if (key === "starts_from" || key === "starts_before" || key === "starts_required")
      raw[key] = Array.isArray(seen) ? [...seen, value] : [seen, value];
  }
  return raw as EventListParams;
}

const WINDOW_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WINDOW_NOT_APPLIED = "The date window was not applied and no events are shown.";

/** Real Gregorian calendar day, years 0001-9999, as a UTC-midnight instant. */
function utcMidnight(value: string): Date | null {
  const match = WINDOW_DATE.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (year < 1 || month < 1 || month > 12 || day < 1) return null;
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day > days) return null;
  // Date.UTC maps years 0-99 to 1900-1999; set the full year explicitly.
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return date;
}

/**
 * The single authority for the planning window: exact UTC dates, either bound
 * optional, half-open `[from 00:00Z, before 00:00Z)` over event start instants.
 * Empty values are absent. Duplicates, impossible dates and reversed or equal
 * bounds yield an `error` (never reflecting the input); valid single bounds
 * are still returned so the form can show them for correction.
 */
export function parseEventStartsWindow(
  from: string | readonly string[] | undefined,
  before: string | readonly string[] | undefined,
  correction?: string | readonly string[],
): EventStartsWindow | undefined {
  // A hidden correction marker survives native GET submission of blank date
  // controls. Supplying real dates satisfies it; Clear filters removes it.
  let required =
    correction === undefined
      ? 0
      : typeof correction === "string" && /^[123]$/.test(correction)
        ? Number(correction)
        : 3;
  const fields = [from, before].map((v) => (typeof v === "string" ? [v] : (v ?? [])));
  if (!required && fields.every((f) => f.length === 0 || (f.length === 1 && f[0] === "")))
    return undefined;
  const window: EventStartsWindow = {};
  const [a, b] = fields.map((f) => (f.length === 1 ? f[0] : "")) as [string, string];
  const dates = [a, b].map((v) => (v === "" ? null : utcMidnight(v)));
  if (a !== "" && dates[0]) window.from = a;
  if (b !== "" && dates[1]) window.before = b;
  fields.forEach((f, i) => {
    if (f.length > 1 || (f.length === 1 && f[0] !== "" && !dates[i])) required |= 1 << i;
  });
  if (fields.some((f) => f.length > 1)) {
    window.error = `Starts from and Starts before can each be given only once. ${WINDOW_NOT_APPLIED}`;
  } else if ((required & 1 && !window.from) || (required & 2 && !window.before)) {
    window.error = `Starts from and Starts before must be valid calendar dates (YYYY-MM-DD, years 0001 to 9999). ${WINDOW_NOT_APPLIED}`;
  } else if (window.from && window.before && window.from >= window.before) {
    window.error = `Starts from must be a date before Starts before. ${WINDOW_NOT_APPLIED}`;
  }
  if (window.error && required) window.required = required;
  return window;
}

/** UTC instants for the store; null when there is no usable window. */
export function eventStartsBounds(
  window: EventStartsWindow | undefined,
): { from: Date | null; before: Date | null } | null {
  if (!window || window.error) return null;
  return {
    from: window.from ? utcMidnight(window.from) : null,
    before: window.before ? utcMidnight(window.before) : null,
  };
}

/** Plain-language active interval; spells out the half-open UTC semantics. */
export function eventStartsWindowSummary(window: EventStartsWindow | undefined): string | null {
  if (!window || window.error || (!window.from && !window.before)) return null;
  const from = window.from ? `at or after ${window.from} 00:00 UTC (included)` : "";
  const before = window.before ? `before ${window.before} 00:00 UTC (excluded)` : "";
  return `Showing events that start ${[from, before].filter(Boolean).join(" and ")}. Event times below stay in UTC.`;
}

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
  const startsWindow = parseEventStartsWindow(
    params.starts_from,
    params.starts_before,
    params.starts_required,
  );
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
    sort: sort === "title" || sort === "status" || sort === "starts_at" ? sort : "starts_at",
    order: params.order === "asc" ? "asc" : "desc",
    // Keep the offset within a safe integer, even for adversarial page values.
    page:
      /^\d+$/.test(params.page ?? "") &&
      Number.isSafeInteger(page) &&
      page > 0 &&
      Number.isSafeInteger(page * EVENT_PAGE_SIZE)
        ? page
        : 1,
    ...(startsWindow ? { startsWindow } : {}),
  };
}

export function eventListUrl(query: EventListQuery, changes: Partial<EventListQuery> = {}): string {
  const next = { ...query, ...changes };
  const params = new URLSearchParams();
  for (const key of ["q", "status", "series", "fill", "rsvp_open"] as const) {
    if (next[key]) params.set(key, next[key]);
  }
  if (next.startsWindow?.from) params.set("starts_from", next.startsWindow.from);
  if (next.startsWindow?.before) params.set("starts_before", next.startsWindow.before);
  params.set("sort", next.sort);
  params.set("order", next.order);
  if (next.page > 1) params.set("page", String(next.page));
  return `/admin/events?${params}`;
}

/** Query is normalized by parseEventListQuery before reaching the page. */
export function eventListHasFilters(query: EventListQuery): boolean {
  return Boolean(
    query.q || query.status || query.series || query.fill || query.rsvp_open || query.startsWindow,
  );
}

export function eventListClearUrl(query: EventListQuery): string {
  return eventListUrl(query, {
    q: "",
    status: "",
    series: "",
    fill: "",
    rsvp_open: "",
    startsWindow: undefined,
    page: 1,
  });
}

/** A successful empty later page says nothing about the inventory as a whole. */
export function eventEmptyText(query: EventListQuery): string {
  if (query.startsWindow?.error) return "Correct the dates above to see events.";
  if (query.page > 1) return "No results on this page.";
  return eventListHasFilters(query) ? "No events match these filters." : "No events yet.";
}
