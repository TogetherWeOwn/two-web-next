// Acceptance: Events reminder data model with prune and read-gating (slice 1).
//
// Written FIRST, blind to any implementation, from the design spec (TOG-35932,
// sections 2-4): automatic T-24h/T-1h nudges to members who RSVP going/maybe.
// The Builder implements on this branch and MUST NOT edit this file: every
// assertion below is the contract the implementation has to satisfy.
//
// Contract summary (spec section 3 unless noted):
// - Migration (appended after the 1032 tip, tag mentioning reminder or
//   notification): `profiles.reminder_opt_out boolean NOT NULL DEFAULT false`
//   (existing rows stay subscribed); `event_reminder_mutes(event_id, user_id,
//   created_at, PK(event_id, user_id))` with ON DELETE CASCADE;
//   `notifications(id, user_id, kind, event_id NULL, title, body, url,
//   read_at NULL, created_at)` with kind='event_reminder' and
//   INDEX (user_id, read_at); `event_reminder_deliveries(event_id, user_id,
//   lead, channel, status, error_code NULL, sent_at)` with
//   UNIQUE (event_id, user_id, lead, channel). Delivery columns are
//   ids/codes/timestamps only: no username, avatar, email or message-body
//   columns. `sent_at` is the decision instant (NOT NULL, the prune age).
// - Prune: `EVENT_REMINDER_DELIVERY_RETENTION_DAYS = 90` wired into the
//   existing model:prune cron as `PruneStores.reminderDeliveries`
//   (precedent: searchLog, boardViews), batch-bounded like every other
//   age-pruned table. Cutoff-exact rows survive; re-runs are clean.
// - Reads: the three new tables are member data gated exactly like `rsvps`
//   (owners map + read-classification refuse list). No admin per-user
//   delivery view in v1 (spec section 4.4).
//
// Every new export is reached through a dynamic import plus a definedness
// assertion, never a static named import: a static import of a not-yet-
// existing export fails the whole file at load with a SyntaxError instead
// of the intended per-test RED. Gating behavior uses test-local pgTable
// mirrors: the owners map and the classifier key off table NAMES, so a
// local mirror exercises the identical production gating path without
// pinning the Builder's Drizzle export identifiers.
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { eq, getTableColumns } from "drizzle-orm";
import { integer, pgTable, serial, text } from "drizzle-orm/pg-core";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Hono, type Handler } from "hono";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { recordAccess } from "../src/admin/store";
import { events, memberDataAccessLogs } from "../src/db/admin-schema";
import { observeMemberReads } from "../src/db/member-reads";
import { validateNonSensitiveRead } from "../src/db/read-classification";
import type { Env } from "../src/env";
import { pruneModelTables } from "../src/jobs/cron";
import { pgPruneStores } from "../src/jobs/postgres";
import type { PruneStores } from "../src/jobs/types";
import { bufferedMemberText, keyedMemberRead, memberReadBoundary } from "../src/member-reads";
import { createMemorySessionStore } from "../src/sessions";
import { env, MEMBER, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const root = fileURLToPath(new URL("..", import.meta.url).href);
const read = (rel: string): string => readFileSync(join(root, rel), "utf8");
const normalizeSqlWindow = (statement: string): string => statement.replace(/\s+/g, " ").trim();

const TIP_TAG = "1032_event-public-join-details";
const REMINDER_TABLES = [
  "event_reminder_mutes",
  "notifications",
  "event_reminder_deliveries",
] as const;
const DELIVERY_STATUSES = [
  "sent",
  "skipped_muted",
  "skipped_optout",
  "skipped_cap",
  "skipped_rsvp",
  "skipped_window",
  "failed",
  "dm_blocked",
] as const;

// Test-local mirrors: same table/column names as the contract, so the
// name-keyed owners map and classifier treat them exactly like the
// production Drizzle tables without pinning export identifiers.
const reminderMutesLocal = pgTable("event_reminder_mutes", {
  eventId: integer("event_id").notNull(),
  userId: text("user_id").notNull(),
});
const notificationsLocal = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
});
const reminderDeliveriesLocal = pgTable("event_reminder_deliveries", {
  eventId: integer("event_id").notNull(),
  userId: text("user_id").notNull(),
  lead: text("lead").notNull(),
  channel: text("channel").notNull(),
  status: text("status").notNull(),
});

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listTsFiles(full));
    else if (full.endsWith(".ts") || full.endsWith(".tsx")) out.push(full);
  }
  return out;
}

function journalEntries(): { idx: number; when: number; tag: string }[] {
  return (
    JSON.parse(readFileSync(join(root, "drizzle/meta/_journal.json"), "utf8")) as {
      entries: { idx: number; when: number; tag: string }[];
    }
  ).entries;
}

