// Chains all four importers, in slice order, into the baseline verifier on one
// synthetic legacy fixture: with every mapping gap closed, verify.mjs exits 0
// with empty mappingGaps on all twelve tables; an injected mismatch exits 1;
// a second importer replay writes nothing and verify stays 0.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lookup } from "node:dns/promises";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, URL } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { verify, type VerificationReport } from "../bin/import/verify.mjs";
// @ts-expect-error standalone mjs has no type declarations
import { importUsersProfiles } from "../bin/import/users-profiles.mjs";
// @ts-expect-error standalone mjs has no type declarations
import { importEventsRsvps } from "../bin/import/events-rsvps.mjs";
import { importContentFunnel } from "../bin/import/content-funnel.mjs";
// @ts-expect-error Standalone operator CLI has no declaration file.
import { IDEMPOTENCY_RETENTION_DAYS, importAudit } from "../bin/import/audit.mjs";
import { createImportFixtureClients } from "./helpers/import-events-rsvps-db";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

const script = fileURLToPath(new URL("../bin/import/verify.mjs", import.meta.url));
// One shared anchor for both retention windows (content funnel and audit
// replay keys both keep 90 days), so the verifier cutoff matches the importers.
const now = new Date("2026-09-30T12:00:00Z");
const cutoff = new Date(now.getTime() - IDEMPOTENCY_RETENTION_DAYS * 86400000).toISOString();
const one = "100000000000000011";
const two = "100000000000000022";
const parentKey = "01J2ZB2X5X3Q8T1V9W4Y6Z7A8B";
const childKey = "01J2ZB2X5X3Q8T1V9W4Y6Z7A8C";
const grantA = "44444444-4444-4444-8444-444444444444";
const grantB = "55555555-5555-4555-8555-555555555555";

