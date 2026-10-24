// Acceptance: bounded per-request statement latency (F7).
//
// The session store, throttle store, roster client and `dbFor` must cancel a
// stuck Postgres statement server-side instead of wedging the request. A hung
// session lookup hangs every authenticated page render; a hung throttle or
// roster write withholds sign-in; a hung `dbFor` read wedges public pages.
// The bound is per statement (Postgres `statement_timeout`), never a
// whole-request deadline, and never global pool/role settings: fresh
// per-request `max:1` clients carry the bound (or tx paths use `set_config`)
// while pooled/shared session settings stay untouched.
//
// Behavioral, not a literal pin: every live contention case parks a real stall
// — an `ACCESS EXCLUSIVE` table lock for SELECT paths, a `pg_sleep` trigger
// for INSERT paths — proves the contender reached it in `pg_stat_activity`
// (observable rendezvous, never sleeps), then requires the contender to settle
// bounded while the stall is still parked. An unbounded wait loses the
// test-side detection race and fails as the wrong outcome. `pg_sleep`
// discriminates `statement_timeout` from `lock_timeout`: a lock timeout alone
// cannot cancel an executing statement, so the trigger cases fail until the
// statement bound lands. SELECT paths cannot carry INSERT triggers, so the
// `dbFor` SELECT bound is proven with a table lock instead — `statement_timeout`
// cancels lock waits too (57014), which is exactly the wedged-render outcome.
//
// Honest outcomes per store: session and `dbFor` failures render the existing
// branded 503 outage envelope with no driver detail; throttle fails open to
// allow and roster warns-and-continues sign-in (both established contracts),
// each bounded and leaking nothing. Rollback/absent-write is confirmed while
// still parked, and a later healthy call succeeds after release.
//
// Live against the guarded test database in a throwaway schema. Skipped when
// DATABASE_URL is unset. Never point this at production or staging.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Hono } from "hono";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import testApp from "./app";
import { dbFor } from "../src/admin/db";
import { databaseOptions } from "../src/db/connection";
import { isDatabaseUnavailable } from "../src/db/errors";
import type { Db } from "../src/db/index";
import { migrateRoster, upsertRosterUser } from "../src/db/roster";
import type { Env } from "../src/env";
import { listPast } from "../src/events/reads";
import { storeForEnv } from "../src/index";
import { checkJoinThrottle, migrateJoin } from "../src/join/service";
import {
  createMemorySessionStore,
  createPostgresSessionStore,
  hashToken,
  migrate as migrateSessions,
  newSessionToken,
  type SessionStore,
  type Sql,
} from "../src/sessions";
import { throttleGuard, throttleStore } from "../src/throttle";
import { cookieFor, env as baseEnv, MEMBER } from "./helpers/member-data";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";

// Observe production construction without replacing SQL execution. Only
// route/store-created clients are redirected into this test's schema while
// enabled; all driver limits survive. Fixture and holder pools are created
// with this disabled and keep their explicit configuration.
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

// Test-side unbounded-wait detector, not a production deadline. Any finite
// server-enforced bound the builder chooses (existing conventions are
// 400ms..5s) settles well inside this. An unbounded wait loses this race and
// fails as the wrong outcome.
const SETTLE_DEADLINE_MS = 15_000;
// Longer than the detector: without a bound the contender is still asleep
// when the race fires. Cancelled in cleanup so RED runs never wait this out.
const SLEEP_SECONDS = 20;
const BRANDED_OUTAGE_MARK = "We will be right back";
// Driver-shaped strings that must never reach a response body.
const LEAK_PATTERNS = [
  /private query details/,
  /Failed query/,
  /PostgresError/,
  /55P03/,
  /57014/,
  /statement timeout/i,
  /pg_sleep/,
  /LOCK TABLE/i,
  /web_sessions/,
  /web_throttle_hits/,
];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function pgError(code: string) {
  return Object.assign(new Error("private query details"), {
    name: "PostgresError",
    code,
  });
}

function wrapped(code: string, depth = 1) {
  let current: Error = pgError(code);
  for (let i = 0; i < depth; i++) {
    current = new Error("Failed query", { cause: current });
  }
  return current;
}

function codesInChain(error: unknown): string[] {
  const codes: string[] = [];
  let current: unknown = error;
  for (let i = 0; i < 8 && current instanceof Error; i++) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") codes.push(code);
    current = current.cause;
  }
  return codes;
}

