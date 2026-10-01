import { randomUUID } from "node:crypto";
import postgres from "postgres";
import fixture from "../fixtures/legacy/users-profiles.sql?raw";
import usersMigration from "../../drizzle/0000_init-users.sql?raw";
import profilesMigration from "../../drizzle/1003_profiles.sql?raw";
import { testDatabaseUrl } from "./member-data-db";

export async function createUsersProfilesFixture(raw: string) {
  const url = testDatabaseUrl(raw); // Refuse query overrides before constructing a driver or running DDL.
  if (url.hostname === "agent-testdb" && url.pathname !== "/two_web_next") {
    throw new Error("Import tests require agent-testdb/two_web_next; refusing before connecting");
  }
  const suffix = randomUUID().replaceAll("-", "");
  const legacySchema = `legacy_up_${suffix}`;
  const nextSchema = `next_up_${suffix}`;
  const options = { max: 1, port: 5432, connect_timeout: 5, password: () => url.password, onnotice: () => {} };
  const admin = postgres(url.href, options);
  const legacy = postgres(url.href, { ...options, connection: { search_path: legacySchema } });
  const next = postgres(url.href, { ...options, connection: { search_path: nextSchema } });
  let created = false;
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    try {
      await Promise.all([legacy.end(), next.end()]);
      if (created) await admin.unsafe(`DROP SCHEMA "${legacySchema}" CASCADE; DROP SCHEMA "${nextSchema}" CASCADE`);
    } finally { await admin.end(); }
  };
  try {
    await admin.begin(async (sql) => {
      await sql.unsafe(`CREATE SCHEMA "${legacySchema}"; CREATE SCHEMA "${nextSchema}"`);
    });
    created = true;
    await next.unsafe(usersMigration);
    await next.unsafe(profilesMigration);
  } catch (error) {
    await dispose();
    throw error;
  }
  const reset = async () => {
    if (disposed) throw new Error("Import fixture is disposed");
    await legacy.unsafe("DROP TABLE IF EXISTS profiles; DROP TABLE IF EXISTS users");
    await legacy.unsafe(fixture);
    await next`delete from profiles`;
    await next`delete from users`;
  };
  const scopedUrl = (schema: string) => {
    const scoped = new URL(url.href);
    scoped.searchParams.set("search_path", schema);
    // Prove UTC preservation independently of the caller's connection timezone.
    scoped.searchParams.set("timezone", "Pacific/Honolulu");
    return scoped.toString();
  };
  const env = { LEGACY_DATABASE_URL: scopedUrl(legacySchema), DATABASE_URL: scopedUrl(nextSchema) };
  return { legacy, next, env, reset, dispose };
}

export type UsersProfilesFixture = Awaited<ReturnType<typeof createUsersProfilesFixture>>;