function reminderJournalIndexes(): { tipIdx: number; reminderIdxs: number[] } {
  const entries = journalEntries();
  const tipIdx = entries.findIndex((entry) => entry.tag === TIP_TAG);
  expect(tipIdx, `journal must still contain the ${TIP_TAG} tip`).toBeGreaterThanOrEqual(0);
  const reminderIdxs = entries
    .map((entry, idx) => ({ entry, idx }))
    .filter(({ entry, idx }) => idx > tipIdx && /reminder|notification/i.test(entry.tag))
    .map(({ idx }) => idx);
  return { tipIdx, reminderIdxs };
}

describe("event reminder data model: migration contract (static, no DB)", () => {
  it("appends a reminder migration after the 1032 tip with a linked snapshot", () => {
    const entries = journalEntries();
    const { tipIdx, reminderIdxs } = reminderJournalIndexes();
    expect(
      reminderIdxs.length,
      "a reminder/notification migration must be appended after the 1032 tip",
    ).toBeGreaterThan(0);
    // Appended in journal order, never spliced into an older gap.
    for (const idx of reminderIdxs) {
      const prev = entries[idx - 1]!;
      const cur = entries[idx]!;
      expect(cur.idx).toBe(prev.idx + 1);
      expect(cur.when).toBeGreaterThan(prev.when);
    }
    // The last matching snapshot is cumulative: it must carry every new object.
    const last = entries[reminderIdxs[reminderIdxs.length - 1]!]!;
    const snapPath = join(root, "drizzle/meta", `${last.tag.split("_")[0]}_snapshot.json`);
    expect(existsSync(snapPath), `snapshot ${snapPath} must exist`).toBe(true);
    const snap = JSON.parse(readFileSync(snapPath, "utf8")) as {
      tables: Record<string, { columns: Record<string, unknown> }>;
    };
    for (const table of REMINDER_TABLES)
      expect(snap.tables[`public.${table}`], `snapshot must define ${table}`).toBeDefined();
    expect(
      snap.tables["public.profiles"]?.columns.reminder_opt_out,
      "snapshot must add profiles.reminder_opt_out",
    ).toBeDefined();
    expect(tipIdx).toBeGreaterThanOrEqual(0);
  });

  it("refuses staging/production database URLs before a driver can connect", () => {
    for (const host of ["production.example.test", "staging.example.test"]) {
      expect(() => testDatabaseUrl(`postgres://agent_test@${host}/two_web_next`, {})).toThrow(
        "refusing before connecting",
      );
    }
  });
});

describe("event reminder data model: prune + gating wiring (static, no DB)", () => {
  it("pins the delivery retention window at 90 days", async () => {
    const constants = (await import("../src/jobs/constants")) as unknown as Record<string, unknown>;
    expect(
      constants.EVENT_REMINDER_DELIVERY_RETENTION_DAYS,
      "EVENT_REMINDER_DELIVERY_RETENTION_DAYS must be exported",
    ).toBe(90);
  });

  it("drains reminderDeliveries in the prune cron at the 90-day cutoff", () => {
    const cron = read("src/jobs/cron.ts");
    for (const pin of [
      "(c) => stores.reminderDeliveries.pruneOlderThan(c),",
      "cutoff(now, EVENT_REMINDER_DELIVERY_RETENTION_DAYS),",
      '["reminderDeliveries", reminderDeliveries.capped]',
      "reminderDeliveries: reminderDeliveries.total,",
      "reminderDeliveries: number;",
    ]) {
      expect(cron, `cron.ts must pin: ${pin}`).toContain(pin);
    }
    expect(read("src/jobs/types.ts"), "PruneStores must carry the new table").toContain(
      "reminderDeliveries: AgePrunedTable;",
    );
  });

  it("prunes deliveries by sent_at in batch-bounded statements", () => {
    const pg = normalizeSqlWindow(read("src/jobs/postgres.ts"));
    expect(pg).toContain("delete from event_reminder_deliveries where id in (");
    expect(pg).toContain("select id from event_reminder_deliveries where sent_at < ${cutoff}");
    expect(pg).toContain("order by id limit ${PRUNE_DELETE_BATCH_SIZE}");
    expect(pg).toContain("returning 1");
  });

  it("covers the reminder tables in the member-read owners map", () => {
    const owners = read("src/db/member-reads.ts");
    for (const table of REMINDER_TABLES)
      expect(owners, `owners map must gate ${table}`).toContain(table);
  });

  it("refuses the reminder tables in non-sensitive reads", () => {
    const classifier = read("src/db/read-classification.ts");
    // The existing rsvps-class gating stays intact: the new tables join it.
    expect(classifier).toContain("users|profiles|rsvps|join_attempts");
    for (const table of REMINDER_TABLES)
      expect(classifier, `classifier must refuse ${table}`).toContain(table);
  });

  it("maps the reminder tables in the production Drizzle schema", () => {
    const schema = read("src/db/admin-schema.ts") + read("src/db/schema.ts");
    for (const table of REMINDER_TABLES)
      expect(schema, `production schema must map ${table}`).toContain(`"${table}"`);
  });

  it("exposes no admin per-user delivery view", () => {
    const offenders = listTsFiles(join(root, "src/admin")).filter((file) =>
      readFileSync(file, "utf8").includes("event_reminder_deliver"),
    );
    expect(
      offenders.map((file) => file.replace(`${root}/`, "")),
      "no admin module may read per-user delivery rows in v1",
    ).toEqual([]);
  });

  it.each([...REMINDER_TABLES])(
    "validateNonSensitiveRead refuses a %s subquery inside an events read",
    (table) => {
      const fields = [{ path: ["id"], field: getTableColumns(events).id }];
      const statement =
        `select "id" from "events" where exists (select 1 from "${table}" ` +
        `where "${table}"."event_id" = "events"."id")`;
      expect(() => validateNonSensitiveRead("events", statement, fields)).toThrow();
    },
  );

  it("control: an rsvps subquery is refused but a search-log subquery passes", () => {
    const fields = [{ path: ["id"], field: getTableColumns(events).id }];
    const statementFor = (table: string): string =>
      `select "id" from "events" where exists (select 1 from "${table}" ` +
      `where "${table}"."event_id" = "events"."id")`;
    // Proves the probe above is shaped correctly: rsvps (member data) throws,
    // while the anonymous search log (no member key) is not a member table.
    expect(() => validateNonSensitiveRead("events", statementFor("rsvps"), fields)).toThrow();
    expect(() =>
      validateNonSensitiveRead("events", statementFor("event_search_logs"), fields),
    ).not.toThrow();
  });
});

