// Explicit disposable Postgres when supplied; otherwise execute the emitted SQL
// against local SQLite tables. No network fallback and no canned filtered rows.
import { DatabaseSync } from "node:sqlite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle as proxyDrizzle } from "drizzle-orm/pg-proxy";
import { drizzle } from "drizzle-orm/postgres-js";
import { events, memberDataAccessLogs, rsvps } from "../../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../../src/db/index";
import { createMemberDataFixture } from "./member-data-db";

type EventInput = typeof events.$inferInsert;
type RsvpInput = typeof rsvps.$inferInsert;
export type PlanningQuery = { sql: string; params: unknown[] };
export type PlanningWindowFixture = {
  db: Db;
  insertEvent: (values: EventInput) => Promise<{ id: number }>;
  insertRsvp: (values: RsvpInput) => Promise<void>;
  setStartInstant: (id: number, instant: string) => Promise<void>;
  reset: () => Promise<void>;
  dispose: () => Promise<void>;
};

// Keep six decimal places: JS Date truncates the two microsecond neighbors that
// distinguish the inclusive lower and exclusive upper boundary in this suite.
function bind(value: unknown): string | number | bigint | null {
  if (value instanceof Date) return bind(value.toISOString());
  if (typeof value === "boolean") return Number(value);
  if (typeof value === "string") {
    const instant = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?Z$/.exec(value);
    return instant ? `${instant[1]}.${(instant[2] ?? "").padEnd(6, "0")}Z` : value;
  }
  if (value === null || value === undefined) return null;
  if (typeof value === "number" || typeof value === "bigint") return value;
  throw new Error("Unsupported planning-window SQL fixture parameter");
}

export async function createPlanningWindowFixture(
  queries: PlanningQuery[],
  databaseUrl = process.env.DATABASE_URL,
): Promise<PlanningWindowFixture> {
  if (databaseUrl) {
    // The shared guard refuses non-test URLs before any connection or DDL. A
    // failure here propagates; never retry it using the offline backend.
    const fixture = await createMemberDataFixture(databaseUrl);
    const db = drizzle(fixture.client, {
      schema: { ...schema, ...adminSchema },
      logger: { logQuery: (sql, params) => queries.push({ sql, params }) },
    });
    return {
      db,
      insertEvent: async (values) => (await db.insert(events).values(values).returning())[0]!,
      insertRsvp: async (values) => {
        await db.insert(rsvps).values(values);
      },
      setStartInstant: async (id, instant) => {
        await fixture.client`UPDATE events SET starts_at = ${instant}::timestamptz WHERE id = ${id}`;
      },
      reset: fixture.reset,
      dispose: fixture.dispose,
    };
  }

  const local = new DatabaseSync(":memory:");
  for (const table of [events, rsvps, memberDataAccessLogs]) {
    const columns = Object.values(getTableColumns(table)).map((column) => {
      if (column.name === "id") return '"id" integer primary key';
      const numeric = /^(?:integer|bigint|boolean)$/.test(column.getSQLType());
      return `"${column.name}" ${numeric ? "integer" : "text"}`;
    });
    local.exec(`create table "${getTableName(table)}" (${columns.join(", ")})`);
  }
  const db = proxyDrizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (
      sql ===
      "select set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)"
    ) {
      if (params[0] !== "2000ms" || params[1] !== "2000ms")
        throw new Error("Planning-window fixture requires the real bounded-read timeouts");
      return { rows: [] };
    }
    // Our fixtures are ASCII; SQLite LIKE implements their ILIKE comparisons.
    // Everything else (AND/OR, correlated RSVP counts, sorting and LIMIT/OFFSET)
    // executes as SQL, not as a hand-coded mirror of the production filters.
    const query = local.prepare(sql.replace(/\bilike\b/gi, "like").replace(/\$(\d+)/g, "?$1"));
    query.setReturnArrays(true);
    const rows = query.all(...params.map(bind));
    if (!rows.every(Array.isArray))
      throw new Error("Planning-window SQL fixture must preserve positional projections");
    return { rows };
  }) as unknown as Db;
  const session = (
    db as unknown as {
      session: { transaction: (fn: (tx: Db) => Promise<unknown>) => Promise<unknown> };
    }
  ).session;
  session.transaction = async (fn) => {
    local.exec("begin");
    try {
      const result = await fn(db);
      local.exec("commit");
      return result;
    } catch (error) {
      local.exec("rollback");
      throw error;
    }
  };

  const insert = (table: typeof events | typeof rsvps, values: Record<string, unknown>) => {
    const columns = getTableColumns(table);
    const entries = Object.entries(values).filter(([key]) => key in columns);
    const names = entries.map(([key]) => `"${columns[key as keyof typeof columns].name}"`);
    const marks = entries.map(() => "?");
    return local
      .prepare(`insert into "${getTableName(table)}" (${names}) values (${marks}) returning id`)
      .get(...entries.map(([, value]) => bind(value))) as { id: number };
  };
  const now = new Date("2030-01-01T12:00:00Z");
  return {
    db,
    insertEvent: async (values) =>
      insert(events, {
        icsSequence: 0n,
        status: "draft",
        timezone: "UTC",
        rsvpOpen: true,
        syncRevision: 0,
        syncedRevision: 0,
        agentVersion: 1,
        createdAt: now,
        updatedAt: now,
        ...values,
      }),
    insertRsvp: async (values) => {
      insert(rsvps, { createdAt: now, updatedAt: now, ...values });
    },
    setStartInstant: async (id, instant) => {
      local.prepare('update "events" set "starts_at" = ? where "id" = ?').run(bind(instant), id);
    },
    reset: async () => {
      local.exec(
        'delete from "rsvps"; delete from "events"; delete from "member_data_access_logs"',
      );
    },
    dispose: async () => local.close(),
  };
}
