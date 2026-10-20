/// <reference types="vite/client" />
// Actual SQL, disposable schema, real session/cookie/journey machinery; only
// Discord transport is replaced. No production/staging access or role changes.
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import usersMigration from "../drizzle/0000_init-users.sql?raw";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";
import { testDatabaseUrl } from "./helpers/member-data-db";
import {
  CALLERS,
  expectIssued,
  identity,
  prepareSignin,
  settledWithin,
  signinEnv,
  stubSigninDiscord,
} from "./helpers/signin-roster";

// Observe runtime ownership without replacing SQL execution. Only route-created
// clients are redirected into this test's schema; all driver limits survive.
const runtime = vi.hoisted(() => ({
  enabled: false,
  schema: "",
  name: "",
  clients: [] as { sql: postgres.Sql; ended: boolean }[],
}));
vi.mock("postgres", async (original) => {
  const real = (await original<{ default: typeof postgres }>()).default;
  return {
    default: (url: string, options: postgres.Options<Record<string, never>> = {}) => {
      if (!runtime.enabled) return real(url, options);
      const safe = testDatabaseUrl(url);
      const sql = real(url, {
        ...options,
        password: () => safe.password,
        onnotice: () => {},
        connection: {
          ...options.connection,
          search_path: runtime.schema,
          application_name: runtime.name,
        },
      });
      const entry = { sql, ended: false };
      const end = sql.end.bind(sql);
      sql.end = async (opts) => {
        await end(opts);
        entry.ended = true;
      };
      runtime.clients.push(entry);
      return sql;
    },
  };
});

const raw = process.env.DATABASE_URL;
const url = raw ? testDatabaseUrl(raw) : undefined;
const WAIT_MS = 5_000;