describe("event reminder deliveries prune (memory, no DB)", () => {
  function memTable() {
    const at: Date[] = [];
    const cutoffs: Date[] = [];
    return {
      at,
      cutoffs,
      async pruneOlderThan(cutoff: Date): Promise<number> {
        cutoffs.push(cutoff);
        let n = 0;
        for (let i = at.length - 1; i >= 0; i--) {
          if (at[i]! < cutoff) {
            at.splice(i, 1);
            n++;
          }
        }
        return n;
      },
    };
  }

  it("drains reminderDeliveries at the 90-day cutoff; edge survives; re-run is clean", async () => {
    const DAY = 86_400_000;
    const now = new Date("2026-09-30T00:00:00Z");
    const tables = {
      agentEventAudits: memTable(),
      accessLog: memTable(),
      joinAttempts: memTable(),
      idempotencyKeys: memTable(),
      searchLog: memTable(),
      boardViews: memTable(),
      reminderDeliveries: memTable(),
    };
    const stores = {
      ...tables,
      sessions: createMemorySessionStore(() => now.getTime()),
      jobUniqueLocks: {
        async sweepExpired(_now: Date): Promise<number> {
          return 0;
        },
      },
    } as unknown as PruneStores;
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    tables.reminderDeliveries.at.push(old, edge, fresh);

    const counts = (await pruneModelTables(stores, now)) as unknown as Record<string, number>;
    expect(counts.reminderDeliveries).toBe(1);
    expect(tables.reminderDeliveries.at).toEqual([edge, fresh]);
    expect(tables.reminderDeliveries.cutoffs).toEqual([edge, edge]);

    const rerun = (await pruneModelTables(stores, now)) as unknown as Record<string, number>;
    expect(rerun.reminderDeliveries).toBe(0);
  });
});