const databaseUrl = process.env.DATABASE_URL;
describe.skipIf(!databaseUrl)("all four importers verify clean end to end", () => {
  let destination: MemberDataFixture;
  let legacy: postgres.Sql;
  let target: postgres.Sql;
  let legacySchema: string;
  let scratch: string;
  let legacyConnectionUrl = databaseUrl!;

  beforeAll(async () => {
    const safe = testDatabaseUrl(databaseUrl!); // Refuse before any driver or DDL.
    destination = await createMemberDataFixture(safe.href);
    legacySchema = `verify_chain_l_${randomUUID().replaceAll("-", "")}`;
    ({ legacy, target } = createImportFixtureClients(
      safe.href,
      legacySchema,
      destination.schemaName,
    ));
    await destination.client`create schema ${destination.client(legacySchema)}`;
    await legacy.unsafe(
      await readFile(new URL("./fixtures/legacy/verify.sql", import.meta.url), "utf8"),
    );
    await legacy.unsafe(`
      INSERT INTO users (id, discord_id, username, avatar, discord_joined_at, created_at, updated_at, display_name) VALUES
        (1, '${one}', 'synthetic-one', NULL, '2026-01-02 03:04:05', '2026-01-01 00:00:00', '2026-02-01 00:00:00', 'Synthetic One'),
        (2, '${two}', 'synthetic-two', NULL, NULL, '2026-01-03 00:00:00', '2026-01-03 00:00:00', NULL);
      INSERT INTO profiles (id, user_id, bio, games, timezone, created_at, updated_at) VALUES
        (1, 1, 'synthetic chain bio', '["synthetic-game"]', 'Europe/London', '2026-01-01 00:00:00', '2026-02-01 00:00:00');
      INSERT INTO events (id, event_key, title, game, description, starts_at, ends_at, timezone, location, capacity,
          status, discord_event_id, created_by, rsvp_open, recurrence_frequency, recurrence_count, recurrence_ends_on,
          parent_event_id, recurrence_index, discord_sync_failed_at, discord_sync_failure_code, created_at, updated_at) VALUES
        (10, '${parentKey}', 'Synthetic chain series', 'Synthetic game', 'Synthetic description', '2026-10-18T19:00:00Z', '2026-10-18T21:00:00Z',
          'Europe/London', 'Synthetic room', 5, 'published', '100000000000000031', 1, true, NULL, NULL, NULL,
          NULL, 1, '2026-09-29 12:00:00.123456', 'synthetic_refusal', '2026-09-01 09:00:00', '2026-09-02 09:00:00'),
        (20, '${childKey}', 'Synthetic chain child', NULL, NULL, '2026-10-25T20:00:00Z', '2026-10-25T22:00:00Z',
          'Europe/London', NULL, NULL, 'published', NULL, NULL, true, NULL, NULL, NULL,
          10, 2, NULL, NULL, '2026-09-01 09:00:00', '2026-09-01 09:00:00');
      INSERT INTO rsvps (id, event_id, user_id, status, synced_to_discord_at, created_at, updated_at) VALUES
        (1, 20, 1, 'going', '2026-09-30 12:00:00', '2026-09-10 08:00:00', '2026-09-10 08:00:00'),
        (2, 20, 2, 'waitlisted', NULL, '2026-09-11 08:00:00', '2026-09-11 08:00:00');
      INSERT INTO featured_contents (id, title, body, url, image_url, image_alt, is_published, position,
          starts_at, ends_at, created_by, created_at, updated_at) VALUES
        (1, 'Chain night', 'Bring a friend.', 'https://example.invalid/chain', NULL, NULL, true, 1,
          '2026-09-01 18:00:00', '2026-10-01 23:00:00', 1, '2025-06-01 00:00:00', '2026-09-29 12:00:00'),
        (2, 'Chain day', NULL, NULL, NULL, NULL, false, 0,
          NULL, NULL, NULL, '2026-09-29 12:00:00', NULL);
      INSERT INTO join_attempts (id, outcome, source, request_id, discord_id, created_at, updated_at) VALUES
        (1, 'denied', 'landing', 'synthetic-old', NULL, '2026-07-02 11:59:59.999999', '2026-09-29 12:00:00'),
        (2, 'added', 'landing', 'synthetic-boundary', '${one}', '2026-07-02 12:00:00', '2026-07-02 12:00:00'),
        (3, 'denied', NULL, NULL, NULL, '2026-09-29 12:00:00.123456', NULL),
        (4, 'expired', NULL, NULL, NULL, NULL, NULL);
      INSERT INTO event_search_logs (id, normalized_query, result_count, occurred_at) VALUES
        (1, 'old game', 0, '2026-07-02 11:59:59.999999'),
        (2, 'boundary game', 1, '2026-07-02 12:00:00'),
        (3, 'chain game', 2, '2026-09-29 12:00:00.000001');
      INSERT INTO member_data_access_logs (id, viewer_discord_id, viewer_user_id, resource, action, subject_user_ids, subject_count, route, occurred_at) VALUES
        (92001, '${one}', 1, 'member', 'view', '[2]', 1, 'admin.members.view', '2026-09-01 10:11:12.123456'),
        (92002, 'unauthenticated', NULL, 'member', 'list', '[]', 0, NULL, '2026-09-02 10:11:12.654321');
      INSERT INTO activity_log (id, log_name, description, subject_type, subject_id, causer_type, causer_id, properties, created_at, updated_at, event, batch_uuid) VALUES
        (93001, 'default', 'Synthetic chain view', 'App\\Models\\User', 1, 'App\\Models\\User', 1, '{"attributes":{"synthetic":true}}',
         '2026-09-01 10:11:12.123456', '2026-09-01 10:11:12.234567', 'viewed', '11111111-1111-4111-8111-111111111111'),
        (93002, NULL, 'Synthetic chain system', NULL, NULL, NULL, NULL, NULL,
         '2026-09-02 10:11:12.654321', NULL, NULL, NULL);
      INSERT INTO agent_event_grants (id, agent_id, company_id, guild_id, verifier_hash, expires_at, disabled_at, max_events, created_at, updated_at) VALUES
        ('${grantA}', 'synthetic-chain-agent', 'synthetic-company', '100000000000000012', repeat('a', 64),
         '2026-10-10 00:00:00', NULL, 1, '2026-09-01 10:11:12.123456', '2026-09-01 10:11:12.234567'),
        ('${grantB}', 'synthetic-chain-disabled', 'synthetic-company', '100000000000000012', repeat('b', 64),
         NULL, '2026-09-02 00:00:00', 1, '2026-09-01 10:11:12.123456', '2026-09-02 00:00:00.234567');
      INSERT INTO agent_event_audits (id, grant_id, operation, event_key, idempotency_key, payload_digest, request_id, result, reason_code, discord_event_id, created_at, updated_at) VALUES
        (95001, '${grantA}', 'create', '${parentKey}', 'synthetic-recent', repeat('c', 64), 'synthetic-request', 'accepted', NULL,
         '100000000000000013', '2026-09-29 00:00:00.123456', '2026-09-29 00:00:00.234567'),
        (95002, NULL, 'create', NULL, NULL, NULL, 'synthetic-denial', 'denied', 'missing_credential', NULL,
         '2026-09-29 01:00:00.654321', NULL);
      INSERT INTO agent_event_idempotency_keys (id, grant_id, key, payload_digest, status, body, event_key, created_at, updated_at) VALUES
        (94001, '${grantA}', 'synthetic-recent', repeat('c', 64), 201, '{"ok":true}', '${parentKey}',
         '2026-09-29 00:00:00.123456', '2026-09-29 00:00:00.234567'),
        (94002, '${grantA}', 'synthetic-boundary', repeat('d', 64), 200, '{"ok":true}', NULL,
         '2026-07-02 12:00:00', '2026-07-02 12:00:00');
    `);
    // Same live database under two distinct URL strings (IP literal versus
    // hostname), so the CLI's same-database refusal is satisfied honestly.
    const url = new URL(databaseUrl!);
    url.hostname = await lookup(url.hostname, { family: 4 }).then(({ address }) => address);
    legacyConnectionUrl = url.href;
    scratch = await mkdtemp(
      join(
        process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? process.env.PAPERCLIP_SCRATCH_DIR ?? tmpdir(),
        "verify-chain-",
      ),
    );
  }, 120_000);

  afterAll(async () => {
    await Promise.allSettled([legacy?.end(), target?.end()]);
    if (destination) {
      try {
        await destination.client`drop schema if exists ${destination.client(legacySchema)} cascade`;
      } finally {
        await destination.dispose();
      }
    }
    if (scratch) await rm(scratch, { recursive: true, force: true });
  });

  // Documented slice order: users/profiles, events/RSVPs, content/funnel, audit.
  async function importChain() {
    await importUsersProfiles(legacy, target, { dryRun: false });
    await importEventsRsvps(legacy, target, { dryRun: false });
    await importContentFunnel({
      legacy,
      target,
      legacySchema,
      targetSchema: destination.schemaName,
      now,
      dryRun: false,
    });
    await importAudit({
      legacy,
      target,
      legacySchema,
      targetSchema: destination.schemaName,
      dryRun: false,
      now,
    });
  }

  async function runVerifyCli(): Promise<{ status: number | null; report: VerificationReport }> {
    const jsonPath = join(scratch, `chain-${randomUUID()}.json`);
    const run = spawnSync(
      process.execPath,
      [
        script,
        "--legacy-schema",
        legacySchema,
        "--next-schema",
        destination.schemaName,
        "--cutoff",
        cutoff,
        "--json",
        jsonPath,
      ],
      {
        encoding: "utf8",
        timeout: 120000,
        env: {
          LEGACY_DATABASE_URL: legacyConnectionUrl,
          DATABASE_URL: databaseUrl!,
          PGPASSWORD: "must-not-inherit",
        },
      },
    );
    expect(run.error, run.stderr).toBeUndefined();
    return {
      status: run.status,
      report: JSON.parse(await readFile(jsonPath, "utf8")),
    };
  }

  const expectedCounts: Record<string, [number, number]> = {
    users: [2, 2],
    profiles: [1, 1],
    events: [2, 2],
    rsvps: [2, 2],
    featured_contents: [2, 2],
    // The old and NULL-clock rows sit outside the shared retention window.
    join_attempts: [2, 2],
    event_search_logs: [2, 2],
    member_data_access_logs: [2, 2],
    activity_log: [2, 2],
    agent_event_grants: [2, 2],
    agent_event_audits: [2, 2],
    agent_event_idempotency_keys: [2, 2],
  };

  it("exits 0 with empty mappingGaps on every table after the four importers", async () => {
    await importChain();
    // Guard against a vacuous match: every slice wrote non-trivial rows.
    expect(await target`select count(*)::int as n from users`).toEqual([{ n: 2 }]);
    expect(await target`select count(*)::int as n from events`).toEqual([{ n: 2 }]);
    expect(await target`select count(*)::int as n from featured_contents`).toEqual([{ n: 2 }]);
    expect(await target`select count(*)::int as n from agent_event_audits`).toEqual([{ n: 2 }]);
    const { status, report } = await runVerifyCli();
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.tables.map((t) => t.table)).toEqual(Object.keys(expectedCounts));
    for (const table of report.tables) {
      expect(
        {
          missing: table.missingCount,
          extra: table.extraCount,
          mismatch: table.mismatchCount,
          gaps: table.mappingGaps,
        },
        table.table,
      ).toEqual({ missing: 0, extra: 0, mismatch: 0, gaps: [] });
      const [legacyCount, nextCount] = expectedCounts[table.table]!;
      expect(table.legacyCount, table.table).toBe(legacyCount);
      expect(table.nextCount, table.table).toBe(nextCount);
    }
  }, 120_000);

  it("a second replay writes nothing and verify stays 0", async () => {
    await importChain();
    const users = await importUsersProfiles(legacy, target, { dryRun: false });
    expect(users.users).toMatchObject({ changed: 0, written: 0 });
    expect(users.profiles).toMatchObject({ changed: 0 });
    const events = await importEventsRsvps(legacy, target, { dryRun: false });
    expect(events.events).toMatchObject({ inserted: 0, updated: 0 });
    expect(events.rsvps).toMatchObject({ inserted: 0, updated: 0, orphaned: 0 });
    expect(events.unresolved).toEqual({ creators: 0, rsvpEvents: 0, rsvpUsers: 0 });
    const funnel = await importContentFunnel({
      legacy,
      target,
      legacySchema,
      targetSchema: destination.schemaName,
      now,
      dryRun: false,
    });
    for (const row of funnel) expect(row, row.table).toMatchObject({ inserted: 0, updated: 0 });
    const audit = await importAudit({
      legacy,
      target,
      legacySchema,
      targetSchema: destination.schemaName,
      dryRun: false,
      now,
    });
    for (const [name, counts] of Object.entries(audit.tables))
      expect(counts, name).toMatchObject({ inserted: 0 });
    const { status, report } = await runVerifyCli();
    expect(status).toBe(0);
    expect(report.ok).toBe(true);
  }, 180_000);

  it("an injected member-flag mismatch exits 1 with the named key, then repairs to 0", async () => {
    await importChain();
    await target`update users set member = not member where id = ${one}`;
    const dirty = await runVerifyCli();
    expect(dirty.status).toBe(1);
    expect(dirty.report.ok).toBe(false);
    const users = dirty.report.tables.find((t) => t.table === "users")!;
    expect(users).toMatchObject({ mismatchCount: 1, mismatchKeys: [[one]], mappingGaps: [] });
    for (const table of dirty.report.tables.filter((t) => t.table !== "users"))
      expect(table.mismatchCount, table.table).toBe(0);
    // The importer is the repair: a replay restores the imported value.
    await importChain();
    const clean = await runVerifyCli();
    expect(clean.status).toBe(0);
    expect(clean.report.ok).toBe(true);
  }, 180_000);
});
