// These exceptions return event/content records or fixed aggregates, never
// arbitrary raw queries. A classification still permits exactly one statement.
import { Column, getTableName, is } from "drizzle-orm";
import { refuseMemberRead, type NonSensitiveRead } from "../member-reads";

export type SelectedField = { path: string[]; field: unknown };
export const normalizedStatement = (statement: string) => statement.trim().replace(/\s+/g, " ");

const fixedStatements = {
  "join-funnel": 'select "outcome", count(*) from "join_attempts" where "join_attempts"."created_at" >= $1 group by "join_attempts"."outcome"',
  "search-widget": 'select "normalized_query", count(*), max("occurred_at") from "event_search_logs" where "event_search_logs"."result_count" = $1 group by "event_search_logs"."normalized_query" order by count(*) desc, "event_search_logs"."normalized_query" asc limit $2',
  timeouts: "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
};
// Only bound-list cardinality varies; no interpolated identifiers/projections.
const goingCounts = /^select "event_id", count\(\*\) from "rsvps" where \("rsvps"\."event_id" in \(\$\d+(?:, \$\d+)*\) and "rsvps"\."status" = \$\d+\) group by "rsvps"\."event_id"$/;
const fillCount = /select count\(\*\) from "rsvps" where \("rsvps"\."event_id" = "events"\."id" and "rsvps"\."status" = \$\d+\)/g;

export function validateNonSensitiveRead(classification: NonSensitiveRead, statement: string, fields?: SelectedField[]): void {
  const query = normalizedStatement(statement);
  if (classification === "going-counts") {
    if (!goingCounts.test(query)) refuseMemberRead();
    return;
  }
  if (classification !== "events" && classification !== "featured") {
    if (query !== fixedStatements[classification]) refuseMemberRead();
    return;
  }
  const table = classification === "events" ? "events" : "featured_contents";
  if (!fields?.length || fields.some(({ field }) => !is(field, Column) || getTableName(field.table) !== table)) refuseMemberRead();
  // Event fill filters have one reviewed correlated aggregate. Nothing else
  // may use member tables in a non-sensitive record read, even as a subquery.
  const checked = classification === "events" ? query.replace(fillCount, "fixed_going_count") : query;
  if (/\b(?:users|profiles|rsvps|join_attempts)\b/i.test(checked)) refuseMemberRead();
}

/** Fixed self-position projection also returns its actual RSVP owner. */
export function rawMemberOwner(statement: string): string | undefined {
  const query = normalizedStatement(statement);
  const owners = new Map([
    ["select member_id, joined_at, tenure_days, rank_key, is_current_member from web_v1.members where member_id = $1 limit 1", "member_id"],
    ["select member_id, milestone, occurred_at, detail from web_v1.member_milestones where member_id = $1 order by occurred_at desc", "member_id"],
  ]);
  if (/^select event_id, user_id, position from \( select event_id, user_id, row_number\(\) over \(partition by event_id order by created_at, coalesce\(legacy_id, id\), id\)::int as position from rsvps where event_id in \(\$\d+(?:, \$\d+)*\) and status = 'waitlisted' \) line where user_id = \$\d+$/.test(query)) return "user_id";
  return owners.get(query);
}
