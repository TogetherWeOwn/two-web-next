// Ports HotPathIndexTest.php; all DDL/data stays in the guarded disposable schema.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { PgDialect, getTableConfig } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events, rsvps } from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import { JOIN_ATTEMPT_RETENTION_DAYS } from "../src/jobs/constants";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const NOW = "2026-10-01T12:00:00Z";
const expectedIndexes = [
  { name: "rsvps_event_id_status_index", table: rsvps, columns: ["event_id", "status"] },
  { name: "rsvps_unsynced_event_id_index", table: rsvps, columns: ["event_id"] },
  { name: "events_ends_at_index", table: events, columns: ["ends_at"] },
  { name: "events_starts_at_id_index", table: events, columns: ["starts_at", "id"] },
  { name: "join_attempts_outcome_index", table: joinAttempts, columns: ["outcome"] },
];

it("declares the five legacy-named indexes in the Drizzle schema", () => {
  for (const { name, table, columns } of expectedIndexes) {
    const declared = getTableConfig(table).indexes.find((index) => index.config.name === name);
    expect(declared, name).toBeDefined();
    expect(declared!.config.columns.map((column) => "name" in column ? column.name : null)).toEqual(columns);
    if (name === "rsvps_unsynced_event_id_index") {
      expect(new PgDialect().sqlToQuery(declared!.config.where!).sql).toMatch(/"synced_to_discord_at" is null/i);
    } else {
      expect(declared!.config.where).toBeUndefined();
    }
  }
});

