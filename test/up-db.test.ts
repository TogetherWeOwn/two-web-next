import { randomUUID } from "node:crypto";
import postgres, { type Sql } from "postgres";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { databaseReadiness, upBody, WEB_MIGRATIONS, withHealthReadTimeout } from "../src/up";
import { pgQueueDepth } from "../src/jobs/postgres";
import { testDatabaseUrl } from "./helpers/member-data-db";
import { healthSql } from "./helpers/up";

const raw = process.env.DATABASE_URL;

function scopedHealthSql(
  reader: Sql,
  schema: string,
  slow?: "ping" | "queue",
  afterSetup?: () => Promise<void>,
): Sql {
  const wrap = (sql: Pick<Sql, "unsafe">): Sql =>
    (async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.reduce((text, part, i) => text + (i ? `$${i}` : "") + part, "");
      const result = await sql.unsafe(
        (slow === "queue" && query.includes("queue_jobs")) ||
          (slow === "ping" && query.startsWith("SELECT clock_timestamp"))
          ? "SELECT pg_sleep(10)"
          : query.replaceAll("drizzle.__drizzle_migrations", `"${schema}".__drizzle_migrations`),
        values as Parameters<Sql["unsafe"]>[1],
        { prepare: true },
      );
      if (query.includes("set_config")) await afterSetup?.();
      return result;
    }) as unknown as Sql;
  return Object.assign(wrap(reader), {
    begin: (options: string, fn: (sql: Sql) => Promise<unknown>) =>
      reader.begin(options, (tx) => fn(wrap(tx))),
  });
}

