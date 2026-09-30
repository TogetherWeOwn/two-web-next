import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import postgres from "postgres";
import { createMemberDataFixture, testDatabaseUrl, type MemberDataFixture } from "./helpers/member-data-db";
// @ts-expect-error standalone mjs has no type declarations
import { importEventsRsvps, reportExitCode } from "../bin/import/events-rsvps.mjs";

const url = process.env.DATABASE_URL;
const parentKey = "01K00000000000000000000030";
const fixtureSql = readFileSync(new URL("./fixtures/legacy/events-rsvps.sql", import.meta.url), "utf8");

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
    const options = { max: 1, password: () => safe.password, onnotice: () => {} };
    legacy = postgres(safe.href, { ...options, connection: { search_path: legacySchema, timezone: "Pacific/Honolulu" } });
    target = postgres(safe.href, { ...options, connection: { search_path: fixture.schemaName, timezone: "Asia/Tokyo" } });
  });

  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`;
    await fixture.client`create schema ${fixture.client(legacySchema)}`;
    await legacy.unsafe(fixtureSql.replaceAll("legacy.", `"${legacySchema}".`));
    await target`insert into users (id, username) values
      ('100000000000000901', 'Synthetic going'), ('100000000000000902', 'Synthetic waitlisted')`;
    // A pre-existing natural key with a different local ID proves FK remapping.
    await target`insert into events (id, event_key, title, starts_at, ends_at)
      values (500, ${parentKey}, 'Before import', '2026-10-18T19:00:00Z', '2026-10-18T21:00:00Z')`;
  });

  afterAll(async () => {
    await Promise.all([legacy?.end(), target?.end()]);
    if (fixture) {
      try { await fixture.client`drop schema if exists ${fixture.client(legacySchema)} cascade`; }
      finally { await fixture.dispose(); }
    }
  });

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
    expect(parent).toMatchObject({ id: 500, title: 'Synthetic Sunday series', game: 'Synthetic game',
      description: 'Synthetic description', location: 'Synthetic voice room', capacity: 1,
      status: 'published', timezone: 'Europe/London', rsvp_open: false, created_by: '100000000000000901',
      discord_event_id: '100000000000000030', discord_sync_failure_code: 'synthetic_refusal',
      recurrence_frequency: 'weekly', recurrence_count: 3, recurrence_index: 1, parent_event_id: null });
    expect(parent!.starts_at.toISOString()).toBe('2026-10-18T19:00:00.000Z');
    expect(parent!.ends_at.toISOString()).toBe('2026-10-18T21:00:00.000Z');
    expect(parent!.discord_sync_failed_at.toISOString()).toBe('2026-09-29T12:00:00.000Z');
    expect(parent!.created_at.toISOString()).toBe('2026-09-01T09:00:00.000Z');
    const [date] = await target`select recurrence_ends_on::text from events where id = 500`;
    expect(date!.recurrence_ends_on).toBe('2026-11-01 00:00:00');
    const children = await target`select * from events where parent_event_id = 500 order by recurrence_index`;
    expect(children.map((row) => row.status)).toEqual(['published', 'cancelled']);
    expect(children.map((row) => row.recurrence_index)).toEqual([2, 3]);
    expect(children[0]!.starts_at.toISOString()).toBe('2026-10-25T20:00:00.000Z');
    expect(await target`select * from events where status = 'past'`).toHaveLength(1);
    const rsvps = await target`select * from rsvps order by id`;
    expect(rsvps.map((row) => row.status)).toEqual(['going', 'waitlisted', 'maybe']);
    expect(rsvps[0]).toMatchObject({ user_id: '100000000000000901', event_id: children[0]!.id });
    expect(rsvps[0]!.synced_to_discord_at.toISOString()).toBe('2026-09-30T12:00:00.000Z');
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
    expect(await target`select status from rsvps where user_id = '100000000000000901' order by id`)
      .toMatchObject([{ status: 'not_going' }, { status: 'maybe' }]);
  });

  it("reports orphans and recovers them after the missing member is imported", async () => {
    const first = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(first.rsvps.orphaned).toBe(1);
    await target`insert into users (id, username) values ('100000000000000903', 'Synthetic recovered')`;
    const retry = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(retry.rsvps).toMatchObject({ inserted: 1, unchanged: 3, orphaned: 0 });
    expect(reportExitCode(retry)).toBe(0);
    expect(await target`select user_id from rsvps where event_id = 500`).toMatchObject([{ user_id: '100000000000000903' }]);
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

  it("rolls back all destination changes on late RSVP validation failure", async () => {
    const before = await target`select * from events order by id`;
    await legacy`update rsvps set status = 'invalid-synthetic-status' where id = 72`;
    await expect(importEventsRsvps(legacy, target, { dryRun: false })).rejects.toThrow('Invalid legacy RSVP status');
    expect(await target`select * from events order by id`).toEqual(before);
    expect(await target`select * from rsvps`).toHaveLength(0);
  });
});
