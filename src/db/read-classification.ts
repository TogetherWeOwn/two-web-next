// These exceptions return event/content records or fixed aggregates, never
// arbitrary raw queries. A classification still permits exactly one statement.
import { Column, getTableName, is } from "drizzle-orm";
import { refuseMemberRead, type NonSensitiveRead } from "../member-reads";

export type SelectedField = { path: string[]; field: unknown };
export const normalizedStatement = (statement: string) => statement.trim().replace(/\s+/g, " ");

const fixedStatements = {
  "join-funnel":
    'select "outcome", count(*) from "join_attempts" where "join_attempts"."created_at" >= $1 group by "join_attempts"."outcome"',
  "search-widget":
    'select "normalized_query", count(*), max("occurred_at") from "event_search_logs" where "event_search_logs"."result_count" = $1 group by "event_search_logs"."normalized_query" order by count(*) desc, "event_search_logs"."normalized_query" asc limit $2',
  timeouts:
    "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)",
};
// Only bound-list cardinality varies; no interpolated identifiers/projections.
// Two pinned shapes: the legacy all-rows occupancy count (admin Fill column
// and fill filter, matching write-path seat enforcement; `withGoing` reuses
// this exact shape for its public `goingOccupancy`, which drives full,
// spots-left and the Going/waitlist CTA) and the public attributable count
// (`withGoing` joins users and counts only named rows, so the badge label
// agrees with the roster; the join qualifies "rsvps"."event_id"). Both return
// a single cardinality, never identities.
const goingCountsLegacy =
  /^select "event_id", count\(\*\) from "rsvps" where \("rsvps"\."event_id" in \(\$\d+(?:, \$\d+)*\) and "rsvps"\."status" = \$\d+\) group by "rsvps"\."event_id"$/;
const goingCountsNamed =
  /^select "rsvps"\."event_id", count\(\*\) from "rsvps" inner join "users" on "rsvps"\."user_id" = "users"\."id" where \("rsvps"\."event_id" in \(\$\d+(?:, \$\d+)*\) and "rsvps"\."status" = \$\d+ and "users"\."username" <> \$\d+\) group by "rsvps"\."event_id"$/;
// Roster totals return a single cardinality, never member identifiers. The
// username filter is a bound parameter; only these two join/where shapes may
// run under the roster-count classification.
const rosterCountUnfiltered =
  /^select count\(\*\) from "rsvps" inner join "events" on "events"\."id" = "rsvps"\."event_id" where "events"\."event_key" = \$\d+$/;
const rosterCountFiltered =
  /^select count\(\*\) from "rsvps" inner join "events" on "events"\."id" = "rsvps"\."event_id" left join "users" on "users"\."id" = "rsvps"\."user_id" where \("events"\."event_key" = \$\d+ and "users"\."username" ilike \$\d+\)$/;
const fillCount =
  /select count\(\*\) from "rsvps" where \("rsvps"\."event_id" = "events"\."id" and "rsvps"\."status" = \$\d+\)/g;
// The edit form needs PostgreSQL timestamp text, not lossy JS Dates. Only this
// complete bound-ID query permits its computed projections, never arbitrary SQL.
const featuredEditRead = `select "id", "legacy_id", "title", "body", "url", "image_url", "image_alt", "is_published", "position", "starts_at", "ends_at", "created_by", "created_at", "updated_at", CASE WHEN isfinite("starts_at") THEN to_char("starts_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || CASE WHEN EXTRACT(YEAR FROM "starts_at" AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END ELSE "starts_at"::text END, CASE WHEN isfinite("ends_at") THEN to_char("ends_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || CASE WHEN EXTRACT(YEAR FROM "ends_at" AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END ELSE "ends_at"::text END from "featured_contents" where "featured_contents"."id" = $1`;

export function validateNonSensitiveRead(
  classification: NonSensitiveRead,
  statement: string,
  fields?: SelectedField[],
): void {
  const query = normalizedStatement(statement);
  if (classification === "going-counts") {
    if (!goingCountsLegacy.test(query) && !goingCountsNamed.test(query)) refuseMemberRead();
    return;
  }
  if (classification === "roster-count") {
    if (!rosterCountUnfiltered.test(query) && !rosterCountFiltered.test(query)) refuseMemberRead();
    return;
  }
  if (
    classification !== "events" &&
    classification !== "featured" &&
    classification !== "activity-log"
  ) {
    if (query !== fixedStatements[classification]) refuseMemberRead();
    return;
  }
  if (classification === "featured" && fields?.length && query === featuredEditRead) return;
  const table =
    classification === "events"
      ? "events"
      : classification === "featured"
        ? "featured_contents"
        : "activity_log";
  // The viewer never renders the dirty before/after map: refuse any statement
  // that selects it, so a future projection cannot leak raw properties JSON.
  if (classification === "activity-log" && /\bproperties\b/i.test(query)) refuseMemberRead();
  if (
    !fields?.length ||
    fields.some(({ field }) => !is(field, Column) || getTableName(field.table) !== table)
  )
    refuseMemberRead();
  // Event fill filters have one reviewed correlated aggregate. Nothing else
  // may use member tables in a non-sensitive record read, even as a subquery.
  const checked =
    classification === "events" ? query.replace(fillCount, "fixed_going_count") : query;
  if (/\b(?:users|profiles|rsvps|join_attempts)\b/i.test(checked)) refuseMemberRead();
}

