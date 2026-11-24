import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { productionUploadConfig } from "./kit-cutover-evidence.mjs";

export function fixtureDatabase(value, host) {
  assert.match(host ?? "", /^ep-[a-z0-9-]+\.[a-z0-9.-]+\.neon\.tech$/);
  const url = URL.canParse(value) ? new URL(value) : null;
  assert.ok(
    url?.protocol === "postgresql:" &&
      url.hostname === host &&
      !url.hostname.includes("-pooler.") &&
      (url.port === "" || url.port === "5432") &&
      url.pathname === "/two_web_cutover" &&
      url.username === "two_web_cutover_owner" &&
      url.password &&
      !url.search &&
      !url.hash,
    "isolated cutover requires its dedicated direct synthetic database and owner",
  );
  url.searchParams.set("sslmode", "verify-full");
  return url;
}

export function fixtureNames(runId, runAttempt) {
  const suffix = `${runId}-${runAttempt}`;
  assert.match(suffix, /^[1-9]\d{0,14}-[1-9]\d{0,14}$/);
  const db = `two_web_cutover_${runId}_${runAttempt}`;
  return { suffix, db, login: `${db}_runtime` };
}

function connect(url) {
  return postgres(url.href, {
    max: 1,
    prepare: false,
    connect_timeout: 10,
    connection: { statement_timeout: 90_000, lock_timeout: 10_000 },
    onnotice: () => {},
  });
}

async function exists(sql, { db, login }) {
  const [row] = await sql`SELECT
    EXISTS (SELECT FROM pg_database WHERE datname = ${db}) AS db,
    EXISTS (SELECT FROM pg_roles WHERE rolname = ${login}) AS login`;
  return row.db || row.login;
}

export async function createFixture(url, names, claim) {
  const { db, login } = names;
  const control = connect(url);
  const password = randomUUID();
  const expiry = new Date(Date.now() + 45 * 60_000).toISOString();
  try {
    const [{ owned }] = await control`SELECT current_user = pg_get_userbyid(datdba) AS owned
      FROM pg_database WHERE datname = current_database()`;
    assert.ok(owned && !(await exists(control, names)), "fixture resources are not fresh");
    await claim();
    // This control database and its project are dedicated to synthetic work.
    await control`REVOKE CONNECT ON DATABASE two_web_cutover FROM PUBLIC`;
    await control`CREATE DATABASE ${control(db)} TEMPLATE template0`;
    await control`REVOKE CONNECT ON DATABASE ${control(db)} FROM PUBLIC`;
    await control`CREATE ROLE ${control(login)} LOGIN PASSWORD ${control.unsafe(`'${password}'`)}
      VALID UNTIL ${control.unsafe(`'${expiry}'`)}`;
    await control`GRANT CONNECT ON DATABASE ${control(db)} TO ${control(login)}`;
  } finally {
    await control.end({ timeout: 0 });
  }
  const ownerUrl = new URL(url);
  ownerUrl.pathname = `/${db}`;
  const owner = connect(ownerUrl);
  const runtimeUrl = new URL(ownerUrl);
  runtimeUrl.username = login;
  runtimeUrl.password = password;
  try {
    await owner.unsafe(await readFile("ci/disposable-runtime-role.sql", "utf8")).simple();
    await owner`CREATE SCHEMA drizzle`;
    await owner`CREATE TABLE drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint
    )`;
    await owner.unsafe(await readFile("docs/web-readiness-projection.sql", "utf8")).simple();
    return { owner, runtimeUrl };
  } catch (error) {
    await owner.end({ timeout: 0 });
    throw error;
  }
}

export async function removeFixture(url, names) {
  const control = connect(url);
  try {
    await control`DROP DATABASE IF EXISTS ${control(names.db)} WITH (FORCE)`;
    await control`DROP ROLE IF EXISTS ${control(names.login)}`;
    assert.ok(!(await exists(control, names)), "synthetic database or login remains");
  } finally {
    await control.end({ timeout: 0 });
  }
}

export async function advanceFixture(owner, expected, runtimeLogin) {
  const migrations = readMigrationFiles({ migrationsFolder: "drizzle" });
  const applied =
    await owner`SELECT created_at::text, hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
  for (const [index, row] of applied.entries()) {
    assert.equal(Number(row.created_at), migrations[index]?.folderMillis);
    assert.equal(row.hash, migrations[index]?.hash);
  }
  const pending = migrations.slice(applied.length, expected.length);
  assert.ok(pending.length > 0, "synthetic ledger must advance");
  await owner.begin(async (sql) => {
    for (const migration of pending) {
      for (const statement of migration.sql) {
        if (statement.trim()) await sql.unsafe(statement);
      }
      await sql`INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})`;
    }
    await sql`GRANT USAGE ON SCHEMA public, web_readiness TO ${sql(runtimeLogin)}`;
    await sql`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${sql(runtimeLogin)}`;
    await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${sql(runtimeLogin)}`;
    await sql`GRANT SELECT ON web_readiness.migration_timestamps TO ${sql(runtimeLogin)}`;
  });
  const rows =
    await owner`SELECT created_at::text FROM drizzle.__drizzle_migrations ORDER BY created_at, id`;
  assert.deepEqual(
    rows.map(({ created_at }) => Number(created_at)),
    expected,
  );
}

export function stagingConfig(profile, inputs, worker, origin, ember) {
  const config = productionUploadConfig(profile, inputs, ember);
  return {
    name: worker,
    main: config.main,
    base_dir: config.base_dir,
    ...(config.rules ? { rules: config.rules } : {}),
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
    assets: config.assets,
    version_metadata: config.version_metadata,
    workers_dev: true,
    preview_urls: false,
    vars: {
      ...Object.fromEntries(
        Object.entries(config.vars).filter(
          ([name]) => name.startsWith("KIT_ROUTE_") || name === "DISCORD_LIVE_SOCKET_ENABLED",
        ),
      ),
      APP_URL: origin,
      FEATURED_IMAGE_HOSTS: "",
      DISCORD_CLIENT_ID: "100000000000000001",
      DISCORD_GUILD_ID: "100000000000000002",
      DISCORD_INVITE_URL: "https://discord.gg/cutover-fixture",
    },
  };
}
