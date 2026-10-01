import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { databaseReadiness, WEB_MIGRATIONS } from "../src/up";
import { testDatabaseUrl } from "./helpers/member-data-db";

const raw = process.env.DATABASE_URL;

describe.skipIf(!raw)("/up real read-only database readiness", () => {
  it("reports a missing web row, then current, empty and unreadable ledgers without migrations", async () => {
    const url = testDatabaseUrl(raw!); // Refuse non-test targets before any connection.
    const schema = `up_${randomUUID().replaceAll("-", "")}`;
    const options = { max: 1, connect_timeout: 3, password: () => url.password, onnotice: () => {} };
    const admin = postgres(url.href, options);
    const reader = postgres(url.href, { ...options, max: 2, connection: { search_path: schema, default_transaction_read_only: true } });
    let hangQueue = false;
    // Redirect only the explicitly-qualified ledger to our owned scratch schema.
    // Real SQL/driver, no public search_path fallback, no global ledger mutation.
    const client = ((strings: TemplateStringsArray) => reader.unsafe(
      hangQueue && strings.join("").includes("queue_jobs") ? "SELECT pg_sleep(10)"
        : strings.join("").replaceAll("drizzle.__drizzle_migrations", `"${schema}".__drizzle_migrations`), [], { prepare: true },
    )) as unknown as Sql;
    const env = {
      APP_URL: "https://next.example.test", DISCORD_CLIENT_ID: "test", DISCORD_GUILD_ID: "test",
      DISCORD_INVITE_URL: "https://discord.gg/test", DISCORD_CLIENT_SECRET: "test",
      DISCORD_BOT_TOKEN: "test", SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      QUEUE_DEPTH_STORE: client,
    } as Env;
    let created = false;
    try {
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      created = true;
      await admin.unsafe(`CREATE TABLE "${schema}".__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`);
      const missing = WEB_MIGRATIONS[1]!;
      for (const entry of WEB_MIGRATIONS.filter((entry) => entry !== missing)) {
        await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES (${entry.tag}, ${entry.when})`;
      }
      await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES ('bot-fixture', 9999999999999)`;
      const pending = await app.request("/up", {}, env);
      expect(pending.status).toBe(503);
      expect(await pending.json()).toMatchObject({ db: "ok", pending_migrations: 1, queue: { status: "unknown" } });
      await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES (${missing.tag}, ${missing.when})`;
      const current = await app.request("/up", {}, env);
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({ db: "ok", pending_migrations: 0, queue: { status: "unknown" } });
      // A real blocked query consumes one connection, not the readiness slot.
      hangQueue = true;
      const started = Date.now();
      const blockedQueue = await app.request("/up", {}, env);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(blockedQueue.status).toBe(200);
      expect(await blockedQueue.json()).toMatchObject({ db: "ok", pending_migrations: 0, queue: { status: "unknown" } });
      hangQueue = false;
      await admin.unsafe(`TRUNCATE "${schema}".__drizzle_migrations`);
      expect(await databaseReadiness(client)).toEqual({ db: "ok", pending_migrations: WEB_MIGRATIONS.length });
      await admin.unsafe(`DROP TABLE "${schema}".__drizzle_migrations`);
      expect(await databaseReadiness(client)).toEqual({ db: "ok", pending_migrations: null });
    } finally {
      await reader.end({ timeout: 0 });
      try { if (created) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`); }
      finally { await admin.end({ timeout: 0 }); }
    }
  }, 10000);
});
