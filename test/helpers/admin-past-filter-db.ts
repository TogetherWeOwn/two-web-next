// Test-only backend for the Past-filter acceptance contract. A supplied URL
// always takes the guarded PostgreSQL path; an absent URL uses local fixtures.
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { getTableColumns, getTableName } from "drizzle-orm";
import { drizzle as proxyDrizzle } from "drizzle-orm/pg-proxy";
import { drizzle } from "drizzle-orm/postgres-js";
import { events, rsvps } from "../../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../../src/db/index";
import { users } from "../../src/db/schema";
import { savedNightRow } from "./admin-event-find-saved-nights";
import { createMemberDataFixture } from "./member-data-db";

type Seed = typeof events.$inferInsert;

export async function createPastFilterFixture(raw: string | undefined) {
  const statements: string[] = [];
  const logger = { logQuery: (sql: string) => statements.push(sql) };
  if (raw !== undefined) {
    const fixture = await createMemberDataFixture(raw);
    return {
      ...fixture,
      backend: "PostgreSQL",
      statements,
      countedDb: drizzle(fixture.client, { schema: { ...schema, ...adminSchema }, logger }),
      seed: async (rows: Seed[]) => {
        await fixture.db.insert(events).values(rows);
      },
    };
  }

  // Execute the emitted predicates, ORDER BY, count, LIMIT and OFFSET rather
  // than returning prefiltered rows. SQLite is only a fixture engine, not proof
  // of PostgreSQL's collation, timeouts, migrations or transaction semantics.
  // These cases use wildcard-free ASCII search text and canonical ISO timestamps.
  // The only dialect translation is ILIKE -> LIKE (ASCII-insensitive in SQLite);
  // PostgreSQL's backslash wildcard escaping is not emulated by this fixture.
  const local = new DatabaseSync(":memory:");
  for (const table of [events, rsvps, users]) {
    const columns = Object.values(getTableColumns(table)).map((column) => `"${column.name}"`);
    local.exec(`create table "${getTableName(table)}" (${columns.join(", ")})`);
  }
  local.function("set_config", (name, value, transactionLocal) => {
    if (
      !["lock_timeout", "statement_timeout"].includes(String(name)) ||
      value !== "2000ms" ||
      transactionLocal !== 1
    )
      throw new Error("Unexpected Past-filter timeout configuration");
    return value;
  });
  const proxy = proxyDrizzle(
    async (sql, params) => {
      if (!/^select\b/i.test(sql)) throw new Error(`Unexpected Past-filter fixture query: ${sql}`);
      const query = local.prepare(sql.replace(/\bilike\b/gi, "like"));
      query.setReturnArrays(true);
      const bindings = Object.fromEntries(params.map((value, i) => [`$${i + 1}`, value]));
      return { rows: query.all(bindings) };
    },
    { schema: { ...schema, ...adminSchema }, logger },
  );
  const db = proxy as unknown as Db;
  // Shim the session so member-read instrumentation's cloned adapters also
  // execute the same local transaction, as in the page-shell fixtures.
  const session = (
    proxy as unknown as {
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
  const columns = Object.entries(getTableColumns(events));
  const insert = local.prepare(
    `insert into "events" (${columns.map(([, column]) => `"${column.name}"`).join(", ")}) values (${columns.map(() => "?").join(", ")})`,
  );
  let nextId = 1;
  return {
    db,
    backend: "SQLite (offline fixtures)",
    countedDb: db,
    statements,
    reset: async () => {
      local.exec('delete from "events"');
      nextId = 1;
    },
    seed: async (rows: Seed[]) => {
      for (const seed of rows) {
        const row = savedNightRow(seed.eventKey, { capacity: null, ...seed, id: nextId++ });
        const values = columns.map(([key]) => {
          const value = row[key as keyof typeof row];
          return value instanceof Date
            ? value.toISOString()
            : typeof value === "boolean"
              ? Number(value)
              : (value ?? null);
        });
        insert.run(...(values as SQLInputValue[]));
      }
    },
    dispose: async () => local.close(),
  };
}

export type PastFilterFixture = Awaited<ReturnType<typeof createPastFilterFixture>>;
