import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { DEFAULT_CONFIG, handleAgentEvent } from "../src/agent-events/service";
import { sha256Hex } from "../src/bot/signer";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url).href);
const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
  entries: { tag: string }[];
};
const migrationIndex = journal.entries.findIndex(({ tag }) => tag === "1019_shared-agent-events");
if (migrationIndex < 1) throw new Error("Canonical migration 1019 is missing from the journal");
const migrations = readMigrationFiles({ migrationsFolder });
const migration1019 = migrations[migrationIndex]!;

// This fixture deliberately stops before 1019; createMemberDataFixture already
// applies it. Keep all scratch DDL and cleanup local to this test file.
async function createMigrationFixture(raw: string) {
  const url = testDatabaseUrl(raw); // Guard before constructing either driver.
  if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") {
    throw new Error(
      "Migration fixtures require agent-testdb/two_web_next; refusing before connecting",
    );
  }
  const schemaName = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  const options = {
    max: 1,
    port: 5432,
    connect_timeout: 5,
    // An empty string would fall back to inherited PGPASSWORD in postgres.js.
    password: () => url.password,
    onnotice: () => {},
  };
  const admin = postgres(url.href, options);
  const client = postgres(url.href, {
    ...options,
    // No public fallback. A non-UTC session catches session-dependent conversion.
    connection: { search_path: schemaName, timezone: "Asia/Tokyo" },
  });
  let created = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await client.end();
    } finally {
      try {
        if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally {
        await admin.end();
      }
    }
  };
  const apply = async (sql: postgres.TransactionSql, statements: string[]) => {
    for (const statement of statements) {
      if (statement.trim()) {
        // Canonical legacy FKs explicitly qualify public; redirect only those
        // references to the schema we just created, as the safety helper does.
        await sql.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
      }
    }
  };
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await client.begin(async (sql) => {
      for (const migration of migrations.slice(0, migrationIndex)) await apply(sql, migration.sql);
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  // Match Drizzle's transactional migration boundary, including the final DROP.
  // Later migrations (1020_event-sync-revisions: sync_revision columns the
  // current service selects) apply after 1019 so post-migration ingress sees
  // the schema current code expects. 1019's own assertions still verify its
  // data migration: 1020 only adds, never alters 1019's rows.
  const migrate = () =>
    client.begin(async (sql) => {
      await apply(sql, migration1019.sql);
      for (const migration of migrations.slice(migrationIndex + 1)) await apply(sql, migration.sql);
    });
  return { client, schemaName, migrate, dispose };
}

type MigrationFixture = Awaited<ReturnType<typeof createMigrationFixture>>;

const legacyEvents = [
  {
    status: "draft",
    timezone: "UTC",
    starts_at: "2026-10-01 20:00",
    ends_at: "2026-10-01 22:00",
    startsUtc: "2026-10-01T20:00:00.000Z",
    endsUtc: "2026-10-01T22:00:00.000Z",
    version: 1,
  },
  {
    status: "published",
    timezone: "Europe/London",
    starts_at: "2026-10-01 20:00",
    ends_at: "2026-10-01 22:00",
    startsUtc: "2026-10-01T19:00:00.000Z",
    endsUtc: "2026-10-01T21:00:00.000Z",
    version: 4,
  },
  {
    status: "cancelled",
    timezone: "America/New_York",
    starts_at: "2026-01-10 20:00",
    ends_at: "2026-01-10 22:00",
    startsUtc: "2026-01-11T01:00:00.000Z",
    endsUtc: "2026-01-11T03:00:00.000Z",
    version: 7,
  },
  {
    status: "completed",
    timezone: "Asia/Kolkata",
    starts_at: "2026-07-10 20:00",
    ends_at: "2026-07-10 22:00",
    startsUtc: "2026-07-10T14:30:00.000Z",
    endsUtc: "2026-07-10T16:30:00.000Z",
    version: 2,
  },
].map((event, index) => ({
  ...event,
  event_key: String(index + 1).padStart(26, "0"),
  grant_id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
  proof_marker: `migration-proof-${index + 1}`,
  title: `Legacy ${event.status} event`,
  game: index === 0 ? null : "Fixture game",
  description: index === 0 ? null : `Legacy description ${index + 1}`,
  location: `Fixture voice ${index + 1}`,
  capacity: index === 0 ? null : index + 3,
  created_at: "2026-01-02T03:04:05.123Z",
  updated_at: `2026-01-03T03:04:0${index + 1}.456Z`,
}));

async function seed(sql: postgres.Sql) {
  for (const [index, event] of legacyEvents.entries()) {
    await sql`INSERT INTO agent_event_grants
      (id, agent_id, company_id, guild_id, verifier_hash, max_events, expires_at, disabled_at, created_at, updated_at)
      VALUES (${event.grant_id}, ${`fixture-agent-${index}`}, 'fixture-company', 'fixture-guild',
        ${String(index + 1).repeat(64)}, ${index + 1}, '2027-01-01T00:00:00Z',
        ${index === 2 ? "2026-02-01T00:00:00Z" : null}, ${event.created_at}, ${event.updated_at})`;
    await sql`INSERT INTO agent_events
      (event_key, agent_grant_id, proof_marker, agent_version, status, title, game, description,
       starts_at, ends_at, timezone, location, capacity, created_at, updated_at)
      VALUES (${event.event_key}, ${event.grant_id}, ${event.proof_marker}, ${event.version}, ${event.status},
        ${event.title}, ${event.game}, ${event.description}, ${event.starts_at}, ${event.ends_at},
        ${event.timezone}, ${event.location}, ${event.capacity}, ${event.created_at}, ${event.updated_at})`;
    const replayBody = {
      event_key: event.event_key,
      proof_marker: event.proof_marker,
      agent_version: event.version,
      status: event.status,
      request_id: `fixture-request-${index}`,
    };
    await sql`INSERT INTO agent_event_audits
      (grant_id, operation, event_key, idempotency_key, payload_digest, request_id, result,
       reason_code, discord_event_id, created_at, updated_at)
      VALUES (${event.grant_id}, 'create', ${event.event_key}, ${`fixture-replay-${index}`},
        ${"a".repeat(64)}, ${replayBody.request_id}, 'ok', null, ${index === 1 ? "fixture-discord-id" : null},
        ${event.created_at}, ${event.updated_at})`;
    await sql`INSERT INTO agent_event_idempotency_keys
      (grant_id, key, payload_digest, status, body, event_key, created_at, updated_at)
      VALUES (${event.grant_id}, ${`fixture-replay-${index}`}, ${"a".repeat(64)}, 201,
        ${sql.json(replayBody)}, ${event.event_key}, ${event.created_at}, ${event.updated_at})`;
  }
  // Include a denial with no grant/event and nullable legacy timestamps.
  await sql`INSERT INTO agent_event_audits (operation, request_id, result, reason_code, created_at)
    VALUES ('read', 'fixture-denied-request', 'denied', 'unauthenticated', '2026-01-01T00:00:00Z')`;
  await sql`INSERT INTO events
    (event_key, title, starts_at, ends_at, timezone, status, discord_event_id, created_by, rsvp_open,
     created_at, updated_at)
    VALUES ('human-event-one', 'Existing human event', '2026-10-01T18:00:00Z', '2026-10-01T20:00:00Z',
      'America/Los_Angeles', 'published', 'human-discord-id', 'human-author', false,
      '2026-01-01T00:00:00.123Z', '2026-01-02T00:00:00.456Z'),
    ('human-event-two', 'Another human event', '2026-10-02T18:00:00Z', '2026-10-02T20:00:00Z',
      'UTC', 'draft', null, 'another-author', true, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`;
  await sql`INSERT INTO activity_log (description, subject_type, subject_id, properties)
    VALUES ('Human event evidence', 'event', 'human-event-one', ${sql.json({ source: "human" })})`;
}

const evidenceTables = [
  "agent_event_grants",
  "agent_event_audits",
  "agent_event_idempotency_keys",
  "activity_log",
];
async function snapshot(sql: postgres.Sql, table: string) {
  // Table names are fixture-owned constants, never external input. JSON retains
  // every column (including nullable evidence and timestamp precision).
  const key = table === "events" || table === "agent_events" ? "event_key" : "id";
  const rows = await sql.unsafe<{ row: Record<string, unknown> }[]>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY "${key}"`,
  );
  return rows.map(({ row }) => row);
}

async function catalog({ client, schemaName }: MigrationFixture) {
  return {
    relations: Array.from(
      await client`SELECT c.oid::text, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemaName} ORDER BY c.relname`,
    ),
    columns: Array.from(
      await client`SELECT table_name, column_name, ordinal_position,
      data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ${schemaName} ORDER BY table_name, ordinal_position`,
    ),
    constraints: Array.from(
      await client`SELECT c.oid::text, c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = ${schemaName} ORDER BY c.conname`,
    ),
  };
}

it("appends the shared migration after the audit-immutability migration with a linked, index-preserving snapshot", () => {
  const entries = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8"))
    .entries as {
    idx: number;
    when: number;
    tag: string;
  }[];
  const previous = entries[migrationIndex - 1]!;
  const shared = entries[migrationIndex]!;
  // Appended after 1018 (above every applied ledger `when`), never into an
  // older gap. Later migrations (e.g. 1020_event-sync-revisions) may follow.
  expect(previous.tag).toBe("1018_audit-immutability");
  expect(migrationIndex).toBeLessThan(entries.length);
  expect(shared.idx).toBe(previous.idx + 1);
  expect(shared.when).toBeGreaterThan(previous.when);
  const before = JSON.parse(readFileSync(`${migrationsFolder}/meta/1018_snapshot.json`, "utf8"));
  const after = JSON.parse(readFileSync(`${migrationsFolder}/meta/1019_snapshot.json`, "utf8"));
  expect(after.tables["public.events"].columns.ics_sequence).toEqual(
    before.tables["public.events"].columns.ics_sequence,
  );
  expect(after.prevId).toBe(before.id);
  expect(after.id).not.toBe(before.id);
  expect(before.tables["public.agent_events"]).toBeDefined();
  expect(after.tables["public.agent_events"]).toBeUndefined();
  for (const table of ["public.events", "public.rsvps", "public.join_attempts"]) {
    expect(after.tables[table].indexes).toEqual(before.tables[table].indexes);
  }
});

it("refuses a different agent-testdb database before connecting", async () => {
  await expect(
    createMigrationFixture("postgres://agent_test@agent-testdb:5432/postgres"),
  ).rejects.toThrow("refusing before connecting");
});

describe.skipIf(!process.env.DATABASE_URL)(
  "1019 populated shared-agent-events migration (owned test schema)",
  () => {
    let fixture: MigrationFixture;
    beforeEach(async () => {
      fixture = await createMigrationFixture(process.env.DATABASE_URL!);
      expect(
        (
          await fixture.client`SELECT current_schema() AS schema, current_setting('TimeZone') AS timezone`
        )[0],
      ).toEqual({ schema: fixture.schemaName, timezone: "Asia/Tokyo" });
      await seed(fixture.client);
    }, 30_000);
    afterEach(async () => {
      await fixture?.dispose();
    });

    it("preserves populated rows and evidence, converts each zone to UTC, and retires agent_events", async () => {
      const sql = fixture.client;
      const humansBefore = await snapshot(sql, "events");
      const evidenceBefore = await Promise.all(evidenceTables.map((table) => snapshot(sql, table)));
      expect(await snapshot(sql, "agent_events")).toHaveLength(legacyEvents.length);

      await fixture.migrate();

      const migrated =
        await sql`SELECT event_key, agent_grant_id, proof_marker, agent_version, status,
      title, game, description, starts_at, ends_at, timezone, location, capacity, created_at, updated_at
      FROM events WHERE agent_grant_id IS NOT NULL ORDER BY event_key`;
      const revisions = await sql`SELECT event_key, ics_sequence::text AS revision
      FROM events WHERE agent_grant_id IS NOT NULL ORDER BY event_key`;
      expect(revisions.map(({ revision }) => revision)).toEqual(
        legacyEvents.map((event) =>
          String(Math.floor(new Date(event.updated_at).getTime() / 1000)),
        ),
      );
      expect(Array.from(migrated)).toEqual(
        legacyEvents.map((event) => ({
          event_key: event.event_key,
          agent_grant_id: event.grant_id,
          proof_marker: event.proof_marker,
          agent_version: event.version,
          status: event.status,
          title: event.title,
          game: event.game,
          description: event.description,
          starts_at: new Date(event.startsUtc),
          ends_at: new Date(event.endsUtc),
          timezone: event.timezone,
          location: event.location,
          capacity: event.capacity,
          created_at: new Date(event.created_at),
          updated_at: new Date(event.updated_at),
        })),
      );
      // 1020's sync_revision/synced_revision ride along with 1019 in this
      // fixture's migrate(); they only add, so exclude them like 1019's own
      // columns when proving human rows are untouched.
      const humanRows = await sql<{ row: Record<string, unknown> }[]>`SELECT
      to_jsonb(e) - 'agent_grant_id' - 'proof_marker' - 'agent_version' - 'sync_revision' - 'synced_revision' AS row
      FROM events e WHERE agent_grant_id IS NULL ORDER BY event_key`;
      expect(humanRows.map(({ row }) => row)).toEqual(humansBefore);
      expect(
        (await sql`SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids FROM events`)[0],
      ).toEqual({
        n: humansBefore.length + legacyEvents.length,
        ids: humansBefore.length + legacyEvents.length,
      });
      expect(await Promise.all(evidenceTables.map((table) => snapshot(sql, table)))).toEqual(
        evidenceBefore,
      );
      // Both event_key references and the original replay body still identify the
      // same shared row. Do not invoke ingress, Discord or any network service.
      const references = await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys k
      JOIN events e ON e.event_key = k.event_key AND e.agent_grant_id = k.grant_id
      JOIN agent_event_audits a ON a.event_key = e.event_key AND a.grant_id = e.agent_grant_id
      WHERE k.body->>'event_key' = e.event_key AND k.body->>'proof_marker' = e.proof_marker`;
      expect(references[0]!.n).toBe(legacyEvents.length);
      expect(
        (await sql`SELECT to_regclass(${`${fixture.schemaName}.agent_events`}) AS retired`)[0]!
          .retired,
      ).toBeNull();
    }, 30_000);

    it("keeps both migrated fold instants through a read and title-only update, but resolves changed times/zones", async () => {
      const sql = fixture.client;
      const first = legacyEvents[0]!;
      const credential = `migration-fixture-${randomUUID()}`;
      const cfg = {
        ...DEFAULT_CONFIG,
        enabled: true,
        callerAgentId: "fixture-agent-0",
        stagingGuildId: "fixture-guild",
      };
      await sql`UPDATE agent_event_grants SET verifier_hash = ${await sha256Hex(credential)} WHERE id = ${first.grant_id}`;
      // Both endpoints are in the repeated hour. PostgreSQL migration chooses
      // standard time, unlike the fresh-input resolver's first occurrence.
      await sql`UPDATE agent_events SET timezone = 'Europe/London',
      starts_at = '2026-10-25 01:10', ends_at = '2026-10-25 01:50' WHERE event_key = ${first.event_key}`;
      await fixture.migrate();
      const call = (op: string, rest: Record<string, unknown> = {}) =>
        handleAgentEvent(
          sql,
          cfg,
          { op, idempotency_key: randomUUID(), event_key: first.event_key, ...rest },
          credential,
        );
      const read = await call("read");
      expect(read.status).toBe(200);
      const event = read.body.event as Record<string, unknown>;
      expect(event).toMatchObject({
        starts_at: "2026-10-25 01:10",
        ends_at: "2026-10-25 01:50",
        agent_version: 1,
      });
      const snapshotTimes = async () => {
        const [row] =
          await sql`SELECT starts_at, ends_at FROM events WHERE event_key = ${first.event_key}`;
        return [new Date(row!.starts_at).toISOString(), new Date(row!.ends_at).toISOString()];
      };
      const original = ["2026-10-25T01:10:00.000Z", "2026-10-25T01:50:00.000Z"];
      expect(await snapshotTimes()).toEqual(original);
      expect(
        (await call("update", { version: 1, fields: { ...event, title: "Title only" } })).status,
      ).toBe(200);
      expect(await snapshotTimes()).toEqual(original);
      // A changed end before the preserved second-fold start cannot resolve.
      // (TOG-11669: changed fold walls take the second/GMT occurrence, so the
      // old 01:20 probe is now a valid 01:20Z end; 01:05Z still precedes 01:10Z.)
      const invalid = await call("update", {
        version: 2,
        fields: { ...event, ends_at: "2026-10-25 01:05" },
      });
      expect(invalid.status).toBe(422);
      expect(invalid.body.errors).toHaveProperty("ends_at");
      expect(await snapshotTimes()).toEqual(original);
      // A changed end takes the second occurrence; the unchanged start stays exact.
      expect(
        (await call("update", { version: 2, fields: { ...event, ends_at: "2026-10-25 01:20" } }))
          .status,
      ).toBe(200);
      expect(await snapshotTimes()).toEqual([original[0], "2026-10-25T01:20:00.000Z"]);
      // A changed start takes the second occurrence; the sent end (the original
      // read's 01:50, unchanged here) keeps its exact instant.
      expect(
        (await call("update", { version: 3, fields: { ...event, starts_at: "2026-10-25 01:15" } }))
          .status,
      ).toBe(200);
      expect(await snapshotTimes()).toEqual(["2026-10-25T01:15:00.000Z", original[1]]);
      // An explicit zone change must re-resolve even identical wall text.
      expect(
        (await call("update", { version: 4, fields: { ...event, timezone: "Europe/Paris" } }))
          .status,
      ).toBe(200);
      expect(await snapshotTimes()).toEqual([
        "2026-10-24T23:10:00.000Z",
        "2026-10-24T23:50:00.000Z",
      ]);
    }, 30_000);

    it("stores object receipts and replays all five operations with a standalone postgres.js client", async () => {
      await fixture.migrate();
      const sql = fixture.client; // Never wrapped in drizzle(), like deployed ingress.
      const credential = `standalone-fixture-${randomUUID()}`;
      const cfg = {
        ...DEFAULT_CONFIG,
        enabled: true,
        callerAgentId: "standalone-fixture",
        stagingGuildId: "fixture-guild",
      };
      await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
      VALUES (${cfg.callerAgentId}, 'fixture-company', ${cfg.stagingGuildId}, ${await sha256Hex(credential)})`;
      const fields = {
        title: "Standalone client",
        game: null,
        description: null,
        location: "Voice",
        capacity: null,
        starts_at: "2099-07-01 20:00",
        ends_at: "2099-07-01 22:00",
        timezone: "Europe/London",
      };
      let event_key: string | undefined;
      for (const op of ["create", "read", "update", "publish", "cancel"]) {
        const body = {
          op,
          idempotency_key: randomUUID(),
          ...(event_key ? { event_key } : {}),
          ...(op === "create"
            ? { fields }
            : op === "update"
              ? { version: 1, fields: { ...fields, title: "Edited" } }
              : {}),
        };
        const original = await handleAgentEvent(sql, cfg, body, credential);
        expect(original.status).toBe(op === "create" ? 201 : 200);
        event_key ??= original.body.event_key as string;
        const [stored] =
          await sql`SELECT jsonb_typeof(body) AS shape, body FROM agent_event_idempotency_keys WHERE key = ${body.idempotency_key}`;
        expect(stored!.shape).toBe("object");
        expect(stored!.body).toEqual(original.body);
        const replay = await handleAgentEvent(sql, cfg, body, credential);
        const { request_id: oldId, ...originalFields } = original.body;
        expect(replay.status).toBe(original.status);
        expect(replay.body).toEqual({
          ...originalFields,
          replayed: true,
          request_id: expect.any(String),
        });
        expect(replay.body.request_id).not.toBe(oldId);
        // Preserve the prior standalone client's double-encoded evidence too.
        await sql`UPDATE agent_event_idempotency_keys SET body = ${sql.json(JSON.stringify(original.body))} WHERE key = ${body.idempotency_key}`;
        expect((await handleAgentEvent(sql, cfg, body, credential)).body).toEqual({
          ...originalFields,
          replayed: true,
          request_id: expect.any(String),
        });
        expect(
          (
            await handleAgentEvent(
              sql,
              cfg,
              { ...body, fields: { ...fields, title: "Different payload" } },
              credential,
            )
          ).body.reason,
        ).toBe("idempotency_conflict");
      }
    }, 30_000);

    it("allows nullable human ownership, enforces shared uniqueness/FKs, and preserves events on grant deletion", async () => {
      await fixture.migrate();
      const sql = fixture.client;
      const first = legacyEvents[0]!;
      const second = legacyEvents[1]!;
      await sql`INSERT INTO events (event_key, title, starts_at, ends_at)
      VALUES ('new-human-one', 'New human one', '2026-10-03T18:00:00Z', '2026-10-03T20:00:00Z'),
             ('new-human-two', 'New human two', '2026-10-04T18:00:00Z', '2026-10-04T20:00:00Z')`;
      const humans = await sql`SELECT agent_grant_id, proof_marker, agent_version
      FROM events WHERE agent_grant_id IS NULL ORDER BY event_key`;
      expect(Array.from(humans)).toEqual(
        Array.from({ length: 4 }, () => ({
          agent_grant_id: null,
          proof_marker: null,
          agent_version: 1,
        })),
      );
      await expect(
        sql`UPDATE events SET agent_grant_id = ${first.grant_id} WHERE event_key = ${second.event_key}`,
      ).rejects.toMatchObject({ code: "23505", constraint_name: "events_agent_grant_id_unique" });
      await expect(
        sql`UPDATE events SET proof_marker = ${first.proof_marker} WHERE event_key = ${second.event_key}`,
      ).rejects.toMatchObject({ code: "23505", constraint_name: "events_proof_marker_unique" });
      await expect(
        sql`UPDATE events SET event_key = ${first.event_key} WHERE event_key = 'new-human-one'`,
      ).rejects.toMatchObject({ code: "23505", constraint_name: "events_event_key_unique" });
      await expect(sql`UPDATE events SET agent_grant_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      WHERE event_key = ${second.event_key}`).rejects.toMatchObject({
        code: "23503",
        constraint_name: "events_agent_grant_id_agent_event_grants_id_fk",
      });

      const eventsBefore = await snapshot(sql, "events");
      const auditsBefore = await snapshot(sql, "agent_event_audits");
      // Audit evidence is append-only (1018): its grant FK's SET NULL is an UPDATE
      // the trigger refuses, so a grant that has audit rows cannot be deleted.
      await expect(
        sql`DELETE FROM agent_event_grants WHERE id = ${first.grant_id}`,
      ).rejects.toMatchObject({ code: "42501" });
      expect(await snapshot(sql, "events")).toEqual(eventsBefore);
      expect(await snapshot(sql, "agent_event_audits")).toEqual(auditsBefore);

      // A grant with no audit rows deletes; its shared event survives (SET NULL).
      const [spare] =
        await sql`INSERT INTO agent_event_grants (agent_id, company_id, guild_id, verifier_hash)
        VALUES ('spare-agent', 'spare-company', 'spare-guild', ${await sha256Hex("spare-credential")}) RETURNING id`;
      await sql`UPDATE events SET agent_grant_id = ${spare!.id} WHERE event_key = 'new-human-one'`;
      const [owned] = await sql`SELECT ics_sequence FROM events WHERE event_key = 'new-human-one'`;
      await sql`DELETE FROM agent_event_grants WHERE id = ${spare!.id}`;
      const [kept] =
        await sql`SELECT agent_grant_id, ics_sequence FROM events WHERE event_key = 'new-human-one'`;
      expect(kept!.agent_grant_id).toBeNull();
      // SET NULL changes the shared row, so the calendar trigger advances once.
      expect(Number(kept!.ics_sequence)).toBe(Number(owned!.ics_sequence) + 1);
      // Replay keys keep their grant-delete CASCADE policy; none belonged to the spare.
      expect(
        (
          await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys WHERE grant_id = ${first.grant_id}`
        )[0]!.n,
      ).toBeGreaterThan(0);
      expect((await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys`)[0]!.n).toBe(
        legacyEvents.length,
      );
    }, 30_000);

    it("aborts a colliding key transaction without altering original tables, rows or evidence", async () => {
      const sql = fixture.client;
      // A late source row collides with a pre-existing human key; no ON CONFLICT
      // skipping, partial copy, schema changes or retirement may survive failure.
      await sql`UPDATE events SET event_key = ${legacyEvents.at(-1)!.event_key} WHERE event_key = 'human-event-two'`;
      const tables = ["events", "agent_events", ...evidenceTables];
      const rowsBefore = await Promise.all(tables.map((table) => snapshot(sql, table)));
      const catalogBefore = await catalog(fixture);

      await expect(fixture.migrate()).rejects.toMatchObject({
        code: "23505",
        constraint_name: "events_event_key_unique",
      });

      expect(await Promise.all(tables.map((table) => snapshot(sql, table)))).toEqual(rowsBefore);
      expect(await catalog(fixture)).toEqual(catalogBefore);
      expect(
        (
          await sql`SELECT to_regclass(${`${fixture.schemaName}.agent_events`}) IS NOT NULL AS retained`
        )[0]!.retained,
      ).toBe(true);
      expect(
        (
          await sql`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = ${fixture.schemaName} AND table_name = 'events'
        AND column_name IN ('agent_grant_id', 'proof_marker', 'agent_version')`
        )[0]!.n,
      ).toBe(0);
    }, 30_000);
  },
);
