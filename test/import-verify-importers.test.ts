// Chains the real users/profiles and events/RSVPs importers into the baseline
// verification map. Fixture proof for each tool alone never showed that the
// verifier can certify what the importers wrote; this file does, per table.
// Assertions are per-table (counts, diffs, gaps), never the global exit code:
// the remaining map entries belong to other import slices.
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { URL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verify, type TableMapping, type VerificationReport } from "../bin/import/verify.mjs";
import { defaultTableMap } from "../bin/import/verify-map.mjs";
// @ts-expect-error standalone mjs has no type declarations
import { importUsersProfiles } from "../bin/import/users-profiles.mjs";
// @ts-expect-error standalone mjs has no type declarations
import { importEventsRsvps } from "../bin/import/events-rsvps.mjs";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const cutoff = "2026-07-02T00:00:00Z";
const one = "100000000000000051";
const two = "100000000000000052";
const three = "100000000000000053";
const parentKey = "01K00000000000000000000051";
const childKey = "01K00000000000000000000052";
const pastKey = "01K00000000000000000000053";
const sliceTables = ["users", "profiles", "events", "rsvps"] as const;

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("importer output verified by the baseline map", () => {
  let destination: MemberDataFixture;
  let legacy: postgres.Sql;
  let target: postgres.Sql;
  let legacySchema: string;
  let slice: TableMapping[];

  beforeAll(async () => {
    const safe = testDatabaseUrl(databaseUrl!); // Refuse before any driver or DDL.
    if (safe.hostname === "agent-testdb" && safe.pathname !== "/two_web_next")
      throw new Error("Importer fixtures require the two_web_next test database");
    destination = await createMemberDataFixture(safe.href);
    legacySchema = `verify_imp_${randomUUID().replaceAll("-", "")}`;
    ({ legacy, target } = createImportFixtureClients(
      safe.href,
      legacySchema,
      destination.schemaName,
    ));
    await destination.client`create schema ${destination.client(legacySchema)}`;
    await legacy.unsafe(
      await readFile(new URL("./fixtures/legacy/verify.sql", import.meta.url), "utf8"),
    );
    const baseline = defaultTableMap({
      legacySchema,
      nextSchema: destination.schemaName,
      cutoff,
    });
    slice = baseline.filter((table) => (sliceTables as readonly string[]).includes(table.name));
    expect(slice.map((table) => table.name)).toEqual([...sliceTables]);
  }, 60_000);

  afterAll(async () => {
    await Promise.allSettled([legacy?.end(), target?.end()]);
    if (destination) {
      try {
        await destination.client`drop schema if exists ${destination.client(legacySchema)} cascade`;
      } finally {
        await destination.dispose();
      }
    }
  });

  beforeEach(async () => {
    await destination.reset();
    await legacy`truncate rsvps, events, profiles, users cascade`;
    await legacy.unsafe(`
      INSERT INTO users (id, discord_id, username, avatar, discord_joined_at, created_at, updated_at, display_name) VALUES
        (1, '${one}', 'synthetic-one', 'abc123', '2026-01-02 03:04:05.123456', '2026-01-01 00:00:00.000001', '2026-02-01 00:00:00.000002', 'Synthetic One'),
        (2, '${two}', 'synthetic-two', NULL, NULL, '2026-01-03 00:00:00', '2026-01-03 00:00:00', NULL),
        (3, '${three}', 'synthetic-three', NULL, '2026-03-04 05:06:07', '2026-03-04 00:00:00', '2026-03-04 00:00:00', '');
      INSERT INTO profiles (id, user_id, bio, games, timezone, created_at, updated_at) VALUES
        (1, 1, 'synthetic bio', '["synthetic-game-b","synthetic-game-a"]', 'Europe/London', '2026-01-01 00:00:01', '2026-02-01 00:00:02'),
        (2, 2, NULL, '[]', NULL, '2026-01-03 00:00:00', '2026-01-03 00:00:00');
      INSERT INTO events (id, event_key, title, game, description, starts_at, ends_at, timezone, location, capacity,
          status, discord_event_id, created_by, rsvp_open, recurrence_frequency, recurrence_count, recurrence_ends_on,
          parent_event_id, recurrence_index, discord_sync_failed_at, discord_sync_failure_code, created_at, updated_at) VALUES
        (10, '${parentKey}', 'Synthetic series', 'Synthetic game', 'Synthetic description', '2026-10-18T19:00:00Z', '2026-10-18T21:00:00Z',
          'Europe/London', 'Synthetic room', 5, 'published', '100000000000000951', 1, true, 'weekly', 2, '2026-11-01',
          NULL, 1, '2026-09-29 12:00:00.123456', 'synthetic_refusal', '2026-09-01 09:00:00', '2026-09-02 09:00:00.5'),
        (20, '${childKey}', 'Synthetic child', NULL, NULL, '2026-10-25T20:00:00Z', '2026-10-25T22:00:00Z',
          'Europe/London', NULL, NULL, 'published', NULL, 2, true, 'weekly', 2, '2026-11-01',
          10, 2, NULL, NULL, '2026-09-01 09:00:00', '2026-09-01 09:00:00'),
        (30, '${pastKey}', 'Synthetic past one-off', NULL, NULL, '2026-09-01T10:00:00Z', '2026-09-01T11:00:00Z',
          'UTC', NULL, 1, 'past', NULL, NULL, false, NULL, NULL, NULL,
          NULL, NULL, NULL, NULL, '2026-08-01 09:00:00', '2026-09-01 12:00:00');
      INSERT INTO rsvps (id, event_id, user_id, status, synced_to_discord_at, created_at, updated_at) VALUES
        (1, 20, 1, 'going', '2026-09-30 12:00:00.654321', '2026-09-10 08:00:00', '2026-09-10 08:00:00'),
        (2, 20, 2, 'waitlisted', NULL, '2026-09-11 08:00:00', '2026-09-11 08:00:00');
    `);
  }, 60_000);

  async function importSlice() {
    await importUsersProfiles(legacy, target, { dryRun: false });
    await importEventsRsvps(legacy, target, { dryRun: false });
  }
  async function verifySlice(): Promise<Record<string, VerificationReport["tables"][number]>> {
    const report = await verify({ legacy, next: target, map: slice, batchSize: 2 });
    return Object.fromEntries(report.tables.map((table) => [table.table, table]));
  }
  const clean = (table: VerificationReport["tables"][number]) => ({
    missingCount: table.missingCount,
    extraCount: table.extraCount,
    mismatchCount: table.mismatchCount,
    mappingGaps: table.mappingGaps,
  });
  const noDiff = { missingCount: 0, extraCount: 0, mismatchCount: 0, mappingGaps: [] };

  it("reports zero diffs and zero gaps for what the real importers wrote", async () => {
    await importSlice();
    // Guard against a vacuous match: the new projections see non-trivial data.
    expect(await target`select id from users where member order by id`).toEqual([
      { id: one },
      { id: three },
    ]);
    expect(
      await target`select event_key from events where discord_sync_failure_code is not null`,
    ).toEqual([{ event_key: parentKey }]);
    const tables = await verifySlice();
    expect(Object.keys(tables)).toEqual([...sliceTables]);
    for (const name of sliceTables) expect(clean(tables[name]!), name).toEqual(noDiff);
    expect(tables.users).toMatchObject({ legacyCount: 3, nextCount: 3 });
    expect(tables.profiles).toMatchObject({ legacyCount: 2, nextCount: 2 });
    expect(tables.events).toMatchObject({ legacyCount: 3, nextCount: 3 });
    expect(tables.rsvps).toMatchObject({ legacyCount: 2, nextCount: 2 });
    // A replay of both importers leaves the certification unchanged.
    await importSlice();
    for (const name of sliceTables)
      expect(clean((await verifySlice())[name]!), name).toEqual(noDiff);
  });

  it("surfaces a flipped member flag from either side as a named-key mismatch", async () => {
    await importSlice();
    await target`update users set member = not member where id = ${two}`;
    const flippedNext = await verifySlice();
    expect(flippedNext.users).toMatchObject({ mismatchCount: 1, mismatchKeys: [[two]] });
    for (const name of ["profiles", "events", "rsvps"] as const)
      expect(clean(flippedNext[name]!), name).toEqual(noDiff);
    await target`update users set member = not member where id = ${two}`;
    // Legacy evidence withdrawn after the import: Next still says member.
    await legacy`update users set discord_joined_at = NULL where discord_id = ${one}`;
    const flippedLegacy = await verifySlice();
    expect(flippedLegacy.users).toMatchObject({ mismatchCount: 1, mismatchKeys: [[one]] });
    expect(flippedLegacy.users!.mappingGaps).toEqual([]);
  });

  it.each([
    [
      "failure code",
      () =>
        `update events set discord_sync_failure_code = 'changed_code' where event_key = '${parentKey}'`,
    ],
    [
      "failure instant by one microsecond",
      () =>
        `update events set discord_sync_failed_at = discord_sync_failed_at + interval '1 microsecond' where event_key = '${parentKey}'`,
    ],
    [
      "failure instant cleared",
      () => `update events set discord_sync_failed_at = NULL where event_key = '${parentKey}'`,
    ],
    [
      "failure invented on a clean event",
      () =>
        `update events set discord_sync_failure_code = 'invented' where event_key = '${childKey}'`,
    ],
  ])("surfaces a changed sync %s as a named-key mismatch", async (_name, statement) => {
    await importSlice();
    await target.unsafe(statement());
    const tables = await verifySlice();
    const changed = statement().includes(childKey) ? childKey : parentKey;
    expect(tables.events).toMatchObject({ mismatchCount: 1, mismatchKeys: [[changed]] });
    expect(tables.events!.mappingGaps).toEqual([]);
    for (const name of ["users", "profiles", "rsvps"] as const)
      expect(clean(tables[name]!), name).toEqual(noDiff);
  });

  it.each([
    ["grant ID", `agent_grant_id = '${randomUUID()}'`],
    ["proof marker", `proof_marker = 'synthetic-proof'`],
    ["nonzero version", `agent_version = 1`],
  ])(
    "surfaces a legacy event gaining an agent %s as a mismatch, not a MATCH",
    async (_name, set) => {
      await importSlice();
      await legacy.unsafe(`update events set ${set} where event_key = '${childKey}'`);
      const tables = await verifySlice();
      expect(tables.events).toMatchObject({
        legacyCount: 3,
        nextCount: 3,
        missingCount: 0,
        extraCount: 0,
        mismatchCount: 1,
        mismatchKeys: [[childKey]],
        mappingGaps: [],
      });
      for (const name of ["users", "profiles", "rsvps"] as const)
        expect(clean(tables[name]!), name).toEqual(noDiff);
    },
  );

  it("keeps an attributed event visible when the importer refuses the batch", async () => {
    await legacy`update events set proof_marker = 'synthetic-proof' where event_key = ${childKey}`;
    await importUsersProfiles(legacy, target, { dryRun: false });
    await expect(importEventsRsvps(legacy, target, { dryRun: false })).rejects.toThrow(
      /Unsupported legacy agent ownership/,
    );
    // Nothing from the refused batch reached Next: every legacy event, the
    // attributed one included, is reported missing rather than excluded.
    expect(await target`select event_key from events`).toEqual([]);
    const tables = await verifySlice();
    expect(clean(tables.users!)).toEqual(noDiff);
    expect(clean(tables.profiles!)).toEqual(noDiff);
    expect(tables.events).toMatchObject({ legacyCount: 3, nextCount: 0, missingCount: 3 });
    expect(tables.events!.missingKeys).toContainEqual([childKey]);
    expect(tables.rsvps).toMatchObject({ legacyCount: 2, nextCount: 0, missingCount: 2 });
  });
});