type Settled<T> =
  | { settled: true; value: T }
  | { settled: true; error: unknown }
  | { settled: false };

async function raceBounded<T>(pending: Promise<T>): Promise<Settled<T>> {
  const verdict = pending.then(
    (value): Settled<T> => ({ settled: true, value }),
    (error): Settled<T> => ({ settled: true, error }),
  );
  const deadline = delay(SETTLE_DEADLINE_MS).then((): Settled<T> => ({ settled: false }));
  return Promise.race([verdict, deadline]);
}

const fakeSessionStore = (error: unknown) =>
  ({
    get: async () => {
      throw error;
    },
  }) as unknown as SessionStore;

const fakeRefusingDb = (error: unknown) =>
  ({
    transaction: async () => {
      throw error;
    },
    select: () => {
      throw error;
    },
    selectDistinctOn: () => {
      throw error;
    },
    execute: async () => {
      throw error;
    },
  }) as unknown as Db;

async function expectBrandedOutage(res: Response): Promise<string> {
  expect(res.status).toBe(503);
  const cache = res.headers.get("cache-control") ?? "";
  expect(cache).toContain("no-store");
  expect(cache).toContain("private");
  expect(res.headers.get("vary") ?? "").toMatch(/accept/i);
  const body = await res.text();
  expect(body).toContain(BRANDED_OUTAGE_MARK);
  for (const pattern of LEAK_PATTERNS) expect(body).not.toMatch(pattern);
  return body;
}

describe("per-request statement bound leaves pooled settings untouched (offline)", () => {
  it("keeps bounds off the shared client options, never global settings", () => {
    // Fresh per-request clients carry the bound via the builder's helper
    // (SET on the owned client or set_config in tx paths). Global
    // databaseOptions must not carry statement_timeout or lock_timeout:
    // those would bound every pooled read, not just per-request work.
    expect(databaseOptions).not.toHaveProperty("statement_timeout");
    expect(databaseOptions).not.toHaveProperty("lock_timeout");
  });

  it("documents the timeout value next to databaseOptions", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../src/db/connection.ts", import.meta.url).href),
      "utf8",
    );
    expect(source).toMatch(/statement_timeout/i);
    expect(source).toMatch(/\d+\s*(ms|milliseconds?|seconds?)/i);
  });
});

describe("per-request cancellation classification (offline)", () => {
  it.each(["55P03", "57014"])("recognizes Postgres cancellation code %s", (code) => {
    expect(isDatabaseUnavailable(pgError(code))).toBe(true);
  });

  it.each(["55P03", "57014"])("recognizes %s through a wrapped cause chain", (code) => {
    expect(isDatabaseUnavailable(wrapped(code, 1))).toBe(true);
    expect(isDatabaseUnavailable(wrapped(code, 2))).toBe(true);
  });

  it.each([pgError("23505"), pgError("42601"), pgError("42501"), new TypeError("bug")])(
    "does not disguise ordinary errors as outage: %s",
    (error) => {
      expect(isDatabaseUnavailable(error)).toBe(false);
    },
  );
});

describe("per-request honest outage shape (offline, fake stores)", () => {
  it("maps a wrapped session cancellation to the branded 503 on /events", async () => {
    // Memory-backed cookie mint only; the route injects its own throwing
    // SESSION_STORE below, so this store never serves a request.
    const cookie = await cookieFor(createMemorySessionStore(), MEMBER);
    const res = await testApp.request("/events", { headers: { cookie } }, {
      ...baseEnv,
      ADMIN_DB: {} as unknown as Db,
      SESSION_STORE: fakeSessionStore(wrapped("57014", 1)),
    } as unknown as Env);
    await expectBrandedOutage(res);
  });

  it("maps a wrapped dbFor cancellation to the branded 503 on /events/past", async () => {
    const res = await testApp.request("/events/past", { headers: { cookie: "probe=1" } }, {
      ...baseEnv,
      ADMIN_DB: fakeRefusingDb(wrapped("57014", 1)),
    } as unknown as Env);
    await expectBrandedOutage(res);
  });

  it("throttle fail-open allows when the store throws, never a 503", async () => {
    const probe = new Hono<{ Bindings: Env }>();
    probe.get("/probe", async (c) => (await throttleGuard(c, "probe", 10)) ?? c.text("allow"));
    const res = await probe.request("/probe", {}, {
      THROTTLE_STORE: async () => {
        throw wrapped("57014", 1);
      },
    } as unknown as Env);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("allow");
  });

  it("roster no-ops without a store instead of touching the database", async () => {
    await expect(
      upsertRosterUser(null, {
        id: "100000000000000101",
        username: "x",
        avatar: null,
        member: true,
      }),
    ).resolves.toBeUndefined();
  });
});

