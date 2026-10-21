// State-derived `<title>` text for the discovery pages (WCAG 2.4.2): tabs,
// history and screen-reader announcements tell months, searches, archive pages
// and seasons apart. One pure module serves the Hono pages and their Kit twins;
// the callers add the site suffix and the renderers escape the text.

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Query text kept in a title, in code points, before the ellipsis. */
export const TITLE_QUERY_LIMIT = 40;

/** Trimmed query capped at TITLE_QUERY_LIMIT code points; "" when blank. */
function titleQuery(q: string | undefined | null): string {
  const points = Array.from((q ?? "").trim());
  if (points.length <= TITLE_QUERY_LIMIT) return points.join("");
  return `${points.slice(0, TITLE_QUERY_LIMIT).join("")}…`;
}

/** "June 2030" for a "YYYY-MM" wall month; null when it is not one. */
function monthLabel(month: string | undefined | null): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? "");
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : null;
}

/** Upcoming schedule: search beats month; the plain list keeps "Events". */
export function eventsTitle(state: { view: string; month: string; q?: string | null }): string {
  const q = titleQuery(state.q);
  if (q) return `Events matching “${q}”`;
  const label = state.view === "calendar" ? monthLabel(state.month) : null;
  return label ? `Events — ${label}` : "Events";
}

export const EVENTS_SEARCH_TOO_LONG_TITLE = "Events — search too long";

/** Past archive: search beats page; the first page keeps "Past events". */
export function pastEventsTitle(page: number, q?: string | null): string {
  const query = titleQuery(q);
  if (query) return `Past events matching “${query}”`;
  return page > 1 ? `Past events — page ${page}` : "Past events";
}

/** Hot zones index: "all" keeps "Hot zones"; a season names itself. */
export function hotzonesTitle(season: string): string {
  return season === "all" ? "Hot zones" : `Hot zones — ${season}`;
}
