// Portable port of two-web@2eaefb8 tests/Feature/Events/EventScheduleTest.php:58-90.
// The Laravel rollback/reapply is framework-specific; what must survive cutover is
// the backfilled row itself: its ULID key, the 'UTC' zone default and the
// start/end pair (ends_at = starts_at + 2 hours, naive starts read as UTC).
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
// @ts-expect-error standalone mjs has no type declarations
import { importEventsRsvps } from "../bin/import/events-rsvps.mjs";

const url = process.env.DATABASE_URL;
const fixtureSql = readFileSync(new URL("./fixtures/legacy/events-rsvps.sql", import.meta.url), "utf8");
// Str::ulid(): 26 Crockford base32 characters, 48-bit time prefix (first char 0-7).
const ulidPattern = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
// Synthetic stand-ins for the per-row Str::ulid() the correction migration assigned.
const shippedKey = "01J2ZB2X5X3Q8T1V9W4Y6Z7A8B";
const dstKey = "01J2ZB2X5X3Q8T1V9W4Y6Z7A8C";
// Session-independent UTC text with all six fractional digits.
const utc = (column: string) => `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as ${column}`;
const schedule = (sql: ReturnType<typeof postgres>) => sql.unsafe(`event_key, timezone, game, ${utc("starts_at")}, ${utc("ends_at")}`);

