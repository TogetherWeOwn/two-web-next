import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { testDatabaseUrl } from "./helpers/member-data-db";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url).href);
const journal = JSON.parse(readFileSync(`${migrationsFolder}/meta/_journal.json`, "utf8")) as {
  entries: { tag: string }[];
};
const migrationIndex = journal.entries.findIndex(({ tag }) => tag === "1013_shared-agent-events");
if (migrationIndex < 1) throw new Error("Canonical migration 1013 is missing from the journal");
const migrations = readMigrationFiles({ migrationsFolder });
const migration1013 = migrations[migrationIndex]!;

// This fixture deliberately stops before 1013; createMemberDataFixture already
// applies it. Keep all scratch DDL and cleanup local to this test file.
async function createMigrationFixture(raw: string) {
  const url = testDatabaseUrl(raw); // Guard before constructing either driver.
  if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") {
    throw new Error("Migration fixtures require agent-testdb/two_web_next; refusing before connecting");
  }
  const schemaName = `agent_migration_${randomUUID().replaceAll("-", "")}`;
  const options = {
    max: 1, port: 5432, connect_timeout: 5,
    // An empty string would fall back to inherited PGPASSWORD in postgres.js.
    password: () => url.password, onnotice: () => {},
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
  const migrate = () => client.begin((sql) => apply(sql, migration1013.sql));
  return { client, schemaName, migrate, dispose };
}

type MigrationFixture = Awaited<ReturnType<typeof createMigrationFixture>>;

const legacyEvents = [
  { status: "draft", timezone: "UTC", starts_at: "2026-10-01 20:00", ends_at: "2026-10-01 22:00",
    startsUtc: "2026-10-01T20:00:00.000Z", endsUtc: "2026-10-01T22:00:00.000Z", version: 1 },
  { status: "published", timezone: "Europe/London", starts_at: "2026-10-01 20:00", ends_at: "2026-10-01 22:00",
    startsUtc: "2026-10-01T19:00:00.000Z", endsUtc: "2026-10-01T21:00:00.000Z", version: 4 },
  { status: "cancelled", timezone: "America/New_York", starts_at: "2026-01-10 20:00", ends_at: "2026-01-10 22:00",
    startsUtc: "2026-01-11T01:00:00.000Z", endsUtc: "2026-01-11T03:00:00.000Z", version: 7 },
  { status: "completed", timezone: "Asia/Kolkata", starts_at: "2026-07-10 20:00", ends_at: "2026-07-10 22:00",
    startsUtc: "2026-07-10T14:30:00.000Z", endsUtc: "2026-07-10T16:30:00.000Z", version: 2 },
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
    const replayBody = { event_key: event.event_key, proof_marker: event.proof_marker,
      agent_version: event.version, status: event.status, request_id: `fixture-request-${index}` };
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

const evidenceTables = ["agent_event_grants", "agent_event_audits", "agent_event_idempotency_keys", "activity_log"];
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
    relations: Array.from(await client`SELECT c.oid::text, c.relname, c.relkind
      FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = ${schemaName} ORDER BY c.relname`),
    columns: Array.from(await client`SELECT table_name, column_name, ordinal_position,
      data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ${schemaName} ORDER BY table_name, ordinal_position`),
    constraints: Array.from(await client`SELECT c.oid::text, c.conname, pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
      WHERE n.nspname = ${schemaName} ORDER BY c.conname`),
  };
}

it("refuses a different agent-testdb database before connecting", async () => {
  await expect(createMigrationFixture("postgres://agent_test@agent-testdb:5432/postgres"))
    .rejects.toThrow("refusing before connecting");
});

