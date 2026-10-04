// PII routing guard for src/db/read-classification.ts.
//
// That module sits on the member-data read path (called from
// src/db/member-reads.ts before any classified statement executes). A
// misclassification routes PII to the wrong surface, so these tests pin the
// contract: each read kind accepts only its intended shape, PII-bearing reads
// never classify as public, and unknown kinds fail closed.
//
// Pure unit tests: validateNonSensitiveRead and rawMemberOwner are pure
// functions, so no database connection is needed.

import { describe, expect, it } from "vitest";
import { events, featuredContents } from "../src/db/admin-schema";
import {
  normalizedStatement,
  rawMemberOwner,
  validateNonSensitiveRead,
  type SelectedField,
} from "../src/db/read-classification";
import { MemberReadRefused, type NonSensitiveRead } from "../src/member-reads";

// Intended surface per classification (see call sites):
// - "events": public event pages, admin event reads, suggestions
//   (src/events/reads.ts, src/admin/store.ts, src/events/suggestions.ts)
// - "featured": featured-content admin and landing reads (src/admin/store.ts)
// - "join-funnel": admin dashboard join-funnel aggregate (src/admin/reads.ts)
// - "going-counts": per-event RSVP going counts (src/events/reads.ts)
// - "search-widget": event search-log aggregate (src/events/search-log.ts)
// - "timeouts": lock/statement timeout setup (src/events/suggestions.ts)

const TIMEOUTS =
  "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)";
const JOIN_FUNNEL =
  'select "outcome", count(*) from "join_attempts" where "join_attempts"."created_at" >= $1 group by "join_attempts"."outcome"';
const SEARCH_WIDGET =
  'select "normalized_query", count(*), max("occurred_at") from "event_search_logs" where "event_search_logs"."result_count" = $1 group by "event_search_logs"."normalized_query" order by count(*) desc, "event_search_logs"."normalized_query" asc limit $2';
const GOING_COUNTS_TWO =
  'select "event_id", count(*) from "rsvps" where ("rsvps"."event_id" in ($1, $2) and "rsvps"."status" = $3) group by "rsvps"."event_id"';
const MEMBER_ROW =
  "select member_id, joined_at, tenure_days, rank_key, is_current_member from web_v1.members where member_id = $1 limit 1";
const MILESTONE_ROW =
  "select member_id, milestone, occurred_at, detail from web_v1.member_milestones where member_id = $1 order by occurred_at desc";
const SELF_POSITION =
  "select event_id, user_id, position from ( select event_id, user_id, row_number() over (partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position from rsvps where event_id in ($1, $2) and status = 'waitlisted' ) line where user_id = $3";
// Verbatim copy of the module-private featuredEditRead literal: the admin edit
// form needs PostgreSQL timestamp text, not lossy JS Dates. Kept in sync on
// purpose — if the module changes this shape, this test must change too.
const FEATURED_EDIT_READ = `select "id", "legacy_id", "title", "body", "url", "image_url", "image_alt", "is_published", "position", "starts_at", "ends_at", "created_by", "created_at", "updated_at", CASE WHEN isfinite("starts_at") THEN to_char("starts_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || CASE WHEN EXTRACT(YEAR FROM "starts_at" AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END ELSE "starts_at"::text END, CASE WHEN isfinite("ends_at") THEN to_char("ends_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') || CASE WHEN EXTRACT(YEAR FROM "ends_at" AT TIME ZONE 'UTC') < 0 THEN ' BC' ELSE '' END ELSE "ends_at"::text END from "featured_contents" where "featured_contents"."id" = $1`;

const eventFields = (...names: Array<keyof typeof events>): SelectedField[] =>
  names.map((name) => ({ path: [name], field: events[name] }));
const featuredFields = (...names: Array<keyof typeof featuredContents>): SelectedField[] =>
  names.map((name) => ({ path: [name], field: featuredContents[name] }));

const refuses = (classification: NonSensitiveRead, statement: string, fields?: SelectedField[]) =>
  expect(() => validateNonSensitiveRead(classification, statement, fields)).toThrow(
    MemberReadRefused,
  );
const allows = (classification: NonSensitiveRead, statement: string, fields?: SelectedField[]) =>
  expect(() => validateNonSensitiveRead(classification, statement, fields)).not.toThrow();

describe("normalizedStatement", () => {
  it("trims and collapses whitespace so equivalent statements match", () => {
    expect(normalizedStatement("  select\n  a,\n\tb  from  t  ")).toBe("select a, b from t");
  });
});

