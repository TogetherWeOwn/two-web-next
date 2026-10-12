// Ledger A6: hot-path-indexes.test.ts forces `enable_seqscan = off`, which proves
// the indexes are usable, not that the planner prefers them. This suite runs the
// same shapes (hot-path-indexes.test.ts:148-241) on the same fixture volumes with
// every planner setting at its default and pins the named index for each shape.
// It then drops that index inside a rolled-back transaction and requires the
// planner's own cost to rise, so the index is shown to win rather than to be
// incidental. hot-path-planner.test.ts only asserts "some index, no Seq Scan",
// which the fallback indexes (rsvps_event_user_unique, events_status_starts_at_idx)
// satisfy without the hot-path index. If a shape stops choosing its index, report
// the EXPLAIN output; do not force the plan here.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = "2026-10-01T12:00:00Z";

type Param = string | number;
interface Shape {
  name: string;
  index: string;
  sql: string;
  params: (eventId: number) => Param[];
}

const rsvpIndex = "rsvps_event_id_status_index";
const waitlistOrder = "order by created_at, coalesce(legacy_id, id), id";
const neighbour = (comparison: ">" | "<", direction: "asc" | "desc") =>
  `select id from events where status <> 'draft' and status <> 'cancelled'
   and (starts_at ${comparison} $1 or (starts_at = $1 and id ${comparison} $2))
   order by starts_at ${direction}, id ${direction} limit 1`;

const shapes: Shape[] = [
  {
    name: "going count",
    index: rsvpIndex,
    sql: "select count(*) from rsvps where event_id = $1 and status = 'going'",
    params: (eventId) => [eventId],
  },
  {
    name: "batched page going counts",
    index: rsvpIndex,
    sql: "select event_id, count(*) from rsvps where event_id in ($1, $2) and status = 'going' group by event_id",
    params: (eventId) => [eventId, 1],
  },
  {
    name: "FIFO waitlist head",
    index: rsvpIndex,
    sql: `select id from rsvps where event_id = $1 and status = 'waitlisted' ${waitlistOrder} limit 5 for update`,
    params: (eventId) => [eventId],
  },
  {
    name: "locked waitlist",
    index: rsvpIndex,
    sql: `select id from rsvps where event_id = $1 and status = 'waitlisted' ${waitlistOrder} for update`,
    params: (eventId) => [eventId],
  },
  {
    name: "batched waitlist-position window",
    index: rsvpIndex,
    sql: `select event_id, position from (
      select event_id, user_id, row_number() over (
        partition by event_id ${waitlistOrder})::int as position
      from rsvps where event_id in ($1, $2) and status = 'waitlisted'
      ) line where user_id = $3`,
    params: (eventId) => [eventId, 1, "member1"],
  },
  {
    name: "waitlist position count",
    index: rsvpIndex,
    sql: `select count(*) from rsvps where event_id = $1 and status = 'waitlisted'
      and (created_at < $2 or (created_at = $2 and id <= $3))`,
    params: (eventId) => [eventId, NOW, 1],
  },
  {
    name: "legacy unsynced event probe",
    index: "rsvps_unsynced_event_id_index",
    sql: "select * from rsvps where event_id = $1 and synced_to_discord_at IS NULL",
    params: (eventId) => [eventId],
  },
  {
    name: "unlimited upcoming calendar",
    index: "events_ends_at_index",
    sql: "select * from events where ends_at >= $1 and status <> 'draft' order by starts_at",
    params: () => [NOW],
  },
  {
    name: "bounded upcoming listing",
    index: "events_ends_at_index",
    sql: "select * from events where ends_at >= $1 and status <> 'draft' order by starts_at limit 20",
    params: () => [NOW],
  },
  {
    name: "calendar past drawer",
    index: "events_starts_at_id_index",
    sql: "select * from events where ends_at < $1 and status <> 'draft' order by starts_at desc, id desc limit 20",
    params: () => [NOW],
  },
  {
    name: "paginated archive",
    index: "events_starts_at_id_index",
    sql: `select * from events where status = 'past' or (status = 'published' and ends_at < $1)
      order by starts_at desc, id desc limit 21 offset 20`,
    params: () => [NOW],
  },
  {
    name: "legacy neighbour, ascending",
    index: "events_starts_at_id_index",
    sql: neighbour(">", "asc"),
    params: (eventId) => [NOW, eventId],
  },
  {
    name: "legacy neighbour, descending",
    index: "events_starts_at_id_index",
    sql: neighbour("<", "desc"),
    params: (eventId) => [NOW, eventId],
  },
];

describe.skipIf(!process.env.DATABASE_URL)("hot-path planner cost (default planner)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];
  let eventId: number;

  beforeAll(async () => {
    // Same volumes as hot-path-indexes.test.ts: a long archive and a small live
    // tail, so cost comparisons here match the forced suite's data.
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

  class Rollback extends Error {}

  /** EXPLAIN under the session's own planner settings; optionally without one index. */
  async function explain(
    shape: Shape,
    withoutIndex?: string,
  ): Promise<{ text: string; totalCost: number }> {
    let result: { text: string; totalCost: number } | undefined;
    try {
      await client.begin(async (tx) => {
        // DDL is transactional: the drop is invisible outside this transaction
        // and is rolled back below, inside the fixture's own schema.
        if (withoutIndex) await tx.unsafe(`drop index "${fixture.schemaName}"."${withoutIndex}"`);
        const params = shape.params(eventId);
        const text = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${shape.sql}`, params);
        const json = await tx.unsafe<{ "QUERY PLAN": { Plan: { "Total Cost": number } }[] }[]>(
          `EXPLAIN (FORMAT JSON) ${shape.sql}`,
          params,
        );
        result = {
          text: text.map((row) => row["QUERY PLAN"]).join("\n"),
          totalCost: json[0]!["QUERY PLAN"][0]!.Plan["Total Cost"],
        };
        throw new Rollback();
      });
    } catch (error) {
      if (!(error instanceof Rollback)) throw error;
    }
    return result!;
  }

  it("runs with every enable_* planner setting at its default", async () => {
    // A server, role or database override would turn this into another forced-plan test.
    const forced = await client<{ name: string; setting: string }[]>`
      select name, setting from pg_settings
      where name like 'enable\_%' and setting is distinct from boot_val`;
    expect(forced).toEqual([]);
  });

  it.each(shapes)("$name chooses $index", async (shape) => {
    const { text } = await explain(shape);
    expect(text, text).toContain(shape.index);
    expect(text, text).not.toMatch(/Seq Scan/);
  });

  it.each(shapes)("$name costs more without $index", async (shape) => {
    const withIndex = await explain(shape);
    const without = await explain(shape, shape.index);
    expect(without.text).not.toContain(shape.index);
    expect(
      without.totalCost,
      `with:\n${withIndex.text}\nwithout:\n${without.text}`,
    ).toBeGreaterThan(withIndex.totalCost);
  });
});