describe.skipIf(!url)("portable legacy event backfill import (EventScheduleTest.php:58-90)", () => {
  let fixture: MemberDataFixture;
  let legacy: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let legacySchema: string;

  // Reproduce a row written before 2026_08_25_000100_correct_events_schema and the
  // correction's own backfill statements, on the frozen fixture schema. Only the
  // time-column types and the two NOT NULLs are rolled back; key/game/zone columns
  // stay, and omitting them on insert gives the column defaults the migration added.
  async function backfillShippedRows(rows: Array<{ key: string; startsAt: string }>) {
    await legacy.begin(async (sql) => {
      await sql`alter table events alter column ends_at drop not null`;
      await sql`alter table events alter column starts_at type timestamp using starts_at at time zone 'UTC'`;
      await sql`alter table events alter column ends_at type timestamp using ends_at at time zone 'UTC'`;
      await sql`alter table events alter column event_key drop not null`;
      for (const row of rows) {
        await sql`insert into events (title, starts_at, ends_at, status, created_at, updated_at)
          values ('Shipped before this migration existed', ${row.startsAt}::text::timestamp, null, 'draft',
            '2026-07-01 12:00:00', '2026-07-01 12:00:00')`;
        await sql`update events set event_key = ${row.key}
          where id = (select min(id) from events where event_key is null)`;
      }
      await sql`update events set ends_at = starts_at + interval '2 hours' where ends_at is null`;
      await sql`alter table events alter column starts_at type timestamptz using starts_at at time zone 'UTC'`;
      await sql`alter table events alter column ends_at type timestamptz using ends_at at time zone 'UTC'`;
      await sql`alter table events alter column event_key set not null`;
      await sql`alter table events alter column ends_at set not null`;
    });
  }

  const legacyRows = () => legacy`select ${schedule(legacy)} from events order by event_key`;
  const targetRows = () => target`select ${schedule(target)} from events order by event_key`;

  beforeAll(async () => {
    const safe = testDatabaseUrl(url!);
    if (safe.hostname === "agent-testdb" && safe.pathname !== "/two_web_next") {
      throw new Error("Importer fixtures require the two_web_next test database");
    }
    fixture = await createMemberDataFixture(safe.href);
    legacySchema = `${fixture.schemaName}_legacy`;
    // Sessions are Pacific/Honolulu (legacy) and Asia/Tokyo (target). A hostile
    // destination default proves every imported 'UTC' zone came from legacy.
    ({ legacy, target } = createImportFixtureClients(safe.href, legacySchema, fixture.schemaName));
    await target`alter table events alter column timezone set default 'Pacific/Honolulu'`;
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
    await fixture.client`create schema ${fixture.client(legacySchema)}`;
    await legacy.unsafe(fixtureSql.replaceAll("legacy.", `"${legacySchema}".`));
    await target`insert into users (id, username) values
      ('100000000000000901', 'Synthetic going'), ('100000000000000902', 'Synthetic waitlisted')`;
  });

  afterAll(async () => {
    await Promise.all([legacy?.end(), target?.end()]);
    if (fixture) {
      try {
        await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
      } finally {
        await fixture.dispose();
      }
    }
  });

  it("imports a backfilled shipped row with its ULID, default UTC zone and start/end pair", async () => {
    await backfillShippedRows([{ key: shippedKey, startsAt: "2026-07-15 19:00:00" }]);
    const [source] = await legacy`select ${schedule(legacy)} from events where event_key = ${shippedKey}`;
    // The legacy expectations at EventScheduleTest.php:83-89, read session-independently.
    expect(source).toEqual({
      event_key: shippedKey,
      timezone: "UTC",
      game: null,
      starts_at: "2026-07-15T19:00:00.000000Z",
      ends_at: "2026-07-15T21:00:00.000000Z",
    });
    expect(source!.event_key).toMatch(ulidPattern);

    const dry = await importEventsRsvps(legacy, target);
    expect(dry.events).toMatchObject({ read: 5, inserted: 5, updated: 0 });
    expect(await target`select * from events`).toHaveLength(0);

    await importEventsRsvps(legacy, target, { dryRun: false });
    const [imported] = await target`select ${schedule(target)}, status from events where event_key = ${shippedKey}`;
    expect(imported).toEqual({ ...source, status: "draft" });
    expect(await targetRows()).toEqual(await legacyRows());

    const replay = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(replay.events).toMatchObject({ read: 5, inserted: 0, updated: 0, unchanged: 5 });
  });

  it("preserves every legacy ULID verbatim and keeps native IDs when the key already exists", async () => {
    await backfillShippedRows([{ key: shippedKey, startsAt: "2026-07-15 19:00:00" }]);
    // A Next row already holding the legacy key is updated in place, never re-keyed.
    await target`insert into events (id, event_key, title, starts_at, ends_at, timezone)
      values (700, ${shippedKey}, 'Native copy', '2026-07-15T19:00:00Z', '2026-07-15T21:00:00Z', 'Europe/London')`;
    await importEventsRsvps(legacy, target, { dryRun: false });
    const keys = (await legacy`select event_key from events order by event_key`).map((row) => row.event_key);
    expect(keys).toHaveLength(5);
    for (const key of keys) expect(key).toMatch(ulidPattern);
    expect((await target`select event_key from events order by event_key`).map((row) => row.event_key)).toEqual(keys);
    expect(await target`select id, timezone from events where event_key = ${shippedKey}`).toEqual([{ id: 700, timezone: "UTC" }]);
  });

  it("preserves microsecond start/end pairs across the backfill's two-hour default and a DST change", async () => {
    // Europe/London leaves BST at 2026-10-25 01:00 UTC; the absolute two hours must hold.
    await backfillShippedRows([
      { key: shippedKey, startsAt: "2026-07-15 19:00:00.123456" },
      { key: dstKey, startsAt: "2026-10-25 00:30:00.000001" },
    ]);
    await importEventsRsvps(legacy, target, { dryRun: false });
    const imported = await target`select ${schedule(target)}, extract(epoch from ends_at - starts_at)::text as seconds
      from events where event_key in (${shippedKey}, ${dstKey}) order by event_key`;
    expect(imported).toEqual([
      {
        event_key: shippedKey,
        timezone: "UTC",
        game: null,
        starts_at: "2026-07-15T19:00:00.123456Z",
        ends_at: "2026-07-15T21:00:00.123456Z",
        seconds: "7200.000000",
      },
      {
        event_key: dstKey,
        timezone: "UTC",
        game: null,
        starts_at: "2026-10-25T00:30:00.000001Z",
        ends_at: "2026-10-25T02:30:00.000001Z",
        seconds: "7200.000000",
      },
    ]);
    // Explicit fixture pairs (London series across the same DST change) also survive.
    expect(await targetRows()).toEqual(await legacyRows());
    expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(6);
  });

  it("defaults only omitted zones to UTC: legacy refuses NULL and the importer never fabricates one", async () => {
    await expect(legacy`insert into events (event_key, title, starts_at, ends_at, timezone)
      values (${dstKey}, 'Null zone', '2026-07-15T19:00:00Z', '2026-07-15T21:00:00Z', null)`).rejects.toThrow(
      /null value in column "timezone"/,
    );
    // Were the frozen constraint ever bypassed, the import fails closed with no writes.
    await legacy`alter table events alter column timezone drop not null`;
    await legacy`update events set timezone = null where event_key = '01K00000000000000000000040'`;
    for (const dryRun of [true, false]) {
      await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow("Invalid legacy event timezone");
    }
    expect(await target`select * from events`).toHaveLength(0);
    expect(await target`select * from rsvps`).toHaveLength(0);
  });
});