describe.skipIf(!process.env.DATABASE_URL)("1013 populated shared-agent-events migration (owned test schema)", () => {
  let fixture: MigrationFixture;
  beforeEach(async () => {
    fixture = await createMigrationFixture(process.env.DATABASE_URL!);
    expect((await fixture.client`SELECT current_schema() AS schema, current_setting('TimeZone') AS timezone`)[0])
      .toEqual({ schema: fixture.schemaName, timezone: "Asia/Tokyo" });
    await seed(fixture.client);
  }, 30_000);
  afterEach(async () => { await fixture?.dispose(); });

  it("preserves populated rows and evidence, converts each zone to UTC, and retires agent_events", async () => {
    const sql = fixture.client;
    const humansBefore = await snapshot(sql, "events");
    const evidenceBefore = await Promise.all(evidenceTables.map((table) => snapshot(sql, table)));
    expect(await snapshot(sql, "agent_events")).toHaveLength(legacyEvents.length);

    await fixture.migrate();

    const migrated = await sql`SELECT event_key, agent_grant_id, proof_marker, agent_version, status,
      title, game, description, starts_at, ends_at, timezone, location, capacity, created_at, updated_at
      FROM events WHERE agent_grant_id IS NOT NULL ORDER BY event_key`;
    expect(Array.from(migrated)).toEqual(legacyEvents.map((event) => ({
      event_key: event.event_key, agent_grant_id: event.grant_id, proof_marker: event.proof_marker,
      agent_version: event.version, status: event.status, title: event.title, game: event.game,
      description: event.description, starts_at: new Date(event.startsUtc), ends_at: new Date(event.endsUtc),
      timezone: event.timezone, location: event.location, capacity: event.capacity,
      created_at: new Date(event.created_at), updated_at: new Date(event.updated_at),
    })));
    const humanRows = await sql<{ row: Record<string, unknown> }[]>`SELECT
      to_jsonb(e) - 'agent_grant_id' - 'proof_marker' - 'agent_version' AS row
      FROM events e WHERE agent_grant_id IS NULL ORDER BY event_key`;
    expect(humanRows.map(({ row }) => row)).toEqual(humansBefore);
    expect((await sql`SELECT count(*)::int AS n, count(DISTINCT id)::int AS ids FROM events`)[0])
      .toEqual({ n: humansBefore.length + legacyEvents.length, ids: humansBefore.length + legacyEvents.length });
    expect(await Promise.all(evidenceTables.map((table) => snapshot(sql, table)))).toEqual(evidenceBefore);
    // Both event_key references and the original replay body still identify the
    // same shared row. Do not invoke ingress, Discord or any network service.
    const references = await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys k
      JOIN events e ON e.event_key = k.event_key AND e.agent_grant_id = k.grant_id
      JOIN agent_event_audits a ON a.event_key = e.event_key AND a.grant_id = e.agent_grant_id
      WHERE k.body->>'event_key' = e.event_key AND k.body->>'proof_marker' = e.proof_marker`;
    expect(references[0]!.n).toBe(legacyEvents.length);
    expect((await sql`SELECT to_regclass(${`${fixture.schemaName}.agent_events`}) AS retired`)[0]!.retired).toBeNull();
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
    expect(Array.from(humans)).toEqual(Array.from({ length: 4 }, () => ({
      agent_grant_id: null, proof_marker: null, agent_version: 1,
    })));
    await expect(sql`UPDATE events SET agent_grant_id = ${first.grant_id} WHERE event_key = ${second.event_key}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "events_agent_grant_id_unique" });
    await expect(sql`UPDATE events SET proof_marker = ${first.proof_marker} WHERE event_key = ${second.event_key}`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "events_proof_marker_unique" });
    await expect(sql`UPDATE events SET event_key = ${first.event_key} WHERE event_key = 'new-human-one'`)
      .rejects.toMatchObject({ code: "23505", constraint_name: "events_event_key_unique" });
    await expect(sql`UPDATE events SET agent_grant_id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
      WHERE event_key = ${second.event_key}`)
      .rejects.toMatchObject({ code: "23503", constraint_name: "events_agent_grant_id_agent_event_grants_id_fk" });

    const eventsBefore = await snapshot(sql, "events");
    const auditsBefore = await snapshot(sql, "agent_event_audits");
    await sql`DELETE FROM agent_event_grants WHERE id = ${first.grant_id}`;
    expect(await snapshot(sql, "events")).toEqual(eventsBefore.map((row) => ({
      ...row, agent_grant_id: row.agent_grant_id === first.grant_id ? null : row.agent_grant_id,
    })));
    // Audit evidence has its own SET NULL FK; replay keys retain their existing
    // grant-delete CASCADE policy. Neither FK may delete the shared event.
    const auditsAfter = await snapshot(sql, "agent_event_audits");
    expect(auditsAfter).toEqual(auditsBefore.map((row) => ({
      ...row, grant_id: row.grant_id === first.grant_id ? null : row.grant_id,
    })));
    expect((await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys WHERE grant_id = ${first.grant_id}`)[0]!.n).toBe(0);
    expect((await sql`SELECT count(*)::int AS n FROM agent_event_idempotency_keys`)[0]!.n).toBe(legacyEvents.length - 1);
  }, 30_000);

  it("aborts a colliding key transaction without altering original tables, rows or evidence", async () => {
    const sql = fixture.client;
    // A late source row collides with a pre-existing human key; no ON CONFLICT
    // skipping, partial copy, schema changes or retirement may survive failure.
    await sql`UPDATE events SET event_key = ${legacyEvents.at(-1)!.event_key} WHERE event_key = 'human-event-two'`;
    const tables = ["events", "agent_events", ...evidenceTables];
    const rowsBefore = await Promise.all(tables.map((table) => snapshot(sql, table)));
    const catalogBefore = await catalog(fixture);

    await expect(fixture.migrate())
      .rejects.toMatchObject({ code: "23505", constraint_name: "events_event_key_unique" });

    expect(await Promise.all(tables.map((table) => snapshot(sql, table)))).toEqual(rowsBefore);
    expect(await catalog(fixture)).toEqual(catalogBefore);
    expect((await sql`SELECT to_regclass(${`${fixture.schemaName}.agent_events`}) IS NOT NULL AS retained`)[0]!.retained).toBe(true);
    expect((await sql`SELECT count(*)::int AS n FROM information_schema.columns
      WHERE table_schema = ${fixture.schemaName} AND table_name = 'events'
        AND column_name IN ('agent_grant_id', 'proof_marker', 'agent_version')`)[0]!.n).toBe(0);
  }, 30_000);
});