describe("validateNonSensitiveRead accepts each intended shape", () => {
  it("timeouts accepts its fixed setup statement", () => {
    allows("timeouts", TIMEOUTS);
  });

  it("join-funnel accepts its fixed aggregate", () => {
    allows("join-funnel", JOIN_FUNNEL);
  });

  it("search-widget accepts its fixed aggregate", () => {
    allows("search-widget", SEARCH_WIDGET);
  });

  it("fixed statements match after whitespace normalization", () => {
    allows(
      "timeouts",
      "  select\n set_config('lock_timeout', $1, true),\n set_config('statement_timeout', $2, true)  ",
    );
  });

  it("going-counts accepts single- and multi-event IN lists", () => {
    allows(
      "going-counts",
      'select "event_id", count(*) from "rsvps" where ("rsvps"."event_id" in ($1) and "rsvps"."status" = $2) group by "rsvps"."event_id"',
    );
    allows("going-counts", GOING_COUNTS_TWO);
  });

  it("events accepts an events-table projection with no member tables", () => {
    allows(
      "events",
      'select "id", "title" from "events" where "events"."status" = $1',
      eventFields("id", "title"),
    );
  });

  it("events accepts the reviewed fill-count aggregate over rsvps", () => {
    allows(
      "events",
      'select "id", (select count(*) from "rsvps" where ("rsvps"."event_id" = "events"."id" and "rsvps"."status" = $1)) from "events" where "events"."status" = $2',
      eventFields("id"),
    );
  });

  it("featured accepts a featured_contents projection", () => {
    allows(
      "featured",
      'select "id", "title" from "featured_contents" where "featured_contents"."is_published" = $1',
      featuredFields("id", "title"),
    );
  });

  it("featured accepts the edit-form timestamp-text read", () => {
    allows("featured", FEATURED_EDIT_READ, featuredFields("id", "title"));
  });
});

describe("PII-bearing reads never classify as public", () => {
  it("fixed classifications refuse any deviating statement, including member reads", () => {
    const pii = 'select "id", "discord_id" from "users" where "users"."id" = $1';
    refuses("timeouts", pii);
    refuses("join-funnel", pii);
    refuses("search-widget", pii);
    refuses("timeouts", TIMEOUTS.replace("lock_timeout", "idle_in_transaction_session_timeout"));
    refuses("join-funnel", JOIN_FUNNEL.replace('"join_attempts"', '"profiles"'));
  });

  it("going-counts refuses projections outside its count shape", () => {
    refuses("going-counts", 'select "user_id" from "rsvps" where "rsvps"."event_id" = $1');
    refuses("going-counts", GOING_COUNTS_TWO.replace("count(*)", '"user_id"'));
  });

  it("events refuses member tables outside the reviewed aggregate", () => {
    const fields = eventFields("id");
    refuses("events", 'select "id" from "profiles" where "profiles"."user_id" = $1', fields);
    refuses("events", 'select "id", "email" from "users" where "users"."id" = $1', fields);
    refuses(
      "events",
      'select "id" from "events" where "events"."id" in (select "event_id" from "rsvps" where "rsvps"."user_id" = $1)',
      fields,
    );
    refuses(
      "events",
      'select "outcome" from "join_attempts" where "join_attempts"."created_at" >= $1',
      fields,
    );
  });

  it("featured refuses member tables", () => {
    refuses(
      "featured",
      'select "id" from "featured_contents" join "profiles" on true where "featured_contents"."id" = $1',
      featuredFields("id"),
    );
  });
});

describe("validateNonSensitiveRead field provenance", () => {
  it("refuses cross-table and missing fields", () => {
    const statement = 'select "id" from "events"';
    refuses("events", statement, featuredFields("id"));
    refuses("featured", statement, eventFields("id"));
    refuses("events", statement, []);
    refuses("events", statement);
    refuses("featured", statement);
  });

  it("refuses non-column fields, which carry no owner provenance", () => {
    refuses("events", 'select "id" from "events"', [{ path: ["id"], field: "id" }]);
  });
});

describe("unknown kinds fail closed", () => {
  it("refuses unknown classifications even with otherwise-valid statements", () => {
    const unknown = (name: string) => name as unknown as NonSensitiveRead;
    refuses(unknown("members"), TIMEOUTS);
    refuses(unknown("members"), 'select "id" from "events"', eventFields("id"));
    refuses(unknown("Events"), TIMEOUTS);
    refuses(unknown(""), TIMEOUTS);
  });
});

describe("rawMemberOwner", () => {
  it("returns the owner column for the fixed member-row shapes", () => {
    expect(rawMemberOwner(MEMBER_ROW)).toBe("member_id");
    expect(rawMemberOwner(MILESTONE_ROW)).toBe("member_id");
  });

  it("returns user_id for the waitlisted self-position shape", () => {
    expect(rawMemberOwner(SELF_POSITION)).toBe("user_id");
    expect(
      rawMemberOwner(
        "select event_id, user_id, position from ( select event_id, user_id, row_number() over (partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position from rsvps where event_id in ($1) and status = 'waitlisted' ) line where user_id = $2",
      ),
    ).toBe("user_id");
  });

  it("recognizes fixed shapes after whitespace normalization", () => {
    expect(rawMemberOwner(`  ${MEMBER_ROW.replaceAll(" ", "  \n ")}  `)).toBe("member_id");
  });

  it("returns undefined for anything else, including near-misses", () => {
    expect(rawMemberOwner('select "id", "title" from "events"')).toBeUndefined();
    expect(rawMemberOwner(SELF_POSITION.replace("waitlisted", "going"))).toBeUndefined();
    expect(rawMemberOwner(MEMBER_ROW.replace("limit 1", "limit 2"))).toBeUndefined();
    expect(rawMemberOwner("")).toBeUndefined();
  });
});
