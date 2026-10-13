// Tier-0 EXPLAIN seq-scan check (REPORT-ONLY): default-planner EXPLAIN over
// the hot shapes the sibling suites do not cover, failing on a Seq Scan of a
// hot table. Extends the test/hot-path-planner.test.ts pattern: same
// representative event/RSVP volumes, same owned-schema fixture, but the
// planner runs with production defaults (no enable_seqscan = off) and the
// shapes are the uncovered ones — the viewer RSVP point lookup, event lookup
// by key, the throttle admission windows, and session resolution by token
// hash. Each shape below is emitted verbatim by the read or write path it
// names. EXPLAIN plans the bound values directly (one-shot, unprepared), so
// the suite proves an index path exists; production prepared-statement cache
// drift is out of scope.
//
// New/changed drizzle queries are covered operationally: this suite runs on
// every PR in CI (report-only), and the CI step prints the changed query
// files beside the verdict. Deliberately NOT asserted: the tab-sync liveness
// probe (`coalesce(status_hash, token_hash) = $1`) cannot use the
// status_hash btree without an expression index, so it seq-scans by
// construction; that is a follow-up migration decision, not a regression.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemberDataFixture, type MemberDataFixture } from "../test/helpers/member-data-db";

const NOW = "2026-10-01T12:00:00Z";

describe.skipIf(!process.env.DATABASE_URL)("tier-0 hot-path EXPLAIN (report-only)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];

  beforeAll(async () => {
    // Same representative volumes as the sibling planner suite: a long
    // archive plus a small live tail, plus throttle/session rows so the
    // admission shapes plan against populated indexes.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    client = fixture.client;
    await client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'past' || g, 'Past ' || g,
             ${NOW}::timestamptz - g * interval '1 day',
             ${NOW}::timestamptz - g * interval '1 day' + interval '2 hours',
             case g % 6 when 0 then 'cancelled' when 1 then 'past' else 'published' end
      from generate_series(1, 1500) g`;
    await client`
      insert into events (event_key, title, starts_at, ends_at, status)
      select 'next' || g, 'Next ' || g,
             ${NOW}::timestamptz + g * interval '1 day',
             ${NOW}::timestamptz + g * interval '1 day' + interval '2 hours', 'published'
      from generate_series(1, 30) g`;
    await client`
      insert into rsvps (event_id, user_id, status, legacy_id, created_at, synced_to_discord_at)
      select e.id, 'member' || g,
             case g % 4 when 0 then 'going' when 1 then 'waitlisted' when 2 then 'maybe' else 'not_going' end,
             100000 + g, ${NOW}::timestamptz - g * interval '1 minute',
             case when g % 97 = 0 then null else ${NOW}::timestamptz end
      from events e cross join generate_series(1, 100) g where e.id <= 120 or e.event_key = 'next1'`;
    // web_throttle_hits and its composite index come from the canonical
    // migrations the fixture already runs; only rows are seeded here.
    await client`
      insert into web_throttle_hits (bucket, at)
      select 'rsvp:' || (g % 7), ${NOW}::timestamptz - (g % 300) * interval '1 second'
      from generate_series(1, 500) g`;
    await client`
      insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
      select md5('session' || g), 'user' || g, 'User ' || g, true, false,
             ${NOW}::timestamptz + interval '1 hour'
      from generate_series(1, 2000) g`;
    await client`analyze events`;
    await client`analyze rsvps`;
    await client`analyze web_throttle_hits`;
    await client`analyze web_sessions`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  /** Default planner: EXPLAIN without ANALYZE reads no rows and writes nothing. */
  async function plan(statement: string, params: (string | number)[] = []): Promise<string> {
    const rows = await client.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  /** The hot tables must be reached through an index path, never a full scan. */
  function expectIndexedOn(table: string, planText: string): void {
    expect(planText, planText).toMatch(/Index Scan|Bitmap Heap Scan/);
    expect(planText, planText).not.toMatch(new RegExp(`Seq Scan on ${table}`));
  }

  it("resolves the viewer RSVP lookup through the unique event-user index", async () => {
    expectIndexedOn(
      "rsvps",
      await plan("select id, status from rsvps where event_id = $1 and user_id = $2", [
        1,
        "member1",
      ]),
    );
  });

  it("resolves the event detail lookup through the unique key index", async () => {
    expectIndexedOn("events", await plan("select id from events where event_key = $1", ["next1"]));
  });

  it("counts the throttle admission windows through the composite bucket index", async () => {
    expectIndexedOn(
      "web_throttle_hits",
      await plan(
        `select count(*) from web_throttle_hits
         where bucket = $1 and at > clock_timestamp() - interval '60 seconds'`,
        ["rsvp:1"],
      ),
    );
    // The RSVP write path parameterizes the decay; the index applicability
    // is the same bucket-equality plus at-range shape.
    expectIndexedOn(
      "web_throttle_hits",
      await plan(
        `select count(*) from web_throttle_hits
         where bucket = $1 and at > clock_timestamp() - make_interval(secs => $2)`,
        ["rsvp:1", 60],
      ),
    );
  });

  it("resolves the session row through the token-hash primary key", async () => {
    const [row] = await client<
      { token_hash: string }[]
    >`select token_hash from web_sessions limit 1`;
    expectIndexedOn(
      "web_sessions",
      await plan(
        `select user_id from web_sessions
         where token_hash = $1 and revoked_at is null and expires_at > now()`,
        [row!.token_hash],
      ),
    );
  });
});
