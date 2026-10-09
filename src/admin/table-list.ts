// Query state for the smaller admin tables. Raw sort keys never reach SQL.

export type ListParams = Record<string, string | undefined>;
export type SortOrder = "asc" | "desc";
export type FeaturedSort = "position" | "updated_at";
export type FeaturedListQuery = {
  published: "" | "1" | "0";
  q: string;
  sort: FeaturedSort;
  order: SortOrder;
};
export type RosterSort = "status" | "answered";
export type RosterQuery = { q: string; sort: RosterSort; order: SortOrder };
export type JoinAttemptsQuery = { outcome: string; q: string; page: number };
export const JOIN_ATTEMPT_PAGE_SIZE = 100;
export type ActivityLogQuery = { subject: string; causer: string; page: number };
export const ACTIVITY_LOG_PAGE_SIZE = 50;

export function parseFeaturedListQuery(params: ListParams): FeaturedListQuery {
  return {
    published: params.published === "1" || params.published === "0" ? params.published : "",
    q: (params.q ?? "").trim(),
    sort: params.sort === "updated_at" ? "updated_at" : "position",
    order: params.order === "desc" ? "desc" : "asc",
  };
}

export function parseRosterQuery(params: ListParams): RosterQuery {
  return {
    q: (params.roster_q ?? "").trim(),
    sort: params.roster_sort === "status" ? "status" : "answered",
    order: params.roster_order === "asc" ? "asc" : "desc",
  };
}

export function parseJoinAttemptsQuery(params: ListParams): JoinAttemptsQuery {
  const page = Number(params.page);
  // PostgreSQL OFFSET is a signed bigint; keep arithmetic exact in JS too.
  const validPage =
    /^[1-9]\d*$/.test(params.page ?? "") &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger((page - 1) * JOIN_ATTEMPT_PAGE_SIZE);
  return { outcome: params.outcome ?? "", q: (params.q ?? "").trim(), page: validPage ? page : 1 };
}

export function parseActivityLogQuery(params: ListParams): ActivityLogQuery {
  const page = Number(params.page);
  // PostgreSQL OFFSET is a signed bigint; keep arithmetic exact in JS too.
  const validPage =
    /^[1-9]\d*$/.test(params.page ?? "") &&
    Number.isSafeInteger(page) &&
    Number.isSafeInteger((page - 1) * ACTIVITY_LOG_PAGE_SIZE);
  return {
    // PostgreSQL text cannot contain NUL; retain the rest as literal input.
    // Spelled with fromCharCode so the NUL survives transports that decode
    // backslash-u escapes in transit.
    subject: (params.subject ?? "").replaceAll(String.fromCharCode(0), "").trim(),
    causer: (params.causer ?? "").replaceAll(String.fromCharCode(0), "").trim(),
    page: validPage ? page : 1,
  };
}

export function featuredListUrl(
  query: FeaturedListQuery,
  patch: Partial<FeaturedListQuery> = {},
): string {
  const q = { ...query, ...patch };
  const params = new URLSearchParams({ sort: q.sort, order: q.order });
  if (q.published) params.set("published", q.published);
  if (q.q) params.set("q", q.q);
  return `/admin/featured?${params}`;
}

export function rosterUrl(
  eventKey: string,
  query: RosterQuery,
  patch: Partial<RosterQuery> = {},
): string {
  const q = { ...query, ...patch };
  const params = new URLSearchParams({ roster_sort: q.sort, roster_order: q.order });
  if (q.q) params.set("roster_q", q.q);
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

/** Zero-row copy: filtered empties name the filters, genuine empties invite creation. */
export function featuredEmptyText(query: FeaturedListQuery): string {
  return query.q || query.published
    ? "No featured content matches these filters."
    : "No featured content yet.";
}

/** Zero-row copy for the RSVP roster on the event edit page. */
export function rosterEmptyText(query: RosterQuery): string {
  return query.q ? "No RSVPs match this member search." : "No RSVPs yet.";
}

/** Zero-row copy for the activity-log viewer. */
export function activityLogEmptyText(query: ActivityLogQuery): string {
  return query.subject || query.causer ? "No activity matches these filters." : "No activity yet.";
}
