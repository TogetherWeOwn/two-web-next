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
/** RSVP-answer facet: exact allowlist values; "" reads as All. */
export type RosterStatus = "" | "going" | "waitlisted" | "maybe" | "not_going";
export const ROSTER_STATUSES: { value: RosterStatus; label: string }[] = [
  { value: "", label: "All" },
  { value: "going", label: "Going" },
  { value: "waitlisted", label: "Waitlisted" },
  { value: "maybe", label: "Maybe" },
  { value: "not_going", label: "Not going" },
];
export type RosterQuery = {
  q: string;
  status: RosterStatus;
  sort: RosterSort;
  order: SortOrder;
  page: number;
};
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
  // The answer facet is an exact allowlist match on the raw value: no
  // trim/NUL/length normalization, so padded, NUL-suffixed or overlong
  // values read as All rather than as a nearby status.
  const rawStatus = params.roster_status ?? "";
  const status: RosterStatus =
    rawStatus === "going" ||
    rawStatus === "waitlisted" ||
    rawStatus === "maybe" ||
    rawStatus === "not_going"
      ? rawStatus
      : "";
  return {
    q: boundFreeText(withoutNul(params.roster_q).trim()),
    status,
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
  if (q.status) params.set("roster_status", q.status);
  if (q.q) params.set("roster_q", q.q);
  // Page 1 stays bare so sort/search links reset the roster to its first page.
  if (q.page > 1) params.set("roster_page", String(q.page));
  return `/admin/events/${encodeURIComponent(eventKey)}?${params}#rsvp-roster`;
}

/** Shared Hono/Kit range copy: matching responses, never seats or attendance. */
export function rosterRangeText(rangeStart: number, rangeEnd: number, total: number): string {
  return `Showing ${rangeStart}-${rangeEnd} of ${total} responses`;
}

/**
 * Scoped recovery for an empty roster page. Clear drops only the roster
 * filters (member search + answer facet), keeping normalized sort/order; the
 * first-page link keeps the whole filtered set. Both stay null while rows
 * render; the first-page link additionally needs a non-empty filtered total.
 */
export function rosterRecovery(
  eventKey: string,
  query: RosterQuery,
  rowCount: number,
  total: number,
): { clearUrl: string | null; firstUrl: string | null } {
  if (rowCount > 0) return { clearUrl: null, firstUrl: null };
  return {
    clearUrl:
      query.q || query.status ? rosterUrl(eventKey, query, { q: "", status: "", page: 1 }) : null,
    firstUrl: total > 0 ? rosterUrl(eventKey, query, { page: 1 }) : null,
  };
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

/**
 * Scoped recovery for an empty activity-log page. Clear drops only the
 * effective normalized filters (subject + causer), keeping the normalized
 * sort when a future slice adds one; the first-page link keeps the whole
 * effective filtered set. Both stay null while rows render. No count query:
 * a later empty page always offers its first page, which is safe whether or
 * not earlier results exist.
 */
export function activityLogRecovery(
  query: ActivityLogQuery,
  rowCount: number,
): { clearUrl: string | null; firstUrl: string | null } {
  if (rowCount > 0) return { clearUrl: null, firstUrl: null };
  return {
    clearUrl:
      query.subject || query.causer
        ? activityLogUrl({ subject: "", causer: "", page: 1 }, 1)
        : null,
    firstUrl: query.page > 1 ? activityLogUrl(query, 1) : null,
  };
}

/** Zero-row copy for the RSVP roster on the event edit page. */
export function rosterEmptyText(query: RosterQuery): string {
  if (query.q && query.status) return "No RSVPs match these roster filters.";
  if (query.q) return "No RSVPs match this member search.";
  if (query.status) return "No RSVPs match this answer status.";
  return "No RSVPs yet.";
}

const SNOWFLAKE_ID = /^\d{10,25}$/;

/** Who-cell copy: snowflakes verbatim, legacy imports labeled, null as "—". */
export function formatActivityCauser(causerId: string | null): string {
  if (causerId === null) return "—";
  return SNOWFLAKE_ID.test(causerId) ? causerId : `${causerId} (legacy ID)`;
}

/** Zero-row copy for the activity-log viewer. */
export function activityLogEmptyText(query: ActivityLogQuery): string {
  if (query.page > 1) return "No activity on this page.";
  return query.subject || query.causer ? "No activity matches these filters." : "No activity yet.";
}
