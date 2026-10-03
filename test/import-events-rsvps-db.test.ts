import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { eq } from "drizzle-orm";
import { events } from "../src/db/admin-schema";
import { lockWaitlist, promoteWaitlist, waitlistPosition } from "../src/events/waitlist";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
// @ts-expect-error standalone mjs has no type declarations
import { importEventsRsvps, reportExitCode } from "../bin/import/events-rsvps.mjs";

const url = process.env.DATABASE_URL;
const parentKey = "01K00000000000000000000030";
const fixtureSql = readFileSync(
  new URL("./fixtures/legacy/events-rsvps.sql", import.meta.url),
  "utf8",
);

describe.skipIf(!url)("legacy event/RSVP import on owned test schemas", () => {
  let fixture: MemberDataFixture;
  let legacy: ReturnType<typeof postgres>;
  let target: ReturnType<typeof postgres>;
  let legacySchema: string;

  beforeAll(async () => {
    const safe = testDatabaseUrl(url!);
    if (safe.hostname === "agent-testdb" && safe.pathname !== "/two_web_next") {
      throw new Error("Importer fixtures require the two_web_next test database");
    }
    fixture = await createMemberDataFixture(safe.href);
    legacySchema = `${fixture.schemaName}_legacy`;
    ({ legacy, target } = createImportFixtureClients(safe.href, legacySchema, fixture.schemaName));
  });

  beforeEach(async () => {
    await legacy`set datestyle = 'ISO, MDY'`;
    await target`set datestyle = 'ISO, MDY'`;
    await target`alter table events enable trigger events_ics_sequence`;
    await fixture.reset();
    await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
    await fixture.client`create schema ${fixture.client(legacySchema)}`;
    await legacy.unsafe(fixtureSql.replaceAll("legacy.", `"${legacySchema}".`));
    await target`insert into users (id, username) values
      ('100000000000000901', 'Synthetic going'), ('100000000000000902', 'Synthetic waitlisted')`;
    // A pre-existing natural key with a different local ID proves FK remapping.
    await target`insert into events (id, event_key, title, starts_at, ends_at)
      values (500, ${parentKey}, 'Before import', '2026-10-18T19:00:00Z', '2026-10-18T21:00:00Z')`;
    // Owned-schema DDL can exceed the default hook budget on shared CI runners.
  }, 30_000);

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

  async function promoteImportedWaitlist(eventId: number) {
    await fixture.db.transaction(async (tx) => {
      const [ev] = await tx.select().from(events).where(eq(events.id, eventId)).for("update");
      await lockWaitlist(tx, eventId);
      await promoteWaitlist(tx, ev!, () => new Date("2026-10-01T00:00:00Z"));
    });
  }

  it("dry-run reads and counts but changes neither rows nor sequences", async () => {
    const before = await target`select * from events order by id`;
    const sequence = await target`select last_value, is_called from events_id_seq`;
    const report = await importEventsRsvps(legacy, target);
    expect(report.events).toEqual({ read: 4, inserted: 3, updated: 1, unchanged: 0, orphaned: 0 });
    expect(report.rsvps).toEqual({ read: 4, inserted: 3, updated: 0, unchanged: 0, orphaned: 1 });
    expect(report.unresolved).toEqual({ creators: 0, rsvpEvents: 0, rsvpUsers: 1 });
    expect(reportExitCode(report)).toBe(2);
    expect(await target`select * from events order by id`).toEqual(before);
    expect(await target`select last_value, is_called from events_id_seq`).toEqual(sequence);
    expect(await target`select * from rsvps`).toHaveLength(0);
  });

  it("preserves series, cancelled/past status, UTC stamps, pause and waitlist; replay is unchanged", async () => {
    const sourceBefore = await legacy`select * from events order by id`;
    await importEventsRsvps(legacy, target, { dryRun: false });
    const [parent] = await target`select * from events where event_key = ${parentKey}`;
    expect(parent).toMatchObject({
      id: 500,
      title: "Synthetic Sunday series",
      game: "Synthetic game",
      description: "Synthetic description",
      location: "Synthetic voice room",
      capacity: 1,
      status: "published",
      timezone: "Europe/London",
      rsvp_open: false,
      created_by: "100000000000000901",
      discord_event_id: "100000000000000030",
      discord_sync_failure_code: "synthetic_refusal",
      recurrence_frequency: "weekly",
      recurrence_count: 3,
      recurrence_index: 1,
      parent_event_id: null,
    });
    expect(parent!.starts_at.toISOString()).toBe("2026-10-18T19:00:00.000Z");
    expect(parent!.ends_at.toISOString()).toBe("2026-10-18T21:00:00.000Z");
    expect(parent!.discord_sync_failed_at.toISOString()).toBe("2026-09-29T12:00:00.000Z");
    expect(parent!.created_at.toISOString()).toBe("2026-09-01T09:00:00.000Z");
    const [date] = await target`select recurrence_ends_on::text from events where id = 500`;
    expect(date!.recurrence_ends_on).toBe("2026-11-01 00:00:00");
    const children =
      await target`select * from events where parent_event_id = 500 order by recurrence_index`;
    expect(children.map((row) => row.status)).toEqual(["published", "cancelled"]);
    expect(children.map((row) => row.recurrence_index)).toEqual([2, 3]);
    expect(children[0]!.starts_at.toISOString()).toBe("2026-10-25T20:00:00.000Z");
    expect(await target`select * from events where status = 'past'`).toHaveLength(1);
    const rsvps = await target`select * from rsvps order by id`;
    expect(rsvps.map((row) => row.status)).toEqual(["going", "waitlisted", "maybe"]);
    expect(rsvps[0]).toMatchObject({ user_id: "100000000000000901", event_id: children[0]!.id });
    expect(rsvps[0]!.synced_to_discord_at.toISOString()).toBe("2026-09-30T12:00:00.000Z");
    expect(rsvps[1]!.synced_to_discord_at).toBeNull();
    const eventsBefore = await target`select * from events order by id`;
    const replay = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(replay.events).toMatchObject({ unchanged: 4, inserted: 0, updated: 0 });
    expect(replay.rsvps).toMatchObject({ unchanged: 3, inserted: 0, updated: 0, orphaned: 1 });
    expect(await target`select * from events order by id`).toEqual(eventsBefore);
    expect(await target`select * from rsvps order by id`).toEqual(rsvps);
    expect(await legacy`select * from events order by id`).toEqual(sourceBefore);
    expect((await importEventsRsvps(legacy, target)).events.unchanged).toBe(4);
  });

  it.each(["O", "A"])(
    "preserves trigger mode %s and exact bigint revisions through dry-run, apply and replay",
    async (mode) => {
      if (mode === "A") await target`alter table events enable always trigger events_ics_sequence`;
      const triggerMode = async () =>
        (
          await target`select tgenabled from pg_trigger
      where tgrelid = 'events'::regclass and tgname = 'events_ics_sequence'`
        )[0]!.tgenabled;
      const before = await target`select * from events order by id`;
      const high = "9007199254740993";
      await legacy`alter table events add column ics_sequence bigint not null default 0`;
      await legacy`update events set ics_sequence = ${high}`;
      await importEventsRsvps(legacy, target);
      expect(await triggerMode()).toBe(mode);
      expect(await target`select * from events order by id`).toEqual(before);
      await importEventsRsvps(legacy, target, { dryRun: false });
      expect(await triggerMode()).toBe(mode);
      expect(
        (await target`select ics_sequence from events`).map((row) => row.ics_sequence),
      ).toEqual([high, high, high, high]);
      expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(4);
      expect(await triggerMode()).toBe(mode);
      // A native write after import must use the trigger again.
      await target`update events set title = 'Native edit' where id = 500`;
      expect((await target`select ics_sequence from events where id = 500`)[0]!.ics_sequence).toBe(
        "9007199254740994",
      );
      await legacy`update events set ics_sequence = 1, title = 'Older source edit' where id = 30`;
      await importEventsRsvps(legacy, target, { dryRun: false });
      expect((await target`select ics_sequence from events where id = 500`)[0]!.ics_sequence).toBe(
        "9007199254740995",
      );
      expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(4);
    },
  );

  it("backfills older sources from floored UTC epochs without lowering the target", async () => {
    const source = await legacy`select event_key,
      GREATEST(0, FLOOR(EXTRACT(EPOCH FROM updated_at))::bigint)::text as expected from events order by event_key`;
    await importEventsRsvps(legacy, target, { dryRun: false });
    const stored = await target`select event_key, ics_sequence from events order by event_key`;
    for (const row of stored) {
      const expected = source.find((event) => event.event_key === row.event_key)!.expected;
      expect(BigInt(row.ics_sequence)).toBeGreaterThanOrEqual(BigInt(expected));
      if (row.event_key !== parentKey) expect(row.ics_sequence).toBe(expected);
    }
    const before = await target`select event_key, ics_sequence from events order by event_key`;
    expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(4);
    expect(await target`select event_key, ics_sequence from events order by event_key`).toEqual(
      before,
    );
  });

  it.each([
    ["SQL, DMY", "ISO, MDY"],
    ["ISO, MDY", "SQL, DMY"],
    ["SQL, DMY", "German, DMY"],
    ["Postgres, DMY", "SQL, MDY"],
  ])(
    "preserves calendar dates across DateStyle source=%s destination=%s",
    async (sourceStyle, targetStyle) => {
      await legacy`select set_config('DateStyle', ${sourceStyle}, false)`;
      await target`select set_config('DateStyle', ${targetStyle}, false)`;
      const dry = await importEventsRsvps(legacy, target);
      expect(dry.events).toMatchObject({ inserted: 3, updated: 1 });
      await importEventsRsvps(legacy, target, { dryRun: false });
      const [stored] =
        await target`select to_char(recurrence_ends_on, 'YYYY-MM-DD HH24:MI:SS') as calendar
      from events where event_key = ${parentKey}`;
      expect(stored!.calendar).toBe("2026-11-01 00:00:00");
      const [source] =
        await legacy`select to_char(recurrence_ends_on, 'YYYY-MM-DD') as calendar from events where id = 30`;
      expect(source!.calendar).toBe("2026-11-01");
      for (const dryRun of [true, false]) {
        const replay = await importEventsRsvps(legacy, target, { dryRun });
        expect(replay.events).toMatchObject({ unchanged: 4, updated: 0, inserted: 0 });
      }
      await legacy`update events set recurrence_ends_on = '2026-12-02' where id = 30`;
      const update = await importEventsRsvps(legacy, target, { dryRun: false });
      expect(update.events).toMatchObject({ updated: 1, unchanged: 3 });
      expect(
        (
          await target`select to_char(recurrence_ends_on, 'YYYY-MM-DD') as calendar from events where id = 500`
        )[0]!.calendar,
      ).toBe("2026-12-02");
      expect((await importEventsRsvps(legacy, target, { dryRun: false })).events.unchanged).toBe(4);
    },
  );

  it("upserts changed content and answers without duplicating or deleting other destination rows", async () => {
    await importEventsRsvps(legacy, target, { dryRun: false });
    await target`insert into events (event_key, title, starts_at, ends_at)
      values ('synthetic-unrelated', 'Keep me', '2026-12-01T19:00:00Z', '2026-12-01T21:00:00Z')`;
    const ids = await target`select id from events order by id`;
    await legacy`update events set title = 'Synthetic edited', rsvp_open = true where id = 30`;
    await legacy`update rsvps set status = 'not_going', synced_to_discord_at = '2026-09-30 13:00:00' where id = 70`;
    const report = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(report.events).toMatchObject({ updated: 1, unchanged: 3 });
    expect(report.rsvps).toMatchObject({ updated: 1, unchanged: 2 });
    expect(await target`select id from events order by id`).toEqual(ids);
    expect(
      await target`select status from rsvps where user_id = '100000000000000901' order by id`,
    ).toMatchObject([{ status: "not_going" }, { status: "maybe" }]);
  });

  it("reports orphans and recovers them after the missing member is imported", async () => {
    const first = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(first.rsvps.orphaned).toBe(1);
    await target`insert into users (id, username) values ('100000000000000903', 'Synthetic recovered')`;
    const retry = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(retry.rsvps).toMatchObject({ inserted: 1, unchanged: 3, orphaned: 0 });
    expect(reportExitCode(retry)).toBe(0);
    expect(await target`select user_id from rsvps where event_id = 500`).toMatchObject([
      { user_id: "100000000000000903" },
    ]);
  });

  it("preserves equal-time FIFO when the earlier member recovers after the later one", async () => {
    await legacy`update rsvps set status = 'waitlisted', created_at = '2026-09-30 11:01:00' where id in (70, 71)`;
    await target`delete from users where id = '100000000000000901'`;
    const first = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(first.rsvps.orphaned).toBe(3);
    const later = await target`select id, legacy_id from rsvps`;
    expect(later).toMatchObject([{ legacy_id: "71" }]);
    await target`insert into users (id, username) values
      ('100000000000000901', 'Synthetic recovered earlier'), ('100000000000000903', 'Synthetic recovered parent RSVP')`;
    const recovered = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(reportExitCode(recovered)).toBe(0);
    const ordered =
      await target`select r.user_id, r.legacy_id from rsvps r join events e on e.id = r.event_id
      where e.event_key = '01K00000000000000000000010' and r.status = 'waitlisted'
      order by r.created_at, coalesce(r.legacy_id, r.id), r.id`;
    expect(ordered.map((row) => row.user_id)).toEqual(["100000000000000901", "100000000000000902"]);
    expect(ordered.map((row) => row.legacy_id)).toEqual(["70", "71"]);
    expect((await target`select id from rsvps where legacy_id = 71`)[0]!.id).toBe(later[0]!.id);
    const replay = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(replay.rsvps).toMatchObject({ unchanged: 4, inserted: 0, updated: 0 });
    const [child] =
      await target`select id from events where event_key = '01K00000000000000000000010'`;
    expect(await waitlistPosition(fixture.db, child!.id, "100000000000000901")).toBe(1);
    expect(await waitlistPosition(fixture.db, child!.id, "100000000000000902")).toBe(2);
    await promoteImportedWaitlist(child!.id);
    expect(
      await target`select user_id from rsvps where event_id = ${child!.id} and status = 'going'`,
    ).toMatchObject([{ user_id: "100000000000000901" }]);
  });

  it("backfills exact bigint ordering on existing pairs without renumbering or deleting native rows", async () => {
    const earlierId = "9007199254740993",
      laterId = "9007199254740994";
    await legacy`update rsvps set id = ${earlierId}, status = 'waitlisted', created_at = '2026-09-30 11:01:00' where id = 70`;
    await legacy`update rsvps set id = ${laterId}, status = 'waitlisted', created_at = '2026-09-30 11:01:00' where id = 71`;
    await target`insert into events (id, event_key, title, starts_at, ends_at)
      values (600, '01K00000000000000000000010', 'Synthetic existing child', '2026-10-25T20:00:00Z', '2026-10-25T22:00:00Z')`;
    const [existing] = await target`insert into rsvps (event_id, user_id, status, created_at)
      values (600, '100000000000000902', 'waitlisted', '2026-09-30 11:01:00+00') returning id`;
    const [native] = await target`insert into rsvps (event_id, user_id, status, created_at)
      values (600, 'synthetic-native', 'waitlisted', '2026-09-30 11:00:00+00') returning *`;
    const dry = await importEventsRsvps(legacy, target);
    expect(dry.rsvps.updated).toBe(1);
    expect(
      (await target`select legacy_id from rsvps where id = ${existing!.id}`)[0]!.legacy_id,
    ).toBeNull();
    await importEventsRsvps(legacy, target, { dryRun: false });
    const ordered = await target`select user_id, legacy_id from rsvps where event_id = 600
      order by created_at, coalesce(legacy_id, id), id`;
    expect(ordered.map((row) => row.user_id)).toEqual([
      "synthetic-native",
      "100000000000000901",
      "100000000000000902",
    ]);
    expect(ordered.map((row) => row.legacy_id)).toEqual([null, earlierId, laterId]);
    expect((await target`select id from rsvps where user_id = '100000000000000902'`)[0]!.id).toBe(
      existing!.id,
    );
    expect((await target`select * from rsvps where id = ${native!.id}`)[0]).toEqual(native);
    const replay = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(replay.rsvps).toMatchObject({ unchanged: 3, updated: 0 });
    expect(await waitlistPosition(fixture.db, 600, "synthetic-native")).toBe(1);
    expect(await waitlistPosition(fixture.db, 600, "100000000000000901")).toBe(2);
    expect(await waitlistPosition(fixture.db, 600, "100000000000000902")).toBe(3);
    await target`update events set capacity = 2 where id = 600`;
    await promoteImportedWaitlist(600);
    const promoted =
      await target`select user_id from rsvps where event_id = 600 and status = 'going' order by created_at`;
    expect(promoted.map((row) => row.user_id)).toEqual(["synthetic-native", "100000000000000901"]);
    expect(await waitlistPosition(fixture.db, 600, "100000000000000902")).toBe(1);
  });

  it("rejects conflicting source identity without partially updating the destination", async () => {
    await importEventsRsvps(legacy, target, { dryRun: false });
    await legacy`update events set title = 'Synthetic must roll back' where id = 30`;
    await legacy`update rsvps set id = 800 where id = 70`;
    const before = await target`select * from events order by id`;
    const beforeRsvps = await target`select * from rsvps order by id`;
    for (const dryRun of [true, false]) {
      await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow(
        "Conflicting legacy RSVP identity",
      );
    }
    expect(await target`select * from events order by id`).toEqual(before);
    expect(await target`select * from rsvps order by id`).toEqual(beforeRsvps);
  });

  it("reports dangling legacy RSVP references and missing creators explicitly", async () => {
    await legacy`alter table rsvps drop constraint rsvps_event_id_fkey`;
    await legacy`alter table rsvps drop constraint rsvps_user_id_fkey`;
    await legacy`update rsvps set event_id = 999, user_id = 999 where id = 73`;
    await legacy`update events set created_by = 903 where id = 30`;
    const report = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(report.unresolved).toEqual({ creators: 1, rsvpEvents: 1, rsvpUsers: 1 });
    expect(report.rsvps.orphaned).toBe(1);
    expect((await target`select created_by from events where id = 500`)[0]!.created_by).toBeNull();
  });

  it.each(["grant", "deleted-grant-proof", "version"])(
    "rejects %s ownership before any destination writes",
    async (attribution) => {
      const before = await target`select * from events order by id`;
      if (attribution === "version") {
        await legacy`update events set agent_version = 3 where id = 30`;
      } else {
        const grantId = "00000000-0000-4000-8000-000000000001";
        await legacy`insert into agent_event_grants (id, agent_id, company_id, guild_id, verifier_hash)
        values (${grantId}, 'synthetic-agent', 'synthetic-company', 'synthetic-guild', ${"0".repeat(64)})`;
        await legacy`update events set agent_grant_id = ${grantId}, created_by = null,
        proof_marker = ${attribution === "deleted-grant-proof" ? "synthetic-proof" : null} where id = 30`;
        if (attribution === "deleted-grant-proof") {
          await legacy`delete from agent_event_grants where id = ${grantId}`;
          expect(
            (await legacy`select agent_grant_id from events where id = 30`)[0]!.agent_grant_id,
          ).toBeNull();
        }
      }
      // The rejected series also has children and RSVPs; none may be flattened or detached.
      for (const dryRun of [true, false]) {
        await expect(importEventsRsvps(legacy, target, { dryRun })).rejects.toThrow(
          "Unsupported legacy agent ownership",
        );
      }
      expect(await target`select * from events order by id`).toEqual(before);
      expect(await target`select * from rsvps`).toHaveLength(0);
      expect(
        await target`select * from events where agent_grant_id is not null or proof_marker is not null`,
      ).toHaveLength(0);
      expect(await target`select * from agent_event_grants`).toHaveLength(0);
    },
  );

  it.each([
    ["events", "starts_at"],
    ["events", "ends_at"],
    ["events", "discord_sync_failed_at"],
    ["events", "created_at"],
    ["events", "updated_at"],
    ["rsvps", "synced_to_discord_at"],
    ["rsvps", "created_at"],
    ["rsvps", "updated_at"],
  ])(
    "repairs submillisecond mismatch in %s.%s and then reports unchanged",
    async (table, column) => {
      await importEventsRsvps(legacy, target, { dryRun: false });
      await target`update ${target(table)} set ${target(column)} = ${target(column)} + interval '0.0001 seconds'`;
      const dry = await importEventsRsvps(legacy, target);
      const repaired = await importEventsRsvps(legacy, target, { dryRun: false });
      const tableCounts = table === "events" ? repaired.events : repaired.rsvps;
      expect(tableCounts.updated).toBeGreaterThan(0);
      expect(table === "events" ? dry.events.updated : dry.rsvps.updated).toBe(tableCounts.updated);
      const fractions =
        await target`select extract(microseconds from ${target(column)})::int % 1000000 as fraction
      from ${target(table)} where ${target(column)} is not null`;
      expect(fractions.every((row) => row.fraction === 0)).toBe(true);
      const replay = await importEventsRsvps(legacy, target, { dryRun: false });
      expect(replay.events).toMatchObject({ updated: 0, unchanged: 4 });
      expect(replay.rsvps).toMatchObject({ updated: 0, unchanged: 3 });
    },
  );

  it("preserves source microseconds including submillisecond event duration", async () => {
    await legacy`update events set starts_at = '2026-09-01 10:00:00.123456+00',
      ends_at = '2026-09-01 10:00:00.123457+00', created_at = '2026-08-31 09:00:00.654321' where id = 40`;
    await legacy`update rsvps set created_at = '2026-09-30 11:00:00.999999',
      synced_to_discord_at = '2026-09-30 12:00:00.000001' where id = 70`;
    await importEventsRsvps(legacy, target, { dryRun: false });
    const [event] = await target`select to_char(starts_at at time zone 'UTC', 'SS.US') as starts_at,
      to_char(ends_at at time zone 'UTC', 'SS.US') as ends_at,
      to_char(created_at at time zone 'UTC', 'SS.US') as created_at from events where status = 'past'`;
    expect(event).toEqual({
      starts_at: "00.123456",
      ends_at: "00.123457",
      created_at: "00.654321",
    });
    const [rsvp] =
      await target`select to_char(created_at at time zone 'UTC', 'SS.US') as created_at,
      to_char(synced_to_discord_at at time zone 'UTC', 'SS.US') as synced_to_discord_at from rsvps where status = 'going'`;
    expect(rsvp).toEqual({ created_at: "00.999999", synced_to_discord_at: "00.000001" });
    const replay = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(replay.events).toMatchObject({ updated: 0, unchanged: 4 });
    expect(replay.rsvps).toMatchObject({ updated: 0, unchanged: 3 });
  });

  it.each(["D", "R"])(
    "rejects unsupported trigger mode %s before destination writes",
    async (mode) => {
      if (mode === "D") await target`alter table events disable trigger events_ics_sequence`;
      else await target`alter table events enable replica trigger events_ics_sequence`;
      const before = await target`select * from events order by id`;
      await expect(importEventsRsvps(legacy, target, { dryRun: false })).rejects.toThrow(
        "Calendar revision trigger must be enabled for origin or always",
      );
      expect(await target`select * from events order by id`).toEqual(before);
      expect(await target`select * from rsvps`).toHaveLength(0);
      expect(
        (
          await target`select tgenabled from pg_trigger
      where tgrelid = 'events'::regclass and tgname = 'events_ics_sequence'`
        )[0]!.tgenabled,
      ).toBe(mode);
    },
  );

  it.each(["O", "A"])(
    "rolls back destination data and trigger mode %s on late RSVP validation failure",
    async (mode) => {
      if (mode === "A") await target`alter table events enable always trigger events_ics_sequence`;
      const before = await target`select * from events order by id`;
      await legacy`update rsvps set status = 'invalid-synthetic-status' where id = 72`;
      await expect(importEventsRsvps(legacy, target, { dryRun: false })).rejects.toThrow(
        "Invalid legacy RSVP status",
      );
      expect(await target`select * from events order by id`).toEqual(before);
      expect(await target`select * from rsvps`).toHaveLength(0);
      expect(
        (
          await target`select tgenabled from pg_trigger
      where tgrelid = 'events'::regclass and tgname = 'events_ics_sequence'`
        )[0]!.tgenabled,
      ).toBe(mode);
      await target`update events set title = 'After failed import' where id = 500`;
      expect(
        BigInt((await target`select ics_sequence from events where id = 500`)[0]!.ics_sequence),
      ).toBe(BigInt(before[0]!.ics_sequence) + 1n);
    },
  );
});