// Partial-migration fixture: applies the canonical journal through the 1032
// tip, seeds pre-existing rows, then applies only the reminder migration(s),
// so the test proves both the shape and the existing-rows-stay-subscribed
// default. Mirrors test/agent-events-migration.test.ts.
async function createReminderMigrationFixture(raw: string, tipIdx: number, reminderIdxs: number[]) {
  const url = testDatabaseUrl(raw); // Guard before constructing either driver.
  const schemaName = `reminder_migration_${randomUUID().replaceAll("-", "")}`;
  const options = {
    max: 1,
    port: 5432,
    connect_timeout: 5,
    password: () => url.password,
    onnotice: () => {},
  };
  const admin = postgres(url.href, options);
  const client = postgres(url.href, {
    ...options,
    connection: { search_path: schemaName },
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
        await sql.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
      }
    }
  };
  const migrations = readMigrationFiles({
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url).href),
  });
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    await client.begin(async (sql) => {
      for (const migration of migrations.slice(0, tipIdx + 1)) await apply(sql, migration.sql);
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  const applyReminder = () =>
    client.begin(async (sql) => {
      for (const idx of reminderIdxs) await apply(sql, migrations[idx]!.sql);
    });
  return { client, schemaName, applyReminder, dispose };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "event reminder migration up/down (disposable schema)",
  () => {
    it("migrates up then down cleanly; pre-existing rows stay subscribed and intact", async () => {
      const { tipIdx, reminderIdxs } = reminderJournalIndexes();
      expect(
        reminderIdxs.length,
        "a reminder/notification migration must be appended after the 1032 tip",
      ).toBeGreaterThan(0);
      const fixture = await createReminderMigrationFixture(
        process.env.DATABASE_URL!,
        tipIdx,
        reminderIdxs,
      );
      try {
        const sql = fixture.client;
        // Pre-existing rows, written before the reminder migration exists.
        await sql`INSERT INTO profiles (user_id, bio) VALUES ('103000000000000001', 'pre-existing bio')`;
        const [event] = await sql<{ id: number }[]>`INSERT INTO events
          (event_key, title, starts_at, ends_at, status)
          VALUES ('rm-updown-ev-1', 'Pre-existing event', '2099-11-04T20:00:00Z',
            '2099-11-04T22:00:00Z', 'published') RETURNING id`;
        await sql`INSERT INTO rsvps (event_id, user_id, status)
          VALUES (${event!.id}, '103000000000000001', 'going')`;

        await fixture.applyReminder();

        // Up: every new object exists, and the pre-existing member is subscribed.
        const objects = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${fixture.schemaName}
            AND c.relname IN ('event_reminder_mutes', 'notifications', 'event_reminder_deliveries')`;
        expect(objects[0]!.n).toBe(3);
        const [opted] = await sql<{ reminder_opt_out: boolean }[]>`SELECT reminder_opt_out
          FROM profiles WHERE user_id = '103000000000000001'`;
        expect(opted!.reminder_opt_out).toBe(false);
        // The new tables accept rows against the pre-existing event immediately.
        await sql`INSERT INTO event_reminder_mutes (event_id, user_id)
          VALUES (${event!.id}, '103000000000000001')`;
        await sql`INSERT INTO notifications (user_id, kind, event_id, title, body, url)
          VALUES ('103000000000000001', 'event_reminder', ${event!.id}, 'title', 'body',
            'https://next.example.test/events/x')`;
        await sql`INSERT INTO event_reminder_deliveries
          (event_id, user_id, lead, channel, status, sent_at)
          VALUES (${event!.id}, '103000000000000001', '24h', 'site', 'sent', now())`;

        // Down: dropping exactly the new objects leaves prior rows untouched.
        await sql`DROP TABLE IF EXISTS "event_reminder_deliveries"`;
        await sql`DROP TABLE IF EXISTS "event_reminder_mutes"`;
        await sql`DROP TABLE IF EXISTS "notifications"`;
        await sql`ALTER TABLE "profiles" DROP COLUMN IF EXISTS "reminder_opt_out"`;
        const gone = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = ${fixture.schemaName}
            AND c.relname IN ('event_reminder_mutes', 'notifications', 'event_reminder_deliveries')`;
        expect(gone[0]!.n).toBe(0);
        const columns = await sql<{ n: number }[]>`SELECT count(*)::int AS n
          FROM information_schema.columns
          WHERE table_schema = ${fixture.schemaName} AND table_name = 'profiles'
            AND column_name = 'reminder_opt_out'`;
        expect(columns[0]!.n).toBe(0);
        const [profile] = await sql<{ bio: string | null }[]>`SELECT bio FROM profiles
          WHERE user_id = '103000000000000001'`;
        expect(profile!.bio).toBe("pre-existing bio");
        const [kept] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM rsvps
          WHERE event_id = ${event!.id} AND user_id = '103000000000000001'`;
        expect(kept!.n).toBe(1);
      } finally {
        await fixture.dispose();
      }
    }, 60_000);
  },
);

async function expectReminderSchema(sql: postgres.Sql, schemaName: string): Promise<void> {
  const [tables] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ${schemaName}
      AND c.relname IN ('event_reminder_mutes', 'notifications', 'event_reminder_deliveries')`;
  expect(tables!.n, "reminder migration not applied: new tables are missing").toBe(3);
  const [column] = await sql<{ n: number }[]>`SELECT count(*)::int AS n
    FROM information_schema.columns
    WHERE table_schema = ${schemaName} AND table_name = 'profiles'
      AND column_name = 'reminder_opt_out'`;
  expect(column!.n, "reminder migration not applied: profiles.reminder_opt_out is missing").toBe(1);
}

describe.skipIf(!process.env.DATABASE_URL)("event reminder tables shape (test Postgres)", () => {
  let fixture: MemberDataFixture;

  beforeAll(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
  });
  afterAll(() => fixture?.dispose());
  beforeEach(async () => {
    await fixture.reset();
  });

  it("profiles.reminder_opt_out defaults subscribed and toggles per member", async () => {
    await expectReminderSchema(fixture.client, fixture.schemaName);
    const sql = fixture.client;
    const [column] = await sql<
      { is_nullable: string; column_default: string | null }[]
    >`SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = ${fixture.schemaName} AND table_name = 'profiles'
        AND column_name = 'reminder_opt_out'`;
    expect(column!.is_nullable).toBe("NO");
    expect(column!.column_default).toContain("false");
    await sql`INSERT INTO profiles (user_id) VALUES ('104000000000000001')`;
    const [row] = await sql<{ reminder_opt_out: boolean }[]>`SELECT reminder_opt_out
      FROM profiles WHERE user_id = '104000000000000001'`;
    expect(row!.reminder_opt_out).toBe(false);
    await sql`UPDATE profiles SET reminder_opt_out = true WHERE user_id = '104000000000000001'`;
    const [muted] = await sql<{ reminder_opt_out: boolean }[]>`SELECT reminder_opt_out
      FROM profiles WHERE user_id = '104000000000000001'`;
    expect(muted!.reminder_opt_out).toBe(true);
  });

  it("mutes carry PK(event_id, user_id), a cascading event FK, and no user FK", async () => {
    await expectReminderSchema(fixture.client, fixture.schemaName);
    const sql = fixture.client;
    const [event] = await sql<{ id: number }[]>`INSERT INTO events
      (event_key, title, starts_at, ends_at, status)
      VALUES ('rm-shape-ev-mute', 'Mute shape', '2099-11-04T20:00:00Z',
        '2099-11-04T22:00:00Z', 'published') RETURNING id`;
    const pks = await sql<{ definition: string }[]>`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${fixture.schemaName} AND t.relname = 'event_reminder_mutes'
        AND c.contype = 'p'`;
    expect(pks.map((row) => row.definition)).toEqual(["PRIMARY KEY (event_id, user_id)"]);
    const fks = await sql<{ definition: string }[]>`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${fixture.schemaName} AND t.relname = 'event_reminder_mutes'
        AND c.contype = 'f'`;
    expect(fks).toHaveLength(1);
    expect(fks[0]!.definition).toContain("REFERENCES events");
    expect(fks[0]!.definition).toContain("ON DELETE CASCADE");
    expect(fks[0]!.definition).not.toContain("user_id");

    await sql`INSERT INTO event_reminder_mutes (event_id, user_id)
      VALUES (${event!.id}, '104000000000000002')`;
    await expect(
      sql`INSERT INTO event_reminder_mutes (event_id, user_id)
        VALUES (${event!.id}, '104000000000000002')`,
    ).rejects.toMatchObject({ code: "23505" });
    // Deleting the event cascades the mute; the member row is untouched.
    await sql`DELETE FROM events WHERE id = ${event!.id}`;
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM event_reminder_mutes WHERE event_id = ${event!.id}`;
    expect(left!.n).toBe(0);
  });

  it("notifications are generic with INDEX (user_id, read_at) and a cascading event FK", async () => {
    await expectReminderSchema(fixture.client, fixture.schemaName);
    const sql = fixture.client;
    const columns = await sql<
      { column_name: string; is_nullable: string }[]
    >`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = ${fixture.schemaName} AND table_name = 'notifications'
      ORDER BY ordinal_position`;
    const nullability = new Map(columns.map((row) => [row.column_name, row.is_nullable]));
    for (const required of [
      "id",
      "user_id",
      "kind",
      "event_id",
      "title",
      "body",
      "url",
      "read_at",
      "created_at",
    ])
      expect(nullability.has(required), `notifications must define ${required}`).toBe(true);
    for (const notNull of ["id", "user_id", "kind", "title", "body", "url", "created_at"])
      expect(nullability.get(notNull), `${notNull} must be NOT NULL`).toBe("NO");
    for (const nullable of ["event_id", "read_at"])
      expect(nullability.get(nullable), `${nullable} must be nullable`).toBe("YES");
    const indexes = await sql<{ indexdef: string }[]>`SELECT indexdef FROM pg_indexes
      WHERE schemaname = ${fixture.schemaName} AND tablename = 'notifications'`;
    expect(
      indexes.some((row) => row.indexdef.includes("(user_id, read_at)")),
      "notifications must index (user_id, read_at) for the unread query",
    ).toBe(true);
    const fks = await sql<{ definition: string }[]>`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${fixture.schemaName} AND t.relname = 'notifications'
        AND c.contype = 'f'`;
    expect(
      fks.some(
        (row) =>
          row.definition.includes("FOREIGN KEY (event_id)") &&
          row.definition.includes("REFERENCES events") &&
          row.definition.includes("ON DELETE CASCADE"),
      ),
      "notifications.event_id must cascade from events",
    ).toBe(true);
    expect(
      fks.some((row) => row.definition.includes("(user_id)")),
      "notifications.user_id must carry no FK, like rsvps.user_id",
    ).toBe(false);

    const [event] = await sql<{ id: number }[]>`INSERT INTO events
      (event_key, title, starts_at, ends_at, status)
      VALUES ('rm-shape-ev-note', 'Notification shape', '2099-11-04T20:00:00Z',
        '2099-11-04T22:00:00Z', 'published') RETURNING id`;
    // The reminder kind plus a null-event row both store; read_at starts null.
    await sql`INSERT INTO notifications (user_id, kind, event_id, title, body, url)
      VALUES ('104000000000000003', 'event_reminder', ${event!.id}, 'Starts soon',
        'Body', 'https://next.example.test/events/x'),
        ('104000000000000003', 'event_reminder', null, 'No event',
        'Body', 'https://next.example.test/events')`;
    const stored = await sql<
      { kind: string; read_at: Date | null }[]
    >`SELECT kind, read_at FROM notifications WHERE user_id = '104000000000000003' ORDER BY id`;
    expect(stored).toHaveLength(2);
    expect(stored.every((row) => row.kind === "event_reminder")).toBe(true);
    expect(stored.every((row) => row.read_at === null)).toBe(true);
    await sql`DELETE FROM events WHERE id = ${event!.id}`;
    const [left] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications
      WHERE event_id = ${event!.id}`;
    expect(left!.n).toBe(0);
    // The null-event row survives: it references no event.
    const [kept] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM notifications
      WHERE user_id = '104000000000000003'`;
    expect(kept!.n).toBe(1);
  });

  it("deliveries carry UNIQUE(event_id, user_id, lead, channel), all statuses, and no PII columns", async () => {
    await expectReminderSchema(fixture.client, fixture.schemaName);
    const sql = fixture.client;
    const columns = await sql<
      { column_name: string; is_nullable: string }[]
    >`SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = ${fixture.schemaName} AND table_name = 'event_reminder_deliveries'`;
    const names = columns.map((row) => row.column_name);
    const nullability = new Map(columns.map((row) => [row.column_name, row.is_nullable]));
    for (const required of [
      "event_id",
      "user_id",
      "lead",
      "channel",
      "status",
      "error_code",
      "sent_at",
    ])
      expect(names, `deliveries must define ${required}`).toContain(required);
    for (const notNull of ["event_id", "user_id", "lead", "channel", "status", "sent_at"])
      expect(nullability.get(notNull), `${notNull} must be NOT NULL`).toBe("NO");
    expect(nullability.get("error_code"), "error_code must be nullable").toBe("YES");
    for (const banned of ["username", "avatar", "email", "message", "body", "title", "url"])
      expect(names, `deliveries must not store ${banned}`).not.toContain(banned);
    const uniques = await sql<
      { definition: string }[]
    >`SELECT pg_get_constraintdef(c.oid) AS definition
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${fixture.schemaName} AND t.relname = 'event_reminder_deliveries'
        AND c.contype = 'u'`;
    expect(
      uniques.some((row) => row.definition.includes("UNIQUE (event_id, user_id, lead, channel)")),
      "deliveries must dedupe on (event_id, user_id, lead, channel)",
    ).toBe(true);
    const userFks = await sql<{ n: number }[]>`SELECT count(*)::int AS n
      FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = ${fixture.schemaName} AND t.relname = 'event_reminder_deliveries'
        AND c.contype = 'f' AND pg_get_constraintdef(c.oid) LIKE '%(user_id)%'`;
    expect(userFks[0]!.n, "deliveries.user_id must carry no FK").toBe(0);

    const [event] = await sql<{ id: number }[]>`INSERT INTO events
      (event_key, title, starts_at, ends_at, status)
      VALUES ('rm-shape-ev-del', 'Delivery shape', '2099-11-04T20:00:00Z',
        '2099-11-04T22:00:00Z', 'published') RETURNING id`;
    const combos = [
      ["24h", "site"],
      ["24h", "dm"],
      ["1h", "site"],
      ["1h", "dm"],
    ] as const;
    for (const [index, status] of DELIVERY_STATUSES.entries()) {
      const [lead, channel] = combos[index % combos.length]!;
      const userId = `1040000000000000${index < 4 ? "1" : "2"}${index}`;
      await sql`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, error_code, sent_at)
        VALUES (${event!.id}, ${userId}, ${lead}, ${channel}, ${status},
          ${status === "dm_blocked" ? "closed_dms" : null}, now())`;
    }
    const stored = await sql<{ status: string }[]>`SELECT status FROM event_reminder_deliveries
      WHERE event_id = ${event!.id} ORDER BY status`;
    expect(stored.map((row) => row.status).sort()).toEqual([...DELIVERY_STATUSES].sort());
    // A repeated (event, user, lead, channel) tuple is rejected, any status.
    await sql`INSERT INTO event_reminder_deliveries
      (event_id, user_id, lead, channel, status, sent_at)
      VALUES (${event!.id}, '104000000000000099', '24h', 'site', 'sent', now())`;
    await expect(
      sql`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, sent_at)
        VALUES (${event!.id}, '104000000000000099', '24h', 'site', 'failed', now())`,
    ).rejects.toMatchObject({ code: "23505" });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("event reminder delivery prune (test Postgres)", () => {
  const DAY = 86_400_000;
  let fixture: JobsFixture;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(() => fixture?.dispose());

  it("prunes old deliveries, keeps edge and fresh rows, and re-runs clean", async () => {
    const stores = pgPruneStores(sql) as unknown as Record<string, unknown>;
    expect(stores.reminderDeliveries, "pgPruneStores must expose reminderDeliveries").toBeDefined();
    await expectReminderSchema(sql, fixture.schemaName);
    const [event] = await sql<{ id: number }[]>`INSERT INTO events
        (event_key, title, starts_at, ends_at, status)
        VALUES ('rm-prune-ev-1', 'Prune sieve', '2099-11-04T20:00:00Z',
          '2099-11-04T22:00:00Z', 'published') RETURNING id`;
    const now = new Date();
    const old = new Date(now.getTime() - 91 * DAY);
    const edge = new Date(now.getTime() - 90 * DAY);
    const fresh = new Date(now.getTime() - DAY);
    await sql`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, sent_at)
        VALUES (${event!.id}, '105000000000000001', '24h', 'site', 'sent', ${old}),
          (${event!.id}, '105000000000000002', '24h', 'site', 'sent', ${edge}),
          (${event!.id}, '105000000000000003', '1h', 'site', 'skipped_cap', ${fresh})`;

    await sql`DELETE FROM job_unique_locks`;
    const counts = (await pruneModelTables(pgPruneStores(sql), now)) as unknown as Record<
      string,
      number
    >;
    expect(counts.reminderDeliveries).toBe(1);
    const left = await sql<{ user_id: string }[]>`SELECT user_id
        FROM event_reminder_deliveries WHERE event_id = ${event!.id} ORDER BY user_id`;
    expect(left.map((row) => row.user_id)).toEqual(["105000000000000002", "105000000000000003"]);

    const rerun = (await pruneModelTables(pgPruneStores(sql), now)) as unknown as Record<
      string,
      number
    >;
    expect(rerun.reminderDeliveries).toBe(0);
  });

  it("each delivery prune statement deletes at most one batch", async () => {
    const iso = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    try {
      const psql = iso.client;
      const store = (
        pgPruneStores(psql) as unknown as {
          reminderDeliveries?: { pruneOlderThan(cutoff: Date): Promise<number> };
        }
      ).reminderDeliveries;
      expect(store, "pgPruneStores must expose reminderDeliveries").toBeDefined();
      await expectReminderSchema(psql, iso.schemaName);
      const [event] = await psql<{ id: number }[]>`INSERT INTO events
          (event_key, title, starts_at, ends_at, status)
          VALUES ('rm-prune-ev-batch', 'Prune batches', '2099-11-04T20:00:00Z',
            '2099-11-04T22:00:00Z', 'published') RETURNING id`;
      const { PRUNE_DELETE_BATCH_SIZE } = await import("../src/jobs/constants");
      const now = new Date();
      const cutoff = new Date(now.getTime() - 90 * DAY);
      const old = new Date(now.getTime() - 91 * DAY);
      const edge = new Date(cutoff.getTime());
      const fresh = new Date(now.getTime() - DAY);
      const extra = PRUNE_DELETE_BATCH_SIZE + 3;
      await psql`INSERT INTO event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
          SELECT ${event!.id}, '106' || LPAD(g::text, 15, '0'), '24h', 'site', 'sent', ${old}
          FROM generate_series(1, ${extra}) g`;
      await psql`INSERT INTO event_reminder_deliveries (event_id, user_id, lead, channel, status, sent_at)
          VALUES (${event!.id}, '106000000000000001', '1h', 'site', 'sent', ${edge}),
            (${event!.id}, '106000000000000002', '1h', 'dm', 'dm_blocked', ${fresh})`;

      expect(await store!.pruneOlderThan(cutoff)).toBe(PRUNE_DELETE_BATCH_SIZE);
      expect(await store!.pruneOlderThan(cutoff)).toBe(3);
      expect(await store!.pruneOlderThan(cutoff)).toBe(0);
      const left = await psql<{ user_id: string }[]>`SELECT user_id
          FROM event_reminder_deliveries WHERE event_id = ${event!.id} ORDER BY user_id`;
      expect(left.map((row) => row.user_id)).toEqual(["106000000000000001", "106000000000000002"]);
    } finally {
      await iso.dispose();
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "event reminder member-read gating (test Postgres)",
  () => {
    let fixture: MemberDataFixture;
    const declaration = {
      resource: "member",
      action: "list" as const,
      route: "test.reminder-gating",
    };
    const logs = () => fixture.db.select().from(memberDataAccessLogs);

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
    });
    afterAll(() => fixture?.dispose());

    const router = (handler: Handler<{ Bindings: Env }>, viewer = MEMBER.userId) => {
      const app = new Hono<{ Bindings: Env }>();
      app.use("*", (c, next) =>
        memberReadBoundary(
          c,
          { ...declaration, viewer },
          (entry) => recordAccess(fixture.db, entry),
          next,
        ),
      );
      app.get("/existing", handler);
      return app;
    };
    const db = () => observeMemberReads(fixture.db);
    const deny = async (res: Response) => {
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const body = await res.text();
      for (const value of [...PERSONAL_STRINGS, SUBJECT.userId, "select", "subject_count"])
        expect(body).not.toContain(value);
      expect(await logs()).toHaveLength(0);
    };
    const seededEventId = async (): Promise<number> => {
      const [event] = await fixture.client<{ id: number }[]>`SELECT id FROM events
        WHERE event_key = '01J00000000000000000000015'`;
      return event!.id;
    };

    it("control: a keyed rsvps read still serves with one audit row", async () => {
      const { rsvps } = await import("../src/db/admin-schema");
      const app = router(async (c) => {
        const rows = await keyedMemberRead(() => db().select({ userId: rsvps.userId }).from(rsvps));
        return bufferedMemberText(c, `rsvps:${rows.length}`);
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(200);
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it("a keyed deliveries read serves the owner's rows and audits the subject", async () => {
      await expectReminderSchema(fixture.client, fixture.schemaName);
      const eventId = await seededEventId();
      await fixture.client`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, sent_at)
        VALUES (${eventId}, ${SUBJECT.userId}, '24h', 'site', 'sent', now())`;
      const app = router(async (c) => {
        const rows = await keyedMemberRead(() =>
          db()
            .select({ userId: reminderDeliveriesLocal.userId })
            .from(reminderDeliveriesLocal)
            .where(eq(reminderDeliveriesLocal.userId, SUBJECT.userId)),
        );
        return bufferedMemberText(c, `deliveries:${rows.length}`);
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("deliveries:1");
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it("a keyed mutes read serves the owner's rows and audits the subject", async () => {
      await expectReminderSchema(fixture.client, fixture.schemaName);
      const eventId = await seededEventId();
      await fixture.client`INSERT INTO event_reminder_mutes (event_id, user_id)
        VALUES (${eventId}, ${SUBJECT.userId})`;
      const app = router(async (c) => {
        const rows = await keyedMemberRead(() =>
          db()
            .select({ userId: reminderMutesLocal.userId })
            .from(reminderMutesLocal)
            .where(eq(reminderMutesLocal.userId, SUBJECT.userId)),
        );
        return bufferedMemberText(c, `mutes:${rows.length}`);
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("mutes:1");
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it("a keyed notifications read serves the owner's rows and audits the subject", async () => {
      await expectReminderSchema(fixture.client, fixture.schemaName);
      await fixture.client`INSERT INTO notifications (user_id, kind, title, body, url)
        VALUES (${SUBJECT.userId}, 'event_reminder', 'Starts soon', 'Body',
          'https://next.example.test/events/x')`;
      const app = router(async (c) => {
        const rows = await keyedMemberRead(() =>
          db()
            .select({ userId: notificationsLocal.userId })
            .from(notificationsLocal)
            .where(eq(notificationsLocal.userId, SUBJECT.userId)),
        );
        return bufferedMemberText(c, `notifications:${rows.length}`);
      });
      const res = await app.request("/existing", {}, env);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("notifications:1");
      expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId] }]);
    });

    it("an unwrapped deliveries read refuses contents and writes no audit row", async () => {
      await expectReminderSchema(fixture.client, fixture.schemaName);
      const eventId = await seededEventId();
      await fixture.client`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, sent_at)
        VALUES (${eventId}, ${SUBJECT.userId}, '24h', 'site', 'sent', now())`;
      const app = router(async (c) => {
        await db().select({ userId: reminderDeliveriesLocal.userId }).from(reminderDeliveriesLocal);
        return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
      });
      await deny(await app.request("/existing", {}, env));
    });

    it("a deliveries read without its owner projection refuses contents", async () => {
      await expectReminderSchema(fixture.client, fixture.schemaName);
      const eventId = await seededEventId();
      await fixture.client`INSERT INTO event_reminder_deliveries
        (event_id, user_id, lead, channel, status, sent_at)
        VALUES (${eventId}, ${SUBJECT.userId}, '24h', 'site', 'sent', now())`;
      const app = router(async (c) => {
        await keyedMemberRead<unknown>(() =>
          db().select({ status: reminderDeliveriesLocal.status }).from(reminderDeliveriesLocal),
        );
        return bufferedMemberText(c, PERSONAL_STRINGS[1]!);
      });
      await deny(await app.request("/existing", {}, env));
    });
  },
);