describe.skipIf(!process.env.DATABASE_URL)("hot-path indexes (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let client: MemberDataFixture["client"];
  let eventId: number;

  beforeAll(async () => {
    // Applies the full journal to a fresh schema, including this migration.
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    client = fixture.client;
    // A long archive plus a small live tail makes the event range/order plans stable.
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
    // Retained outcome batches keep the grouping path competitive with the date index.
    // These forced plans prove usability, not the winning plan for interleaved production rows.
    await client`
      insert into join_attempts (outcome, created_at)
      select case g % 3 when 0 then 'joined' when 1 then 'failed' else 'already_member' end,
             ${NOW}::timestamptz - (g % 28) * interval '1 day'
      from generate_series(1, 12000) g order by 1, g`;
    await client`analyze events`;
    await client`analyze rsvps`;
    await client`analyze join_attempts`;
  });
  afterAll(async () => { await fixture?.dispose(); });

  it("creates all five exact index definitions on a fresh migrated schema", async () => {
    const indexes = await client<{ tablename: string; indexname: string; indexdef: string }[]>`
      select tablename, indexname, indexdef from pg_indexes where schemaname = ${fixture.schemaName}`;
    for (const { name, table, columns } of expectedIndexes) {
      const found = indexes.find((index) => index.indexname === name);
      expect(found, name).toBeDefined();
      expect(found!.tablename).toBe(getTableConfig(table).name);
      expect(found!.indexdef).toContain(`USING btree (${columns.join(", ")})`);
      if (name === "rsvps_unsynced_event_id_index") {
        expect(found!.indexdef).toContain("WHERE (synced_to_discord_at IS NULL)");
      } else {
        expect(found!.indexdef).not.toContain("WHERE");
      }
    }
  });

  it("applies twice over pre-existing legacy indexes without replacing them or losing rows", async () => {
    const migration = await readFile(fileURLToPath(new URL("../drizzle/1013_hot-path-indexes.sql", import.meta.url).href), "utf8");
    await client.begin(async (tx) => {
      // Recreate the independent legacy definitions before applying the new migration.
      // These are only the fixture's indexes, not anything in public or another test schema.
      for (const { name, table, columns } of expectedIndexes) {
        await tx.unsafe(`drop index "${name}"`);
        const predicate = name === "rsvps_unsynced_event_id_index" ? " WHERE synced_to_discord_at IS NULL" : "";
        await tx.unsafe(`create index "${name}" on "${getTableConfig(table).name}" (${columns.join(", ")})${predicate}`);
      }
      const snapshot = () => tx`
        select c.relname, c.oid, i.indexdef from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
        join pg_indexes i on i.schemaname = n.nspname and i.indexname = c.relname
        where n.nspname = ${fixture.schemaName} and c.relname in ${tx(expectedIndexes.map((index) => index.name))}
        order by c.relname`;
      const rowCounts = () => tx`
        select (select count(*) from events) as events,
               (select count(*) from rsvps) as rsvps,
               (select count(*) from join_attempts) as attempts`;
      const before = await snapshot();
      const counts = await rowCounts();
      expect(before).toHaveLength(5);
      for (let pass = 0; pass < 2; pass++) {
        for (const statement of migration.split("--> statement-breakpoint")) await tx.unsafe(statement);
        expect(await snapshot()).toEqual(before);
        expect(await rowCounts()).toEqual(counts);
      }
    });
  });

  async function plan(statement: string, params: (string | number)[] = []): Promise<string> {
    return client.begin(async (tx) => {
      // Prove usable access paths, not production cost superiority on a small fixture.
      // SET LOCAL prevents this forced planner setting leaking into other tests/queries.
      await tx`set local enable_seqscan = off`;
      const rows = await tx.unsafe<{ "QUERY PLAN": string }[]>(`EXPLAIN ${statement}`, params);
      return rows.map((row) => row["QUERY PLAN"]).join("\n");
    });
  }

  it("uses the composite RSVP index for going count and batched page counts", async () => {
    expect(await plan("select count(*) from rsvps where event_id = $1 and status = 'going'", [eventId]))
      .toContain("rsvps_event_id_status_index");
    expect(await plan("select event_id, count(*) from rsvps where event_id in ($1, $2) and status = 'going' group by event_id", [eventId, 1]))
      .toContain("rsvps_event_id_status_index");
  });

  it("uses the composite RSVP index for the FIFO head and locked waitlist", async () => {
    for (const limit of ["limit 5", ""]) {
      expect(await plan(`select id from rsvps where event_id = $1 and status = 'waitlisted'
        order by created_at, coalesce(legacy_id, id), id ${limit} for update`, [eventId]))
        .toContain("rsvps_event_id_status_index");
    }
  });

  it("uses the composite RSVP index for Next's batched waitlist-position window", async () => {
    expect(await plan(`select event_id, position from (
      select event_id, user_id, row_number() over (
        partition by event_id order by created_at, coalesce(legacy_id, id), id)::int as position
      from rsvps where event_id in ($1, $2) and status = 'waitlisted'
      ) line where user_id = $3`, [eventId, 1, "member1"]))
      .toContain("rsvps_event_id_status_index");
    expect(await plan(`select count(*) from rsvps where event_id = $1 and status = 'waitlisted'
      and (created_at < $2 or (created_at = $2 and id <= $3))`, [eventId, NOW, 1]))
      .toContain("rsvps_event_id_status_index");
  });

  it("uses the partial RSVP index for the legacy unsynced event probe", async () => {
    expect(await plan("select * from rsvps where event_id = $1 and synced_to_discord_at IS NULL", [eventId]))
      .toContain("rsvps_unsynced_event_id_index");
  });

  it("uses ends_at for Next's unlimited upcoming calendar and the legacy bounded listing", async () => {
    for (const limit of ["", "limit 20"]) {
      expect(await plan(`select * from events where ends_at >= $1 and status <> 'draft' order by starts_at ${limit}`, [NOW]))
        .toContain("events_ends_at_index");
    }
  });

  it("uses starts_at/id for the calendar past drawer and paginated archive", async () => {
    expect(await plan("select * from events where ends_at < $1 and status <> 'draft' order by starts_at desc, id desc limit 20", [NOW]))
      .toContain("events_starts_at_id_index");
    expect(await plan(`select * from events where status = 'past' or (status = 'published' and ends_at < $1)
      order by starts_at desc, id desc limit 21 offset 20`, [NOW]))
      .toContain("events_starts_at_id_index");
  });

  it("uses starts_at/id for both directions of the legacy neighbour shape", async () => {
    for (const [comparison, direction] of [[">", "asc"], ["<", "desc"]]) {
      expect(await plan(`select id from events where status <> 'draft' and status <> 'cancelled'
        and (starts_at ${comparison} $1 or (starts_at = $1 and id ${comparison} $2))
        order by starts_at ${direction}, id ${direction} limit 1`, [NOW, eventId]))
        .toContain("events_starts_at_id_index");
    }
  });

  it("uses the outcome index for Next's retained funnel group-by", async () => {
    const cutoff = new Date(Date.parse(NOW) - JOIN_ATTEMPT_RETENTION_DAYS * 86_400_000).toISOString();
    expect(await plan("select outcome, count(*) from join_attempts where created_at >= $1 group by outcome", [cutoff]))
      .toContain("join_attempts_outcome_index");
  });
});