const raw = process.env.DATABASE_URL;
describe.skipIf(!raw)("per-request statement latency (test database)", () => {
  let fixture: MemberDataFixture;
  let seedPool: postgres.Sql;

  beforeAll(async () => {
    runtime.enabled = false;
    // Holders park locks while contenders, observers and assertion queries
    // each need a connection on the fixture pool.
    fixture = await createMemberDataFixture(raw!, { max: 8 });
    // Belt-and-braces alongside the fixture migrations; all idempotent.
    const sql = fixture.client as unknown as Sql;
    await migrateSessions(sql);
    await migrateJoin(sql);
    await migrateRoster(sql);
    // Session seeding on a distinct production-shaped pool (prepare:false):
    // the fixture pool prepares statements, which cannot bind the session
    // store's Date parameters.
    const url = testDatabaseUrl(raw!);
    seedPool = postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      prepare: false,
      fetch_types: false,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  });

  afterAll(async () => {
    await seedPool?.end({ timeout: 1 }).catch(() => {});
    await fixture?.dispose();
  });

  beforeEach(async () => {
    runtime.enabled = false;
    runtime.clients = [];
    await fixture.reset();
    await fixture.client`DELETE FROM web_session_grace`;
    await fixture.client`DELETE FROM web_sessions`;
    await fixture.client`DELETE FROM web_throttle_hits`;
  });

  afterEach(async () => {
    runtime.enabled = false;
    for (const entry of runtime.clients) await entry.sql.end({ timeout: 0 }).catch(() => {});
    runtime.clients = [];
  });

  const holderClient = () => {
    const url = testDatabaseUrl(raw!);
    return postgres(url.href, {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      prepare: false,
      fetch_types: false,
      password: () => url.password,
      connection: { search_path: fixture.schemaName },
      onnotice: () => {},
    });
  };

  async function waitForBlocked(holderPid: number) {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await fixture.client`select pid from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock'
          and ${holderPid} = any(pg_blocking_pids(pid))`;
      if (rows.length >= 1) return;
      if (Date.now() >= deadline) throw new Error("contender did not reach the held lock");
      await delay(25);
    }
  }

  async function sawSleeping(): Promise<boolean> {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const rows = await fixture.client`select pid from pg_stat_activity
        where datname = current_database() and application_name = ${runtime.name}
          and state = 'active' and wait_event_type = 'Timeout'`;
      if (rows.length >= 1) return true;
      if (Date.now() >= deadline) return false;
      await delay(25);
    }
  }

  const cancelMockBackends = () =>
    fixture.client`SELECT pg_cancel_backend(pid) FROM pg_stat_activity
      WHERE datname = current_database() AND application_name = ${runtime.name}
        AND state = 'active'`.catch(() => {});

  const settings = async () =>
    fixture.client<{ statement: string; lock: string }[]>`
      select current_setting('statement_timeout') as statement,
             current_setting('lock_timeout') as lock`;

  async function addSleepTrigger(table: string, fn: string, trg: string, events = "INSERT") {
    await fixture.client.unsafe(
      `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(${SLEEP_SECONDS}); RETURN NEW; END $$`,
    );
    await fixture.client.unsafe(
      `CREATE TRIGGER ${trg} BEFORE ${events} ON ${table} FOR EACH ROW EXECUTE FUNCTION ${fn}()`,
    );
  }

  async function dropSleepTrigger(table: string, fn: string, trg: string) {
    await fixture.client.unsafe(`DROP TRIGGER IF EXISTS ${trg} ON ${table}`).catch(() => {});
    await fixture.client.unsafe(`DROP FUNCTION IF EXISTS ${fn}()`).catch(() => {});
  }

  const discordStub = { upcoming: async () => [], lastReadFailed: () => false };

  const seedSession = async () => {
    const store = createPostgresSessionStore(seedPool as unknown as Sql);
    const token = newSessionToken();
    const tokenHash = await hashToken(token);
    await store.create({
      tokenHash,
      userId: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: MEMBER.member,
      moderator: MEMBER.moderator,
      expiresAt: new Date(Date.now() + 3_600_000),
    });
    return { store, tokenHash };
  };

  it("control: healthy session get/rotate succeed on a production-built store", async () => {
    const { tokenHash } = await seedSession();
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_session`;
    runtime.clients = [];
    try {
      const store = await storeForEnv({ DATABASE_URL: raw } as unknown as Env);
      const row = await store.get(tokenHash);
      expect(row?.userId).toBe(MEMBER.userId);
      const replacement = newSessionToken();
      const rotated = await store.rotate(tokenHash, {
        tokenHash: await hashToken(replacement),
        userId: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        member: MEMBER.member,
        moderator: MEMBER.moderator,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(rotated).toBe(true);
    } finally {
      runtime.enabled = false;
    }
  });

  it("session get behind a held table lock settles bounded, then succeeds", async () => {
    const { tokenHash } = await seedSession();
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE web_sessions IN ACCESS EXCLUSIVE MODE");
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_session`;
      runtime.clients = [];
      const store = await storeForEnv({ DATABASE_URL: raw } as unknown as Env);
      pending = store.get(tokenHash);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "session get must settle bounded while the holder still parks its table lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded session get wait");
      expect("error" in outcome, "a cancelled get must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
    } finally {
      runtime.enabled = false;
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    // Later healthy read succeeds after contention releases.
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_session`;
    runtime.clients = [];
    try {
      const store = await storeForEnv({ DATABASE_URL: raw } as unknown as Env);
      expect((await store.get(tokenHash))?.userId).toBe(MEMBER.userId);
    } finally {
      runtime.enabled = false;
    }
  });

  it("session create with a pg_sleep trigger cancels bounded with no row", async () => {
    await addSleepTrigger("web_sessions", "bounded_session_sleep", "bounded_session_sleep_trg");
    let pending: Promise<unknown> | undefined;
    const tokenHash = await hashToken(newSessionToken());
    try {
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_session`;
      runtime.clients = [];
      const store = await storeForEnv({ DATABASE_URL: raw } as unknown as Env);
      pending = store.create({
        tokenHash,
        userId: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        member: MEMBER.member,
        moderator: MEMBER.moderator,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect(await sawSleeping(), "the trigger must really enter pg_sleep").toBe(true);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "executing session SQL must cancel bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded session create wait");
      expect("error" in outcome).toBe(true);
      const error = (outcome as { error: unknown }).error;
      // Executing statements cancel with 57014; a lock timeout alone cannot.
      expect(codesInChain(error)).toContain("57014");
      expect(isDatabaseUnavailable(error)).toBe(true);
      const rows =
        await fixture.client`select token_hash from web_sessions where token_hash = ${tokenHash}`;
      expect(rows).toHaveLength(0);
    } finally {
      runtime.enabled = false;
      await cancelMockBackends();
      await pending?.then(
        () => {},
        () => {},
      );
      await dropSleepTrigger("web_sessions", "bounded_session_sleep", "bounded_session_sleep_trg");
    }
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_session`;
    runtime.clients = [];
    try {
      const store = await storeForEnv({ DATABASE_URL: raw } as unknown as Env);
      await store.create({
        tokenHash,
        userId: MEMBER.userId,
        username: MEMBER.username,
        avatar: null,
        member: MEMBER.member,
        moderator: MEMBER.moderator,
        expiresAt: new Date(Date.now() + 3_600_000),
      });
      expect((await store.get(tokenHash))?.userId).toBe(MEMBER.userId);
    } finally {
      runtime.enabled = false;
    }
  });

  it("authenticated /events behind a held session lock answers 503 honest, then 200", async () => {
    const seeded = createPostgresSessionStore(seedPool as unknown as Sql);
    const cookie = await cookieFor(seeded, MEMBER);
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE web_sessions IN ACCESS EXCLUSIVE MODE");
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_session`;
      runtime.clients = [];
      pending = Promise.resolve(
        testApp.request("/events", { headers: { cookie } }, {
          ...baseEnv,
          DATABASE_URL: raw,
          DISCORD_EVENTS: discordStub,
        } as unknown as Env),
      );
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "held session render must answer bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded session render wait");
      await expectBrandedOutage((outcome as { value: Response }).value);
    } finally {
      runtime.enabled = false;
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_session`;
    runtime.clients = [];
    try {
      const retry = await testApp.request("/events", { headers: { cookie } }, {
        ...baseEnv,
        DATABASE_URL: raw,
        DISCORD_EVENTS: discordStub,
      } as unknown as Env);
      expect(retry.status).toBe(200);
    } finally {
      runtime.enabled = false;
    }
  });

  it("control: healthy throttle admission succeeds on a production-built store", async () => {
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_throttle`;
    runtime.clients = [];
    try {
      const sql = await throttleStore({ env: { DATABASE_URL: raw } } as unknown as Parameters<
        typeof throttleStore
      >[0]);
      const verdict = await checkJoinThrottle(sql, "probe:anon", 10);
      expect(verdict).toEqual({ limited: false });
    } finally {
      runtime.enabled = false;
    }
  });

  it("throttle admission with a pg_sleep trigger rejects bounded with no hit", async () => {
    await addSleepTrigger(
      "web_throttle_hits",
      "bounded_throttle_sleep",
      "bounded_throttle_sleep_trg",
    );
    let pending: Promise<unknown> | undefined;
    try {
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_throttle`;
      runtime.clients = [];
      const sql = await throttleStore({ env: { DATABASE_URL: raw } } as unknown as Parameters<
        typeof throttleStore
      >[0]);
      pending = checkJoinThrottle(sql, "probe:anon", 10);
      expect(await sawSleeping(), "the trigger must really enter pg_sleep").toBe(true);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "executing throttle SQL must settle bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded throttle admission wait");
      expect("error" in outcome).toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toContain("57014");
      const hits =
        await fixture.client`select id from web_throttle_hits where bucket = 'probe:anon'`;
      expect(hits).toHaveLength(0);
    } finally {
      runtime.enabled = false;
      await cancelMockBackends();
      await pending?.then(
        () => {},
        () => {},
      );
      await dropSleepTrigger(
        "web_throttle_hits",
        "bounded_throttle_sleep",
        "bounded_throttle_sleep_trg",
      );
    }
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_throttle`;
    runtime.clients = [];
    try {
      const sql = await throttleStore({ env: { DATABASE_URL: raw } } as unknown as Parameters<
        typeof throttleStore
      >[0]);
      expect(await checkJoinThrottle(sql, "probe:anon", 10)).toEqual({ limited: false });
    } finally {
      runtime.enabled = false;
    }
  });

  it("throttleGuard allows bounded under a slow store, never hanging", async () => {
    await addSleepTrigger(
      "web_throttle_hits",
      "bounded_throttle_guard_sleep",
      "bounded_throttle_guard_sleep_trg",
    );
    const probe = new Hono<{ Bindings: Env }>();
    probe.get("/probe", async (c) => (await throttleGuard(c, "probe", 10)) ?? c.text("allow"));
    let pending: Promise<Response> | undefined;
    try {
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_throttle`;
      runtime.clients = [];
      pending = Promise.resolve(
        probe.request("/probe", {}, { DATABASE_URL: raw } as unknown as Env),
      );
      expect(await sawSleeping(), "the trigger must really enter pg_sleep").toBe(true);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "slow throttle guard must allow bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded throttle guard wait");
      const res = (outcome as { value: Response }).value;
      expect(res.status).toBe(200);
      expect(await res.text()).toBe("allow");
    } finally {
      runtime.enabled = false;
      await cancelMockBackends();
      await pending?.then(
        () => {},
        () => {},
      );
      await dropSleepTrigger(
        "web_throttle_hits",
        "bounded_throttle_guard_sleep",
        "bounded_throttle_guard_sleep_trg",
      );
    }
  });

  it("control: healthy roster upsert lands and restores settings", async () => {
    const before = await settings();
    await upsertRosterUser(fixture.client as unknown as Sql, {
      id: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
    });
    const [row] =
      await fixture.client`select username, member from users where id = ${MEMBER.userId}`;
    expect(row).toMatchObject({ username: MEMBER.username, member: true });
    expect(await settings()).toEqual(before);
  });

  it("roster upsert with a pg_sleep trigger cancels bounded with settings intact", async () => {
    await fixture.client`INSERT INTO users (id, username, avatar, member) VALUES (${MEMBER.userId}, 'Old name', 'old-avatar', false)`;
    await addSleepTrigger(
      "users",
      "bounded_roster_sleep",
      "bounded_roster_sleep_trg",
      "INSERT OR UPDATE",
    );
    const before = await settings();
    const pending = upsertRosterUser(fixture.client as unknown as Sql, {
      id: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
    });
    try {
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "executing roster SQL must cancel bounded").toBe(true);
      if (!outcome.settled) throw new Error("unbounded roster upsert wait");
      expect("error" in outcome).toBe(true);
      const [row] =
        await fixture.client`select username, member from users where id = ${MEMBER.userId}`;
      expect(row).toMatchObject({ username: "Old name", member: false });
      expect(await settings()).toEqual(before);
    } finally {
      await pending.then(
        () => {},
        () => {},
      );
      await dropSleepTrigger("users", "bounded_roster_sleep", "bounded_roster_sleep_trg");
    }
    await upsertRosterUser(fixture.client as unknown as Sql, {
      id: MEMBER.userId,
      username: MEMBER.username,
      avatar: null,
      member: true,
    });
    const [row] =
      await fixture.client`select username, member from users where id = ${MEMBER.userId}`;
    expect(row).toMatchObject({ username: MEMBER.username, member: true });
    expect(await settings()).toEqual(before);
  });

  it("control: healthy dbFor listPast succeeds on a production-built client", async () => {
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_dbfor`;
    runtime.clients = [];
    try {
      const db = await dbFor({ env: { DATABASE_URL: raw } as unknown as Env });
      expect(db).not.toBeNull();
      const page = await listPast(db!, 1);
      expect(page.rows).toEqual([]);
    } finally {
      runtime.enabled = false;
    }
  });

  it("dbFor listPast behind a held table lock settles bounded, then succeeds", async () => {
    const holder = holderClient();
    let pending: Promise<unknown> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_dbfor`;
      runtime.clients = [];
      const db = await dbFor({ env: { DATABASE_URL: raw } as unknown as Env });
      pending = listPast(db!, 1);
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(
        outcome.settled,
        "dbFor read must settle bounded while the holder still parks its table lock",
      ).toBe(true);
      if (!outcome.settled) throw new Error("unbounded dbFor read wait");
      expect("error" in outcome, "a cancelled read must reject, never resolve").toBe(true);
      const error = (outcome as { error: unknown }).error;
      expect(codesInChain(error)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^(55P03|57014)$/)]),
      );
      expect(isDatabaseUnavailable(error)).toBe(true);
    } finally {
      runtime.enabled = false;
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_dbfor`;
    runtime.clients = [];
    try {
      const db = await dbFor({ env: { DATABASE_URL: raw } as unknown as Env });
      const page = await listPast(db!, 1);
      expect(page.rows).toEqual([]);
    } finally {
      runtime.enabled = false;
    }
  });

  it("/events/past behind a held table lock answers 503 honest, then 200", async () => {
    const holder = holderClient();
    let pending: Promise<Response> | undefined;
    try {
      await holder.unsafe("BEGIN");
      const [holderPid] = await holder<{ pid: number }[]>`select pg_backend_pid() as pid`;
      await holder.unsafe("LOCK TABLE events IN ACCESS EXCLUSIVE MODE");
      runtime.enabled = true;
      runtime.schema = fixture.schemaName;
      runtime.name = `${fixture.schemaName}_dbfor`;
      runtime.clients = [];
      pending = Promise.resolve(
        testApp.request("/events/past", { headers: { cookie: "probe=1" } }, {
          ...baseEnv,
          DATABASE_URL: raw,
        } as unknown as Env),
      );
      await waitForBlocked(holderPid!.pid);
      const outcome = await raceBounded(pending);
      expect(outcome.settled, "held archive render must answer bounded").toBe(true);
      if (!outcome.settled || "error" in outcome) throw new Error("unbounded archive render wait");
      await expectBrandedOutage((outcome as { value: Response }).value);
    } finally {
      runtime.enabled = false;
      await holder.unsafe("ROLLBACK").catch(() => {});
      await holder.end({ timeout: 1 }).catch(() => {});
      await pending?.then(
        () => {},
        () => {},
      );
    }
    runtime.enabled = true;
    runtime.schema = fixture.schemaName;
    runtime.name = `${fixture.schemaName}_dbfor`;
    runtime.clients = [];
    try {
      const retry = await testApp.request("/events/past", { headers: { cookie: "probe=1" } }, {
        ...baseEnv,
        DATABASE_URL: raw,
      } as unknown as Env);
      expect(retry.status).toBe(200);
    } finally {
      runtime.enabled = false;
    }
  });

  it("injected shared clients keep their settings after dbFor reads", async () => {
    const before = await settings();
    const db = await dbFor({ env: { ADMIN_DB: fixture.db } as unknown as Env });
    expect(db).not.toBeNull();
    await listPast(db!, 1);
    expect(await settings()).toEqual(before);
  });
});
