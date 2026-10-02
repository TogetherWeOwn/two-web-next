// Ledger A6 follow-up: the sibling hot-path-indexes suite forces
// `enable_seqscan = off`, proving usable index paths rather than production
// cost superiority. This suite runs the same Going-count / waitlist /
// unsynced / upcoming / archive / neighbour shapes with the default planner
// on representative seeded volumes and asserts index usage (no Seq Scan on
// the hot tables). Test-only; no src changes.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = "2026-10-01T12:00:00Z";

describe.skipIf(!process.env.DATABASE_URL)("hot-path planner (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];
  let eventId: number;

  beforeAll(async () => {
    // Same representative volumes as the forced-plan sibling: a long archive
    // plus a small live tail keeps the event range/order plans stable.
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
    const [event] = await client<{ id: number }[]>`select id from events where event_key = 'next1'`;
    eventId = event!.id;
    await client`
      insert into rsvps (event_id, user_id, status, legacy_id, created_at, synced_to_discord_at)
      select e.id, 'member' || g,
             case g % 4 when 0 then 'going' when 1 then 'waitlisted' when 2 then 'maybe' else 'not_going' end,
             100000 + g, ${NOW}::timestamptz - g * interval '1 minute',
             case when g % 97 = 0 then null else ${NOW}::timestamptz end
      from events e cross join generate_series(1, 100) g where e.id <= 120 or e.id = ${eventId}`;
    await client`analyze events`;
    await client`analyze rsvps`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  /** Default planner: no forced settings, unlike the sibling suite. */
  async function plan(statement: string, params: (string | number)[] = []): Promise<string> {
    const rows = await client.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, params);
    return rows.map((row) => row["QUERY PLAN"]).join("\n");
  }

  /** The hot tables must be reached through an index path, never a full scan. */
  function expectIndexedOn(table: string, planText: string): void {
    expect(planText, planText).toMatch(/Index Scan|Bitmap Heap Scan/);
    expect(planText, planText).not.toMatch(new RegExp(`Seq Scan on ${table}`));
  }

  it("picks the composite RSVP index for going count and batched page counts", async () => {
    expectIndexedOn(
      "rsvps",
      await plan("select count(*) from rsvps where event_id = $1 and status = 'going'", [eventId]),
    );
    expectIndexedOn(
      "rsvps",
      await plan(
        "select event_id, count(*) from rsvps where event_id in ($1, $2) and status = 'going' group by event_id",
        [eventId, 1],
      ),
    );
  });

  it("picks the composite RSVP index for the FIFO head and locked waitlist", async () => {
    for (const limit of ["limit 5", ""]) {
      expectIndexedOn(
        "rsvps",
        await plan(
          `select id from rsvps where event_id = $1 and status = 'waitlisted'
          order by created_at, coalesce(legacy_id, id), id ${limit} for update`,
          [eventId],
        ),
      );
    }
  });

  it("picks the composite RSVP index for Next's batched waitlist-position window", async () => {
    expectIndexedOn(
      "rsvps",
      await plan(
        `select event_id, position from (
        select event_id, user_id, row_number() over (
          partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position
        from rsvps where event_id in ($1, $2) and status = 'waitlisted'
        ) line where user_id = $3`,
        [eventId, 1, "member1"],
      ),
    );
    expectIndexedOn(
      "rsvps",
      await plan(
        `select count(*) from rsvps where event_id = $1 and status = 'waitlisted'
        and (created_at < $2 or (created_at = $2 and id <= $3))`,
        [eventId, NOW, 1],
      ),
    );
  });

  it("picks the partial RSVP index for the legacy unsynced event probe", async () => {
    expectIndexedOn(
      "rsvps",
      await plan("select * from rsvps where event_id = $1 and synced_to_discord_at IS NULL", [
        eventId,
      ]),
    );
  });

  it("picks ends_at for Next's unlimited upcoming calendar and the legacy bounded listing", async () => {
    for (const limit of ["", "limit 20"]) {
      expectIndexedOn(
        "events",
        await plan(
          `select * from events where ends_at >= $1 and status <> 'draft' order by starts_at ${limit}`,
          [NOW],
        ),
      );
    }
  });

  it("picks starts_at/id for the calendar past drawer and paginated archive", async () => {
    expectIndexedOn(
      "events",
      await plan(
        "select * from events where ends_at < $1 and status <> 'draft' order by starts_at desc, id desc limit 20",
        [NOW],
      ),
    );
    expectIndexedOn(
      "events",
      await plan(
        `select * from events where status = 'past' or (status = 'published' and ends_at < $1)
        order by starts_at desc, id desc limit 21 offset 20`,
        [NOW],
      ),
    );
  });

  it("picks starts_at/id for both directions of the legacy neighbour shape", async () => {
    for (const [comparison, direction] of [
      [">", "asc"],
      ["<", "desc"],
    ]) {
      expectIndexedOn(
        "events",
        await plan(
          `select id from events where status <> 'draft' and status <> 'cancelled'
          and (starts_at ${comparison} $1 or (starts_at = $1 and id ${comparison} $2))
          order by starts_at ${direction}, id ${direction} limit 1`,
          [NOW, eventId],
        ),
      );
    }
  });
});
