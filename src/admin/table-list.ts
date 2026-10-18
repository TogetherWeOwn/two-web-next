// Query state for the smaller admin tables. Raw sort keys never reach SQL.

export type ListParams = Record<string, string | undefined>;
export type SortOrder = "asc" | "desc";
export {
  type FeaturedSort,
  type FeaturedListQuery,
  FEATURED_PAGE_SIZE,
  parseFeaturedListQuery,
  featuredListUrl,
  featuredEmptyText,
} from "./featured-list-query";
export type RosterSort = "status" | "answered";
export type RosterQuery = { q: string; sort: RosterSort; order: SortOrder; page: number };
export type JoinAttemptsQuery = { outcome: string; q: string; page: number };
export const JOIN_ATTEMPT_PAGE_SIZE = 100;
export type ActivityLogQuery = { subject: string; causer: string; page: number };
export const ACTIVITY_LOG_PAGE_SIZE = 50;
/** The RSVP roster reuses the 100-row admin convention. */
export const ROSTER_PAGE_SIZE = 100;

// PostgreSQL text cannot contain NUL: drop it so a NUL-only filter reads as absent.
// Spelled with fromCharCode so the NUL survives transports that decode backslash-u escapes in transit.
const withoutNul = (raw: string | undefined): string =>
  (raw ?? "").replaceAll(String.fromCharCode(0), "");

// Free-text filters are bounded before the leading-wildcard ILIKE scan and
// before reflection into pagination/sort links. The bound is measured on the
// normalized value (NULs stripped, then trimmed); overlong values fall back
// to absent like other invalid values, never truncated to a new search term.
const FREE_TEXT_MAX_LENGTH = 128;
const boundFreeText = (value: string): string => (value.length > FREE_TEXT_MAX_LENGTH ? "" : value);

export function parseRosterQuery(params: ListParams): RosterQuery {
  const page = Number(params.roster_page);
  // Same unsafe-OFFSET guard as the join-attempts viewer: PostgreSQL OFFSET
  // is a signed bigint, so keep the arithmetic exact in JS too.
  const validPage =
    /^[1-9]\d*$/.test(params.roster_page ?? "") &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger((page - 1) * ROSTER_PAGE_SIZE);
  return {
    q: boundFreeText(withoutNul(params.roster_q).trim()),
    sort: params.roster_sort === "status" ? "status" : "answered",
    order: params.roster_order === "asc" ? "asc" : "desc",
    page: validPage ? page : 1,
  };
}

export function parseJoinAttemptsQuery(params: ListParams): JoinAttemptsQuery {
  const page = Number(params.page);
  // PostgreSQL OFFSET is a signed bigint; keep arithmetic exact in JS too.
  const validPage =
    /^[1-9]\d*$/.test(params.page ?? "") &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger((page - 1) * JOIN_ATTEMPT_PAGE_SIZE);
  return {
    outcome: withoutNul(params.outcome),
    q: boundFreeText(withoutNul(params.q).trim()),
    page: validPage ? page : 1,
  };
}

export function parseActivityLogQuery(params: ListParams): ActivityLogQuery {
  const page = Number(params.page);
  // PostgreSQL OFFSET is a signed bigint; keep arithmetic exact in JS too.
  const validPage =
    /^[1-9]\d*$/.test(params.page ?? "") &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger((page - 1) * ACTIVITY_LOG_PAGE_SIZE);
  return {
    subject: boundFreeText(withoutNul(params.subject).trim()),
    causer: boundFreeText(withoutNul(params.causer).trim()),
    page: validPage ? page : 1,
  };
}

export function rosterUrl(
  eventKey: string,
  query: RosterQuery,
  patch: Partial<RosterQuery> = {},
): string {
  const q = { ...query, ...patch };
  const params = new URLSearchParams({ roster_sort: q.sort, roster_order: q.order });
  if (q.q) params.set("roster_q", q.q);
  // Page 1 stays bare so sort/search links reset the roster to its first page.
  if (q.page > 1) params.set("roster_page", String(q.page));
  return `/admin/events/${encodeURIComponent(eventKey)}?${params}#rsvp-roster`;
}

export function joinAttemptsUrl(query: JoinAttemptsQuery, page: number): string {
  const params = new URLSearchParams({ page: String(page) });
  if (query.outcome) params.set("outcome", query.outcome);
  if (query.q) params.set("q", query.q);
  return `/admin/join-attempts?${params}`;
}

export function activityLogUrl(query: ActivityLogQuery, page: number): string {
  const params = new URLSearchParams({ page: String(page) });
  if (query.subject) params.set("subject", query.subject);
  if (query.causer) params.set("causer", query.causer);
  return `/admin/activity-log?${params}`;
}

/** Zero-row copy for the RSVP roster on the event edit page. */
export function rosterEmptyText(query: RosterQuery): string {
  return query.q ? "No RSVPs match this member search." : "No RSVPs yet.";
}

const SNOWFLAKE_ID = /^\d{10,25}$/;

/** Who-cell copy: snowflakes verbatim, legacy imports labeled, null as "—". */
export function formatActivityCauser(causerId: string | null): string {
  if (causerId === null) return "—";
  return SNOWFLAKE_ID.test(causerId) ? causerId : `${causerId} (legacy ID)`;
}

/** Zero-row copy for the activity-log viewer. */
export function activityLogEmptyText(query: ActivityLogQuery): string {
  return query.subject || query.causer ? "No activity matches these filters." : "No activity yet.";
}
