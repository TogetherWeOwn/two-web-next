import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import * as schema from "../src/db/schema";
import usersMigration from "../drizzle/0000_init-users.sql?raw";

// Live round-trip against agent-testdb in a throwaway schema (same convention
// as the W6/W14 agent-testdb suites). Skipped when DATABASE_URL is unset (CI
// has no test-DB access), so the cold CI run stays green. Never point this at
// anything but agent-testdb.
describe.skipIf(!process.env.DATABASE_URL)("users table", () => {
  const schemaName = `w3_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  let sql: postgres.Sql;
  let admin: postgres.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;

  beforeAll(async () => {
    admin = postgres(process.env.DATABASE_URL!, { max: 1 });
    await admin.unsafe(`CREATE SCHEMA ${schemaName}`);
    sql = postgres(process.env.DATABASE_URL!, { max: 4, connection: { search_path: schemaName }, onnotice: () => {} });
    // Canonical migration SQL is the source of truth, not the runtime DDL.
    for (const stmt of usersMigration.split("--> statement-breakpoint")) {
      if (stmt.trim()) await sql.unsafe(stmt);
    }
    db = drizzle(sql, { schema });
  });
  afterAll(async () => {
    await sql?.end();
    await admin?.unsafe(`DROP SCHEMA IF EXISTS ${schemaName} CASCADE`);
    await admin?.end();
  });

  it("inserts, reads, updates and deletes a row", async () => {
    const id = `test-${Date.now()}`;

    await db.insert(schema.users).values({ id, username: "rick", member: false });
    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(row?.username).toBe("rick");
    expect(row?.member).toBe(false);
    expect(row?.createdAt).toBeInstanceOf(Date);

    await db.update(schema.users).set({ member: true }).where(eq(schema.users.id, id));
    const [updated] = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(updated?.member).toBe(true);

    await db.delete(schema.users).where(eq(schema.users.id, id));
    const after = await db.select().from(schema.users).where(eq(schema.users.id, id));
    expect(after).toHaveLength(0);
  });
});
