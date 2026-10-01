// Destructive W15 fixtures own a disposable schema, never the caller's tables.
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { activityLog, events, memberDataAccessLogs, rsvps } from "../../src/db/admin-schema";
import { adminSchema, schema, type Db } from "../../src/db/index";
import { joinAttempts, profiles, users } from "../../src/db/schema";
import { startDbPhase } from "./diagnostic-timing";

export function testDatabaseUrl(raw: string, runner = process.env): URL {
  const refuse = () => { throw new Error("W15 requires agent-testdb or the GitHub CI Postgres service; refusing before connecting"); };
  let url: URL;
  try { url = new URL(raw); } catch { return refuse(); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.search || url.hash
    || (url.port && url.port !== "5432") || !/^\/[a-z][a-z0-9_]*$/.test(url.pathname)) return refuse();
  const agentTest = url.hostname === "agent-testdb" && url.username === "agent_test" && url.password === "";
  const ciService = runner.GITHUB_ACTIONS === "true" && runner.CI === "true"
    && url.hostname === "localhost" && url.username === "postgres" && url.password === "ci" && url.pathname === "/postgres";
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
  const options = { max: opts.max ?? 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {} };
  const admin = postgres(url.href, options);
  const client = postgres(url.href, { ...options, connection: { search_path: schemaName } });
  const db: Db = drizzle(client, { schema: { ...schema, ...adminSchema } });
  let created = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    const finish = startDbPhase("member-data", "dispose");
    let ok = false;
    try {
      try {
        await client.end();
        if (created) await admin.unsafe(`DROP SCHEMA "${schemaName}" CASCADE`);
      } finally { await admin.end(); }
      ok = true;
    } finally { finish(ok); }
  };
  let finish = startDbPhase("member-data", "create");
  try {
    await admin.unsafe(`CREATE SCHEMA "${schemaName}"`);
    created = true;
    finish();
    // Run canonical migrations, including FKs, inside our schema. No public
    // fallback in search_path and no migration journal or writes in public.
    finish = startDbPhase("member-data", "migration-read");
    const migrations = readMigrationFiles({ migrationsFolder: fileURLToPath(new URL("../../drizzle", import.meta.url).href) });
    finish();
    finish = startDbPhase("member-data", "migrate");
    for (const migration of migrations) for (const statement of migration.sql) {
      if (statement.trim()) await client.unsafe(statement.replaceAll('"public".', `"${schemaName}".`));
    }
    finish();
  } catch (error) {
    finish(false);
    await dispose();
    throw error;
  }
  const reset = async () => {
    if (disposed) throw new Error("W15 fixture is disposed");
    const finish = startDbPhase("member-data", "reset");
    let ok = false;
    try {
      // Deliberately no arbitrary Db argument: only this scoped pool can clean.
      await db.delete(memberDataAccessLogs);
      await db.delete(activityLog);
      await db.delete(rsvps);
      await db.delete(profiles);
      await db.delete(joinAttempts);
      await db.delete(events);
      await db.delete(users);
      ok = true;
    } finally { finish(ok); }
  };
  // client is the same schema-scoped pool behind db (search_path pinned to the
  // owned schema): raw SQL and lock holders through it resolve unqualified
  // names inside the fixture, never in the caller's tables.
  return { db, client, schemaName, reset, dispose };
}

export type MemberDataFixture = Awaited<ReturnType<typeof createMemberDataFixture>>;