// These are test-owned pools. Startup limits are deliberately disabled, so a
// server-side cancellation here cannot be credited to an ambient role default.
describe.skipIf(!url)("sign-in roster SQL lifecycle (isolated test DB)", () => {
  let schema: string;
  let name: string;
  let control: postgres.Sql;
  let holder: postgres.Sql;
  let shared: postgres.Sql;
  let session: postgres.Sql;
  let closeShared: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    schema = `roster_${randomUUID().replaceAll("-", "")}`;
    name = `${schema}_writer`;
    const options = {
      max: 1,
      connect_timeout: 3,
      prepare: false,
      fetch_types: false,
      password: () => url!.password,
      onnotice: () => {},
    };
    control = postgres(url!.href, options);
    await control.unsafe(`CREATE SCHEMA "${schema}"`);
    const connection = { search_path: schema, statement_timeout: 0, lock_timeout: 0 };
    holder = postgres(url!.href, { ...options, connection });
    shared = postgres(url!.href, {
      ...options,
      connection: { ...connection, application_name: name },
    });
    closeShared = vi.spyOn(shared, "end");
    // Mandatory sessions and one-shot journeys use real SQL too, on a distinct
    // pool so a parked optional write cannot serialize the observer behind it.
    session = postgres(url!.href, { ...options, connection });
    await migrate(session as unknown as Sql);
    for (const statement of usersMigration.split("--> statement-breakpoint"))
      if (statement.trim()) await shared.unsafe(statement);
    runtime.schema = schema;
    runtime.name = `${name}_owned`;
    runtime.clients = [];
    stubSigninDiscord();
  });
  afterEach(async () => {
    runtime.enabled = false;
    // Force only our own fixtures down on RED, never a production/shared store.
    // Closing a socket need not interrupt pg_sleep immediately; cancel our
    // identified fixture backends before dropping their schema.
    if (control)
      await control`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND application_name IN (${name}, ${runtime.name})
      AND state = 'active'`;
    for (const entry of runtime.clients) await entry.sql.end({ timeout: 0 });
    await shared?.end({ timeout: 0 });
    await session?.end({ timeout: 0 });
    await holder?.end({ timeout: 0 });
    if (control) {
      try {
        await control.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      } finally {
        await control.end({ timeout: 0 });
      }
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function seed(id: string) {
    await shared`INSERT INTO users (id, username, avatar, member) VALUES (${id}, 'Old name', 'old-avatar', false)`;
  }
  async function row(id: string) {
    const [value] = await control.unsafe(
      `SELECT id, username, avatar, member FROM "${schema}".users WHERE id = $1`,
      [id],
    );
    return value;
  }
  async function settings() {
    const [value] = await shared`SELECT current_setting('statement_timeout') AS statement,
      current_setting('lock_timeout') AS lock, pg_backend_pid() AS pid`;
    return value;
  }
  async function active(writerName = name) {
    const [value] = await control`SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${writerName}
      AND (state = 'active' OR state LIKE 'idle in transaction%')`;
    return Number(value!.n);
  }
  async function sawWait(event: "Lock" | "Timeout", writerName = name) {
    const until = performance.now() + 1500;
    do {
      const [value] = await control`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${writerName}
        AND state = 'active' AND wait_event_type = ${event}`;
      if (Number(value!.n) > 0) return true;
      await sleep(10);
    } while (performance.now() < until);
    return false;
  }
  const asSql = () => shared as unknown as Sql;

  it.each(CALLERS)(
    "%s finishes and cancels the upsert while a users-row holder is still parked",
    async (caller) => {
      const expected = identity(caller);
      await seed(expected.userId);
      await shared.unsafe("SET statement_timeout = '27s'");
      await shared.unsafe("SET lock_timeout = '23s'");
      const before = await settings();
      const store = createPostgresSessionStore(session as unknown as Sql);
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      let pending: Promise<Response> | undefined;
      try {
        await holder.begin(async (tx) => {
          await tx`SELECT id FROM users WHERE id = ${expected.userId} FOR UPDATE`;
          pending = invoke();
          expect(await sawWait("Lock"), "the real upsert must reach the held row").toBe(true);
          const response = await settledWithin(pending, WAIT_MS);
          expect(response, "sign-in still waited on the parked optional row lock").not.toBeNull();
          await expectIssued(response!, caller, store);
          // Snapshot before releasing the holder: a response-only race is not cancellation.
          expect(await active()).toBe(0);
          expect(await row(expected.userId)).toEqual({
            id: expected.userId,
            username: "Old name",
            avatar: "old-avatar",
            member: false,
          });
          expect(warn).toHaveBeenCalledWith(
            "roster upsert failed",
            expect.objectContaining({ request_id: response!.headers.get("X-Request-ID") }),
          );
          expect(closeShared).not.toHaveBeenCalled();
          expect(await settings()).toEqual(before);
        });
      } finally {
        // The holder has released even when the baseline assertion failed.
        if (pending) await pending;
      }
      // No abandoned write may land after release. A later *new* login can refresh.
      expect(await row(expected.userId)).toMatchObject({ username: "Old name", member: false });
      const retry = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      await expectIssued(await retry(), caller, store);
      expect(await row(expected.userId)).toEqual({
        id: expected.userId,
        username: expected.username,
        avatar: expected.avatar,
        member: true,
      });
      expect(await settings()).toEqual(before);
    },
  );

  it.each(CALLERS)(
    "%s cancels an executing slow statement, not only lock waits",
    async (caller) => {
      const expected = identity(caller);
      await seed(expected.userId);
      const before = await settings();
      // A real server-side stall without a row-lock wait. Removing lock_timeout
      // alone cannot make this pass; statement_timeout/cancellation must work too.
      await shared.unsafe(`CREATE FUNCTION "${schema}".slow_roster() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN PERFORM pg_sleep(20); RETURN NEW; END $$`);
      await shared.unsafe(
        `CREATE TRIGGER slow_roster BEFORE INSERT OR UPDATE ON users FOR EACH ROW EXECUTE FUNCTION "${schema}".slow_roster()`,
      );
      const store = createPostgresSessionStore(session as unknown as Sql);
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pending = invoke();
      try {
        expect(await sawWait("Timeout"), "the trigger must really enter pg_sleep").toBe(true);
        const response = await settledWithin(pending, WAIT_MS);
        expect(response, "executing optional SQL still withheld the sign-in").not.toBeNull();
        await expectIssued(response!, caller, store);
        expect(await active()).toBe(0);
        expect(await row(expected.userId)).toMatchObject({ username: "Old name", member: false });
        expect(closeShared).not.toHaveBeenCalled();
        expect(await settings()).toEqual(before);
        expect(warn).toHaveBeenCalledWith(
          "roster upsert failed",
          expect.objectContaining({ request_id: response!.headers.get("X-Request-ID") }),
        );
        await shared.unsafe("DROP TRIGGER slow_roster ON users");
        const retry = await prepareSignin(
          caller,
          signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
        );
        await expectIssued(await retry(), caller, store);
        expect(await row(expected.userId)).toMatchObject({
          username: expected.username,
          member: true,
        });
      } finally {
        // On RED only, cancel the test-owned sleeping backend rather than waiting 20s.
        if (await active())
          await control`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
          WHERE datname = current_database() AND application_name = ${name} AND state = 'active'`;
        await pending;
      }
    },
  );

  it.each(CALLERS)(
    "%s bounds connection acquisition and does not execute a stale queued write later",
    async (caller) => {
      const expected = identity(caller);
      await seed(expected.userId);
      await shared.unsafe("SET statement_timeout = '27s'");
      await shared.unsafe("SET lock_timeout = '23s'");
      const before = await settings();
      const store = createPostgresSessionStore(session as unknown as Sql);
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      const lease = await shared.reserve(); // Occupy the only connection, without a server lock.
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const pending = invoke();
      try {
        const response = await settledWithin(pending, WAIT_MS);
        expect(response, "optional connection acquisition still withheld sign-in").not.toBeNull();
        await expectIssued(response!, caller, store);
        expect(await row(expected.userId)).toMatchObject({ username: "Old name" });
        expect(closeShared).not.toHaveBeenCalled();
        expect(warn).toHaveBeenCalledWith(
          "roster upsert failed",
          expect.objectContaining({ request_id: response!.headers.get("X-Request-ID") }),
        );
      } finally {
        lease.release();
        await pending;
      }
      // Drain work queued on this single connection. The expired operation must
      // be inert even if reserve()/begin() succeeds only after its caller left.
      expect(await settings()).toEqual(before);
      expect(await row(expected.userId)).toMatchObject({ username: "Old name", member: false });
      const retry = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      await expectIssued(await retry(), caller, store);
      expect(await row(expected.userId)).toMatchObject({
        username: expected.username,
        member: true,
      });
    },
  );

  it.each(CALLERS)(
    "%s applies finite SQL settings only to the optional write and restores a reusable injected pool",
    async (caller) => {
      const expected = identity(caller);
      // This fixture constraint observes the *effective settings inside the real
      // INSERT*, not source text or SQL literals. A failed guard cannot hide as a
      // warn-and-continue success: the refreshed row is required below.
      await shared.unsafe(`ALTER TABLE users ADD CONSTRAINT roster_scoped_bounds CHECK (
      current_setting('statement_timeout')::interval > interval '0 seconds' AND
      current_setting('statement_timeout')::interval <= interval '5 seconds' AND
      current_setting('lock_timeout')::interval > interval '0 seconds' AND
      current_setting('lock_timeout')::interval <= interval '5 seconds')`);
      const before = await settings();
      const store = createPostgresSessionStore(session as unknown as Sql);
      const invoke = await prepareSignin(
        caller,
        signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() }),
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      await expectIssued(await invoke(), caller, store);
      expect(
        await row(expected.userId),
        "the healthy SQL write needs effective database-owned bounds",
      ).toEqual({
        id: expected.userId,
        username: expected.username,
        avatar: expected.avatar,
        member: true,
      });
      expect(warn).not.toHaveBeenCalled();
      expect(closeShared).not.toHaveBeenCalled();
      expect(await settings()).toEqual(before);
    },
  );

  it.each(CALLERS)(
    "%s preserves healthy refresh and immediate SQL failure on the same shared connection",
    async (caller) => {
      const expected = identity(caller);
      await seed(expected.userId);
      // Nonzero existing settings must be restored, not reset to hard-coded zero.
      await shared.unsafe("SET statement_timeout = '27s'");
      await shared.unsafe("SET lock_timeout = '23s'");
      const before = await settings();
      const store = createPostgresSessionStore(session as unknown as Sql);
      const env = signinEnv({ SESSION_STORE: store, ROSTER_STORE: asSql() });
      const invoke = await prepareSignin(caller, env);
      await expectIssued(await invoke(), caller, store);
      expect(await row(expected.userId)).toEqual({
        id: expected.userId,
        username: expected.username,
        avatar: expected.avatar,
        member: true,
      });
      expect(await settings()).toEqual(before);
      // A fixture-only constraint makes the next real statement reject immediately.
      await shared.unsafe(
        "ALTER TABLE users ADD CONSTRAINT refuse_roster CHECK (username = 'fixture-only') NOT VALID",
      );
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const reject = await prepareSignin(caller, env);
      await expectIssued(await reject(), caller, store);
      expect(warn).toHaveBeenCalledWith("roster upsert failed", expect.any(Object));
      expect(closeShared).not.toHaveBeenCalled();
      expect(await settings()).toEqual(before);
      await shared.unsafe("ALTER TABLE users DROP CONSTRAINT refuse_roster");
      const retry = await prepareSignin(caller, env);
      await expectIssued(await retry(), caller, store);
      expect(await settings()).toEqual(before);
    },
  );

  it.each(["healthy", "reject", "locked"] as const)(
    "settles the runtime-owned roster client on %s without touching session storage",
    async (mode) => {
      const caller = "qa";
      const expected = identity(caller);
      await seed(expected.userId);
      if (mode === "reject")
        await shared.unsafe(
          "ALTER TABLE users ADD CONSTRAINT refuse_roster CHECK (false) NOT VALID",
        );
      const store = createPostgresSessionStore(session as unknown as Sql);
      const env = signinEnv({ SESSION_STORE: store, DATABASE_URL: url!.href });
      const invoke = await prepareSignin(caller, env);
      vi.spyOn(console, "warn").mockImplementation(() => {});
      runtime.enabled = true;
      let pending: Promise<Response> | undefined;
      const check = async () => {
        pending = invoke();
        if (mode === "locked") expect(await sawWait("Lock", runtime.name)).toBe(true);
        const response = await settledWithin(pending, WAIT_MS);
        expect(
          response,
          "a runtime-owned optional client must not withhold issuance",
        ).not.toBeNull();
        await expectIssued(response!, caller, store);
        expect(runtime.clients).toHaveLength(1);
        expect(
          runtime.clients[0]!.ended,
          "the request must settle its owned client, not rely on idle reaping",
        ).toBe(true);
        expect(await active(runtime.name)).toBe(0);
        expect(await row(expected.userId)).toMatchObject({
          username: mode === "healthy" ? expected.username : "Old name",
        });
      };
      try {
        if (mode === "locked")
          await holder.begin(async (tx) => {
            await tx`SELECT id FROM users WHERE id = ${expected.userId} FOR UPDATE`;
            await check();
          });
        else await check();
      } finally {
        runtime.enabled = false;
        if (pending) await pending;
      }
      expect(closeShared).not.toHaveBeenCalled();
    },
  );
});