describe.skipIf(!raw)("/up real read-only database readiness", () => {
  it("reports a missing web row, then current, empty and unreadable ledgers without migrations", async () => {
    const url = testDatabaseUrl(raw!); // Refuse non-test targets before any connection.
    const schema = `up_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      connect_timeout: 3,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const reader = postgres(url.href, {
      ...options,
      max: 2,
      connection: {
        search_path: schema,
        application_name: schema,
        default_transaction_read_only: true,
      },
    });
    let hangQueue = false;
    // Redirect only the explicitly-qualified ledger to our owned scratch schema.
    // Real SQL/driver, no public search_path fallback, no global ledger mutation.
    const client = scopedHealthSql(reader, schema);
    const queueClient = scopedHealthSql(reader, schema, "queue");
    const envFor = () => ({ ...env, QUEUE_DEPTH_STORE: hangQueue ? queueClient : client });
    const env = {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "test",
      DISCORD_GUILD_ID: "test",
      DISCORD_INVITE_URL: "https://discord.gg/test",
      DISCORD_CLIENT_SECRET: "test",
      DISCORD_BOT_TOKEN: "test",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
      QUEUE_DEPTH_STORE: client,
    } as Env;
    let created = false;
    try {
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      created = true;
      await admin.unsafe(
        `CREATE TABLE "${schema}".__drizzle_migrations (id serial PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      );
      const missing = WEB_MIGRATIONS[1]!;
      for (const entry of WEB_MIGRATIONS.filter((entry) => entry !== missing)) {
        await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES (${entry.tag}, ${entry.when})`;
      }
      await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES ('bot-fixture', 9999999999999)`;
      const pending = await app.request("/up", {}, envFor());
      expect(pending.status).toBe(503);
      expect(await pending.json()).toMatchObject({
        db: "ok",
        pending_migrations: 1,
        queue: { status: "unknown" },
      });
      await admin`INSERT INTO ${admin(schema)}.__drizzle_migrations (hash, created_at) VALUES (${missing.tag}, ${missing.when})`;
      const current = await app.request("/up", {}, envFor());
      expect(current.status).toBe(200);
      expect(await current.json()).toMatchObject({
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown" },
      });
      // A real blocked query consumes one connection, not the readiness slot.
      hangQueue = true;
      const started = Date.now();
      const blockedQueue = await app.request("/up", {}, envFor());
      expect(Date.now() - started).toBeLessThan(4000);
      expect(blockedQueue.status).toBe(200);
      expect(await blockedQueue.json()).toMatchObject({
        db: "ok",
        pending_migrations: 0,
        queue: { status: "unknown" },
      });
      hangQueue = false;
      const [activity] = await admin<{ active: number }[]>`
        SELECT count(*)::int AS active FROM pg_stat_activity
        WHERE application_name = ${schema} AND state = 'active'
      `;
      expect(activity?.active).toBe(0); // Server stopped pg_sleep without closing this injected pool.
      await admin.unsafe(`TRUNCATE "${schema}".__drizzle_migrations`);
      expect(await databaseReadiness(client)).toEqual({
        db: "ok",
        pending_migrations: WEB_MIGRATIONS.length,
      });
      await admin.unsafe(`DROP TABLE "${schema}".__drizzle_migrations`);
      expect(await databaseReadiness(client)).toEqual({ db: "ok", pending_migrations: null });
    } finally {
      await reader.end({ timeout: 0 });
      try {
        if (created) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end({ timeout: 0 });
      }
    }
  }, 10000);

  it("aborts a slow ping server-side and restores local limits without closing the injected pool", async () => {
    const url = testDatabaseUrl(raw!);
    const name = `up_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      connect_timeout: 3,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const reader = postgres(url.href, {
      ...options,
      connection: {
        application_name: name,
        default_transaction_read_only: true,
        statement_timeout: 8000,
      },
    });
    try {
      const started = Date.now();
      expect(await databaseReadiness(scopedHealthSql(reader, name, "ping"))).toEqual({
        db: "error",
        pending_migrations: null,
      });
      expect(Date.now() - started).toBeLessThan(3500);
      const [activity] = await admin<{ active: number }[]>`
        SELECT count(*)::int AS active FROM pg_stat_activity WHERE application_name = ${name} AND state = 'active'
      `;
      expect(activity?.active).toBe(0);
      // ROLLBACK reverted SET LOCAL: no timeout leakage into subsequent reads.
      const [settings] =
        await reader`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
      expect(settings).toMatchObject({ statement: "8s", lock: "0" });
    } finally {
      await reader.end({ timeout: 0 });
      await admin.end({ timeout: 0 });
    }
  }, 10000);

  it("starts no slow ping after a delayed successful timeout setup and leaves no active backend", async () => {
    const url = testDatabaseUrl(raw!);
    const name = `up_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      connect_timeout: 3,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const reader = postgres(url.href, {
      ...options,
      connection: {
        application_name: name,
        default_transaction_read_only: true,
        statement_timeout: 8000,
      },
    });
    try {
      await reader`SELECT 1`;
      const client = scopedHealthSql(reader, name, "ping", async () => {
        // Delay processing a REAL set_config reply, not the server's execution.
        await new Promise((resolve) => setTimeout(resolve, 2600));
      });
      const started = Date.now();
      expect(await databaseReadiness(client)).toEqual({ db: "error", pending_migrations: null });
      expect(Date.now() - started).toBeLessThan(3500);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const [activity] = await admin<{ active: number }[]>`
        SELECT count(*)::int AS active FROM pg_stat_activity WHERE application_name = ${name} AND state = 'active'
      `;
      expect(activity?.active).toBe(0); // No end(): an issued slow ping would still be active here.
      const [settings] =
        await reader`SELECT current_setting('statement_timeout') AS statement, current_setting('lock_timeout') AS lock`;
      expect(settings).toMatchObject({ statement: "8s", lock: "0" });
    } finally {
      await reader.end({ timeout: 0 });
      await admin.end({ timeout: 0 });
    }
  }, 10000);

  it("counts jobs due during setup and their age at statement time, not BEGIN", async () => {
    const url = testDatabaseUrl(raw!);
    const schema = `up_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      connect_timeout: 3,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const reader = postgres(url.href, {
      ...options,
      connection: {
        search_path: schema,
        application_name: schema,
        default_transaction_read_only: true,
        statement_timeout: 8000,
      },
    });
    let created = false;
    try {
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      created = true;
      await admin.unsafe(
        `CREATE TABLE "${schema}".queue_jobs (id integer, available_at timestamptz, reserved_at timestamptz, created_at timestamptz)`,
      );
      await admin.unsafe(`CREATE TABLE "${schema}".queue_failed_jobs (id integer)`);
      await admin`INSERT INTO ${admin(schema)}.queue_jobs
        SELECT id, clock_timestamp() - interval '1 second', NULL, clock_timestamp() - interval '1 second'
        FROM generate_series(1,20) AS id`;
      const client = scopedHealthSql(reader, schema, undefined, async () => {
        // BEGIN has already frozen now(); the aggregate has not started yet.
        // All writes target only this owned schema through a separate client.
        await admin`UPDATE ${admin(schema)}.queue_jobs SET created_at = clock_timestamp() - interval '1 second'`;
        await admin`UPDATE ${admin(schema)}.queue_jobs SET available_at = clock_timestamp() + interval '200 milliseconds' WHERE id = 20`;
        await new Promise((resolve) => setTimeout(resolve, 1100));
      });
      const depth = await withHealthReadTimeout(client, pgQueueDepth);
      expect(depth).toMatchObject({ pending: 20, delayed: 0, reserved: 0, total: 20, failed: 0 });
      expect(depth.oldestPendingAgeSeconds).toBeGreaterThanOrEqual(2);
      expect(depth.oldestReadyWaitAgeSeconds).toBeGreaterThanOrEqual(2);
      // Real queue measurement through the additive envelope, with offline DB readiness.
      expect(await upBody(async () => depth, healthSql())).toMatchObject({
        status: "degraded",
        db: "ok",
        pending_migrations: 0,
        queue: {
          status: "degraded",
          pending: 20,
          oldest_ready_wait_age_seconds: depth.oldestReadyWaitAgeSeconds,
          ready_wait_severity: "healthy",
        },
      });
    } finally {
      await reader.end({ timeout: 0 });
      try {
        if (created) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        await admin.end({ timeout: 0 });
      }
    }
  }, 10000);

  it("leaves no active backend waiting on a locked owned ledger after readiness cleanup", async () => {
    const url = testDatabaseUrl(raw!);
    const schema = `up_${randomUUID().replaceAll("-", "")}`;
    const options = {
      max: 1,
      connect_timeout: 3,
      password: () => url.password,
      onnotice: () => {},
    };
    const admin = postgres(url.href, options);
    const locker = postgres(url.href, options);
    // Safety timeout bounds a failing regression; production must cancel sooner.
    const reader = postgres(url.href, {
      ...options,
      connection: {
        search_path: schema,
        application_name: schema,
        default_transaction_read_only: true,
        statement_timeout: 8000,
      },
    });
    let release!: () => void;
    let locked!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const acquired = new Promise<void>((resolve) => {
      locked = resolve;
    });
    let lock: Promise<unknown> | undefined;
    let created = false;
    try {
      await admin.unsafe(`CREATE SCHEMA "${schema}"`);
      created = true;
      await admin.unsafe(`CREATE TABLE "${schema}".__drizzle_migrations (created_at bigint)`);
      lock = locker.begin(async (tx) => {
        await tx.unsafe(`LOCK TABLE "${schema}".__drizzle_migrations IN ACCESS EXCLUSIVE MODE`);
        locked();
        await held;
      });
      await Promise.race([acquired, lock]);
      const started = Date.now();
      expect(await databaseReadiness(scopedHealthSql(reader, schema))).toEqual({
        db: "ok",
        pending_migrations: null,
      });
      expect(Date.now() - started).toBeLessThan(3500);
      await reader.end({ timeout: 0 });
      await new Promise((resolve) => setTimeout(resolve, 500));
      // Inspect only this test's application_name while the exclusive lock is
      // STILL held: an active query cannot appear to pass by finishing its read.
      const [activity] = await admin<{ active: number; lock_waiters: number }[]>`
        SELECT count(*) FILTER (WHERE state = 'active')::int AS active,
          count(*) FILTER (WHERE state = 'active' AND wait_event_type = 'Lock')::int AS lock_waiters
        FROM pg_stat_activity WHERE application_name = ${schema}
      `;
      expect(activity).toEqual({ active: 0, lock_waiters: 0 });
    } finally {
      release();
      try {
        await lock;
      } finally {
        await reader.end({ timeout: 0 });
        await locker.end({ timeout: 0 });
        try {
          if (created) await admin.unsafe(`DROP SCHEMA "${schema}" CASCADE`);
        } finally {
          await admin.end({ timeout: 0 });
        }
      }
    }
  }, 10000);
});
