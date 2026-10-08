// Destructive W15 fixtures own a disposable schema, never the caller's tables.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { events, rsvps } from "../../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../../src/db/index";
import { joinAttempts, profiles, users } from "../../src/db/schema";
import { clearAuditRows } from "./audit-rows";

export function testDatabaseUrl(raw: string, runner = process.env): URL {
  const refuse = () => {
    throw new Error(
      "Tests require an approved PostgreSQL test database; refusing before connecting",
    );
  };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse();
  }
  if (
    !["postgres:", "postgresql:"].includes(url.protocol) ||
    url.search ||
    url.hash ||
    (url.port && url.port !== "5432") ||
    !/^\/[a-z][a-z0-9_]*$/.test(url.pathname)
  )
    return refuse();
  // Focused fixtures use these established test databases. Full local checks
  // use a fresh numeric run-owned database; other names are refused even on
  // the test host.
  const dbName = url.pathname.slice(1).toLowerCase();
  const allowedAgentTestDatabase =
    dbName === "postgres" ||
    dbName === "two_web_next" ||
    dbName === "w15_tests" ||
    /^two_web_next_tog[0-9]+$/.test(dbName);
  const agentTest =
    url.hostname === "agent-testdb" &&
    url.username === "agent_test" &&
    url.password === "" &&
    allowedAgentTestDatabase;
  const ciService =
    runner.GITHUB_ACTIONS === "true" &&
    runner.CI === "true" &&
    url.hostname === "localhost" &&
    url.username === "postgres" &&
    url.password === "ci" &&
    url.pathname === "/postgres";
  if (!agentTest && !ciService) return refuse();
  return url;
}

export async function createMemberDataFixture(raw: string, opts: { max?: number } = {}) {
  const url = testDatabaseUrl(raw); // Must run before postgres() or any DDL.
  const schemaName = `w15_${randomUUID().replaceAll("-", "")}`;
  // postgres.js treats password: "" as absent and falls back to PGPASSWORD.
  // A callback pins the authorized empty test password without that fallback.
  // max stays 1 unless the caller runs lock holders + racing requests on the
  // same pool (W9 RSVP race tests hold a transaction open while the app pool
  // serves concurrent writes through the same scoped client).
  const options = {
    max: opts.max ?? 1,
    port: 5432,
    connect_timeout: 5,
    password: () => url.password,
    onnotice: () => {},
  };
  const admin = postgres(url.href, {
    ...options,
    connection: { statement_timeout: 2000, lock_timeout: 1000 },
  });
  const client = postgres(url.href, { ...options, connection: { search_path: schemaName } });
  const db: Db = drizzle(client, { schema: { ...schema, ...adminSchema } });
  let created = false;
  let disposal: Promise<void> | undefined;
  const dispose = () =>
    (disposal ??= (async () => {
      try {
        await client.end({ timeout: 1 });
      } finally {
        try {
          if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
        } finally {
          await admin.end({ timeout: 1 });
        }
      }
    })());
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    // Run canonical migrations, including FKs, inside our schema. No public
    // fallback in search_path and no migration journal or writes in public.
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url).href),
    });
    // One commit for the empty fixture, not one durable commit per statement.
    await client.begin(async (tx) => {
      for (const migration of migrations)
        for (const statement of migration.sql) {
          if (statement.trim())
            await tx.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
        }
    });
  } catch (error) {
    await dispose();
    throw error;
  }
  const reset = async () => {
    if (disposal) throw new Error("W15 fixture is disposed");
    // Deliberately no arbitrary Db argument: only this scoped pool can clean.
    await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
    await db.delete(rsvps);
    await db.delete(profiles);
    await db.delete(joinAttempts);
    await db.delete(events);
    await db.delete(users);
  };
  // client is the same schema-scoped pool behind db (search_path pinned to the
  // owned schema): raw SQL and lock holders through it resolve unqualified
  // names inside the fixture, never in the caller's tables.
  return { db, client, schemaName, reset, dispose };
}

export type MemberDataFixture = Awaited<ReturnType<typeof createMemberDataFixture>>;