/** Fixed self-position projection also returns its actual RSVP owner. */
export function rawMemberOwner(statement: string): string | undefined {
  const query = normalizedStatement(statement);
  const owners = new Map([
    [
      "select member_id, joined_at, tenure_days, rank_key, is_current_member from web_v1.members where member_id = $1 limit 1",
      "member_id",
    ],
    [
      "select member_id, milestone, occurred_at, detail from web_v1.member_milestones where member_id = $1 order by occurred_at desc, milestone asc, detail asc nulls last limit 101",
      "member_id",
    ],
  ]);
  if (
    /^select event_id, user_id, position from \( select event_id, user_id, row_number\(\) over \(partition by event_id order by created_at, coalesce\(legacy_id, id\), id\)::int as position from rsvps where event_id in \(\$\d+(?:, \$\d+)*\) and status = 'waitlisted' \) line where user_id = \$\d+$/.test(
      query,
    )
  )
    return "user_id";
  // Self-profile upcoming game nights (src/profiles/upcoming.ts): the
  // viewer's own going/waitlisted answers joined to published events that
  // have not ended, soonest first, capped at the literal
  // PROFILE_UPCOMING_LIMIT. The waitlist position counts strictly-earlier
  // waitlisted rows under the waitlist FIFO key; bound params are the viewer
  // id and now only. Returns its RSVP owner alongside, never other members.
  if (
    /^select r\.user_id as user_id, e\.event_key as event_key, e\.title as title, e\.starts_at as starts_at, e\.timezone as timezone, e\.location as location, r\.status as status, case when r\.status = 'waitlisted' then \( select count\(\*\)::int \+ 1 from rsvps as w where w\.event_id = e\.id and w\.status = 'waitlisted' and \(w\.created_at, coalesce\(w\.legacy_id, w\.id\), w\.id\) < \(r\.created_at, coalesce\(r\.legacy_id, r\.id\), r\.id\) \) else null end as waitlist_position from rsvps as r inner join events as e on e\.id = r\.event_id where r\.user_id = \$\d+ and r\.status in \('going', 'waitlisted'\) and e\.status = 'published' and e\.ends_at >= \$\d+ order by e\.starts_at asc, e\.id asc limit 10$/.test(
      query,
    )
  )
    return "user_id";
  // Member leaderboard aggregate (src/leaderboards/members.ts): one grouped
  // row per ranked member with the owner's id alongside, never per-RSVP
  // rows. Only this exact GROUP BY + COUNT shape earns the exemption, with
  // optional season-window bounds, an optional lower(trim(game)) filter, and
  // an optional literal top-100 cap. Bound params are dates/game only; the
  // cap is the literal OVERALL_CAP, never a bound limit.
  if (
    /^select rsvps\.user_id as user_id, users\.username as username, count\(\*\)::int as count from rsvps inner join events on events\.id = rsvps\.event_id inner join users on users\.id = rsvps\.user_id left join profiles on profiles\.user_id = rsvps\.user_id where rsvps\.status = 'going' and events\.status = 'published' and users\.member = true and \(profiles\.leaderboard_opt_out is null or profiles\.leaderboard_opt_out = false\)( and events\.starts_at >= \$\d+ and events\.starts_at < \$\d+)?( and lower\(trim\(events\.game\)\) = \$\d+)? group by rsvps\.user_id, users\.username order by count\(\*\) desc, rsvps\.user_id asc( limit 100)?$/.test(
      query,
    )
  )
    return "user_id";
  // Relative-scope member board (src/leaderboards/members.ts): the same
  // grouped aggregate nested in derived tables (never a WITH prefix, which
  // the read classifier refuses), ranked by the same
  // `count DESC, user_id ASC` key via row_number(). The rank lookup returns
  // the viewer's single ranked row; the window read returns at most
  // 2 * RELATIVE_NEIGHBORS + 1 rows around the bound viewer rank. Bound
  // params are dates/game/viewer-id/viewer-rank only; the neighbor bounds
  // are the literal RELATIVE_NEIGHBORS, never a bound limit.
  if (
    /^select ranked\.user_id as user_id, ranked\.rank as rank from \( select grouped\.user_id as user_id, row_number\(\) over \(order by grouped\.count desc, grouped\.user_id asc\)::int as rank from \( select rsvps\.user_id as user_id, count\(\*\)::int as count from rsvps inner join events on events\.id = rsvps\.event_id inner join users on users\.id = rsvps\.user_id left join profiles on profiles\.user_id = rsvps\.user_id where rsvps\.status = 'going' and events\.status = 'published' and users\.member = true and \(profiles\.leaderboard_opt_out is null or profiles\.leaderboard_opt_out = false\)( and events\.starts_at >= \$\d+ and events\.starts_at < \$\d+)?( and lower\(trim\(events\.game\)\) = \$\d+)? group by rsvps\.user_id \) grouped \) ranked where ranked\.user_id = \$\d+$/.test(
      query,
    )
  )
    return "user_id";
  if (
    /^select ranked\.user_id as user_id, ranked\.username as username, ranked\.count as count, ranked\.rank as rank from \( select grouped\.user_id as user_id, grouped\.username as username, grouped\.count as count, row_number\(\) over \(order by grouped\.count desc, grouped\.user_id asc\)::int as rank from \( select rsvps\.user_id as user_id, users\.username as username, count\(\*\)::int as count from rsvps inner join events on events\.id = rsvps\.event_id inner join users on users\.id = rsvps\.user_id left join profiles on profiles\.user_id = rsvps\.user_id where rsvps\.status = 'going' and events\.status = 'published' and users\.member = true and \(profiles\.leaderboard_opt_out is null or profiles\.leaderboard_opt_out = false\)( and events\.starts_at >= \$\d+ and events\.starts_at < \$\d+)?( and lower\(trim\(events\.game\)\) = \$\d+)? group by rsvps\.user_id, users\.username \) grouped \) ranked where ranked\.rank between \$\d+ - 5 and \$\d+ \+ 5 order by ranked\.rank asc$/.test(
      query,
    )
  )
    return "user_id";
  return owners.get(query);
}
