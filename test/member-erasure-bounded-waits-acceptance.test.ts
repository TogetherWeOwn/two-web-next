import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrate, type Sql } from "../src/sessions";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
import { createEraseClient } from "../bin/erase-member.mjs";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Acceptance contract: the operator erase-member CLI must bound its own SQL
// waits with finite server-enforced statement and lock budgets, like
// revoke-sessions does, on both dry-run and apply. The erasure transaction
// deletes users, profiles, rsvps, web_sessions and join_attempts in one
// transaction: a held lock on any of them must fail the whole run bounded
// instead of waiting without limit while already-deleted member rows stay
// locked. A timeout is exit 1 with the redacted message and every partial
// change rolled back. These tests drive the real CLI process against a
// per-invocation disposable database because the CLI pins search_path=public,
// so schema-scoped fixtures cannot reach it.

const repoRoot = fileURLToPath(new URL("..", import.meta.url).href);
const script = fileURLToPath(new URL("../bin/erase-member.mjs", import.meta.url).href);
const MEMBER_A = "100000000000000201";
const MEMBER_B = "100000000000000202";
const EVENT_KEY = "01J000000000000000000000E1";
const ambientUrl = process.env.DATABASE_URL;
// The CLI must finish (or fail) well inside this wall-clock deadline even
// when every statement it issues is stuck behind a lock. The runner kills
// the process at the deadline so an unbounded wait fails as timedOut.
const CLI_DEADLINE_MS = 20_000;

type CliResult = {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  elapsedMs: number;
};

function startCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "./bin/ts-hook.mjs", script, ...args], {
      cwd: repoRoot,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const killer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, CLI_DEADLINE_MS);
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("close", (status) => {
      clearTimeout(killer);
      resolve({ status, stdout, stderr, timedOut, elapsedMs: Date.now() - started });
    });
  });
}

function timeoutMs(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|min|m)?$/i.exec(value.trim());
  if (!match) return undefined;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "ms").toLowerCase();
  // Postgres treats a unitless timeout value as milliseconds.
  return amount * (unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000);
}

function findTimeoutMs(value: unknown, key: string): number | undefined {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findTimeoutMs(entry, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value && typeof value === "object") {
    for (const [name, entry] of Object.entries(value)) {
      if (name === key) return timeoutMs(entry);
      const found = findTimeoutMs(entry, key);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

describe("erase-member bounded waits: client budget and docs", () => {
  it("configures finite server-side statement_timeout and lock_timeout on the CLI client", () => {
    let options: unknown;
    const capture = (firstArg: unknown, secondArg?: unknown) => {
      options = secondArg ?? firstArg;
      return {};
    };
    createEraseClient(capture, "postgres://agent_test@agent-testdb:5432/two_web_next");
    // Server-enforced budgets travel as session settings on this CLI's own
    // single connection, so they cover the dry-run counts (no transaction)
    // and every apply statement alike, and cannot become a client-side race
    // that abandons a still-running statement.
    const statement = findTimeoutMs(options, "statement_timeout");
    const lock = findTimeoutMs(options, "lock_timeout");
    expect(statement, "statement_timeout must be set and finite").toBeDefined();
    expect(lock, "lock_timeout must be set and finite").toBeDefined();
    // Wide enough for a remote round trip, small enough that an erasure
    // against a locked row fails in seconds, not minutes.
    for (const budget of [statement!, lock!]) {
      expect(budget).toBeGreaterThanOrEqual(1_000);
      expect(budget).toBeLessThanOrEqual(15_000);
    }
  });

  it("never uses SKIP LOCKED in the erasure path", () => {
    // Skip-locked semantics would leave locked member rows behind while
    // reporting success: a locked target must wait or fail the whole
    // operation, never be silently left unerased.
    for (const path of ["../src/member-erasure.ts", "../bin/erase-member.mjs"]) {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url).href), "utf8");
      expect(source).not.toMatch(/skip\s+locked/i);
    }
  });

  it("documents the bounded failure and the retry/escalation path", () => {
    const doc = readFileSync(
      fileURLToPath(new URL("../docs/member-erasure.md", import.meta.url).href),
      "utf8",
    );
    const start = doc.indexOf("Bounded waits");
    expect(start, "docs/member-erasure.md must have a Bounded waits paragraph").toBeGreaterThan(-1);
    const section = doc.slice(start, doc.indexOf("\n## ", start + 1));
    expect(section).toMatch(/statement_timeout/);
    expect(section).toMatch(/lock_timeout/);
    // A timed-out run erased nothing: the operator must be told all six
    // tables stay unchanged and to verify with a dry-run.
    expect(section).toMatch(/unchanged|erases? nothing|rolls? back/i);
    expect(section).toMatch(/dry-run/);
    expect(section).toMatch(/re-?run|retry/i);
    expect(section).toMatch(/escalat/i);
  });
});

// Per-invocation disposable database, following the established digits-only
// guard pattern: validated ambient target first, create only a proven-absent
// owned name, drop only the exact database this run created.
const DB_NAME = `two_web_next_tog${Date.now()}${Math.floor(Math.abs(process.pid)) % 1_000_000}${String(randomInt(0, 1_000_000)).padStart(6, "0")}`;

function derivedUrl(raw: string, name: string): string {
  const url = new URL(raw);
  url.pathname = `/${name}`;
  return url.href;
}

describe.skipIf(!ambientUrl)("erase-member bounded waits: CLI against disposable Postgres", () => {
  let admin: postgres.Sql;
  let client: postgres.Sql;
  let created = false;
  let eventId = 0;
  const cliEnv = () => ({ DATABASE_URL: derivedUrl(ambientUrl!, DB_NAME) });
  const password = () => new URL(ambientUrl!).password;

  const countsFor = async (id: string) => {
    const [[u], [p], [r], [l], [s], [g], [j]] = await Promise.all([
      client`select count(*)::int as n from users where id = ${id}`,
      client`select count(*)::int as n from profiles where user_id = ${id}`,
      client`select count(*)::int as n from rsvps where user_id = ${id}`,
      client`select count(*)::int as n from member_links where user_id = ${id}`,
      client`select count(*)::int as n from web_sessions where user_id = ${id}`,
      client`select count(*)::int as n from web_session_grace where user_id = ${id}`,
      client`select count(*)::int as n from join_attempts where discord_id = ${id}`,
    ]);
    return {
      users: (u as { n: number }).n,
      profiles: (p as { n: number }).n,
      rsvps: (r as { n: number }).n,
      member_links: (l as { n: number }).n,
      web_sessions: (s as { n: number }).n,
      web_session_grace: (g as { n: number }).n,
      join_attempts: (j as { n: number }).n,
    };
  };

  const seedMember = async (id: string, username: string) => {
    // Bind expiry as ISO text: the driver's Date serializer is version-sensitive,
    // and text casts to timestamptz without touching it.
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    await client`insert into users (id, username, member) values (${id}, ${username}, true)`;
    await client`insert into profiles (user_id, bio, games, timezone)
        values (${id}, ${`bio for ${id}`}, '["Synthetic Game"]', 'Europe/London')`;
    await client`insert into rsvps (event_id, user_id, status)
        values (${eventId}, ${id}, 'going')`;
    await client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values (${`hash-${id}-1`}, ${id}, ${username}, true, false, ${expiresAt}),
               (${`hash-${id}-2`}, ${id}, ${username}, true, false, ${expiresAt})`;
    await client`insert into join_attempts (outcome, source, request_id, discord_id)
        values ('added', 'site', ${`request-${id}`}, ${id})`;
  };

  beforeAll(async () => {
    expect(DB_NAME).toMatch(/^two_web_next_tog[0-9]+$/);
    testDatabaseUrl(ambientUrl!); // Refuse before any connection or DDL.
    admin = postgres(ambientUrl!, { max: 1, connect_timeout: 5, password, onnotice: () => {} });
    const [existing] = await admin<{ n: number }[]>`
        select count(*)::int as n from pg_database where datname = ${DB_NAME}`;
    if (existing?.n) throw new Error(`refusing to reuse existing database "${DB_NAME}"`);
    await admin.unsafe(`CREATE DATABASE "${DB_NAME}"`);
    created = true;
    client = postgres(derivedUrl(ambientUrl!, DB_NAME), {
      max: 6,
      connect_timeout: 5,
      password,
      onnotice: () => {},
    });
    // Canonical schema in public: the CLI pins search_path=public, so the
    // disposable database needs the real migrations, not a fixture schema.
    const migrations = readMigrationFiles({
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url).href),
    });
    await client.begin(async (tx) => {
      for (const migration of migrations)
        for (const statement of migration.sql) {
          if (statement.trim()) await tx.unsafe(statement);
        }
    });
    await migrate(client as unknown as Sql);
  });

  beforeEach(async () => {
    await client`delete from web_sessions`;
    await client`delete from rsvps`;
    await client`delete from profiles`;
    await client`delete from join_attempts`;
    await client`delete from events`;
    await client`delete from users`;
    const [event] = (await client`insert into events
        (event_key, title, starts_at, ends_at) values
        (${EVENT_KEY}, 'Synthetic erasure event', '2099-11-04T20:00:00Z', '2099-11-04T22:00:00Z')
        returning id`) as { id: number }[];
    eventId = event!.id;
    await seedMember(MEMBER_A, "synthetic-erase-a");
    await seedMember(MEMBER_B, "synthetic-erase-b");
  });

  afterAll(async () => {
    await client?.end({ timeout: 1 }).catch(() => {});
    try {
      if (created) await admin?.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
    } finally {
      await admin?.end({ timeout: 1 }).catch(() => {});
    }
  });

  const freshSessionSettings = async () => {
    const probe = postgres(derivedUrl(ambientUrl!, DB_NAME), {
      max: 1,
      connect_timeout: 5,
      password,
      onnotice: () => {},
    });
    try {
      const [row] = await probe<{ statement: string; lock: string }[]>`
          select current_setting('statement_timeout') as statement,
                 current_setting('lock_timeout') as lock`;
      return row;
    } finally {
      await probe.end({ timeout: 1 });
    }
  };

  const waitForLockWaiters = async (client: postgres.Sql, db: string, count: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const waiting = await client`select pid from pg_stat_activity
          where datname = ${db} and wait_event_type = 'Lock'`;
      if (waiting.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`expected ${count} backend(s) waiting on the held lock`);
  };

  const expectRedacted = (result: CliResult) => {
    const output = result.stdout + result.stderr;
    for (const secret of [
      "postgres://",
      MEMBER_A,
      MEMBER_B,
      "synthetic-erase-a",
      "synthetic-erase-b",
      `hash-${MEMBER_A}-1`,
    ])
      expect(output).not.toContain(secret);
  };

  const expectFailure = (result: CliResult) => {
    // Bounded server-side failure: the CLI ends itself, nonzero, instead
    // of waiting on the lock forever.
    expect(result.timedOut).toBe(false);
    expect(result.elapsedMs).toBeLessThan(CLI_DEADLINE_MS);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("operation failed; changes rolled back");
    // The lock-timeout rollback maps to its distinct retry message, not the
    // generic failure text: both share the prefix above, so pin the 55P03
    // marker and the retry instruction explicitly.
    expect(result.stderr).toContain("55P03");
    expect(result.stderr).toContain("Retry once the lock clears");
    expect(result.stdout).not.toContain('"mode"');
    expectRedacted(result);
  };

  it("runs normal dry-run/apply, stays idempotent and other-member safe, and leaves global timeout policy untouched", async () => {
    const before = await freshSessionSettings();
    const dry = await startCli([`--discord-id=${MEMBER_A}`], cliEnv());
    expect(dry.timedOut).toBe(false);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout)).toEqual({
      mode: "dry-run",
      counts: {
        users: 1,
        profiles: 1,
        rsvps: 1,
        member_links: 0,
        web_sessions: 2,
        web_session_grace: 0,
        join_attempts: 1,
      },
      passes: 0,
      deletesPerPass: [],
    });
    const seeded = {
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
    };
    expect(await countsFor(MEMBER_A)).toEqual(seeded);

    const applied = await startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
    expect(applied.status).toBe(0);
    expect(JSON.parse(applied.stdout)).toEqual({
      mode: "apply",
      counts: seeded,
      passes: 1,
      deletesPerPass: [2],
    });
    const empty = {
      users: 0,
      profiles: 0,
      rsvps: 0,
      member_links: 0,
      web_sessions: 0,
      web_session_grace: 0,
      join_attempts: 0,
    };
    expect(await countsFor(MEMBER_A)).toEqual(empty);
    expect(await countsFor(MEMBER_B)).toEqual(seeded);

    const again = await startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
    expect(again.status).toBe(0);
    expect(JSON.parse(again.stdout)).toEqual({
      mode: "apply",
      counts: empty,
      passes: 1,
      deletesPerPass: [0],
    });
    expect(await countsFor(MEMBER_B)).toEqual(seeded);

    // Budgets are this CLI session's own settings, never database- or
    // role-level policy a later unrelated session would inherit.
    expect(await freshSessionSettings()).toEqual(before);
  }, 60_000);

  it("fails apply in bounded time behind a held target row lock, with no partial erasure", async () => {
    let result: CliResult | undefined;
    await client.begin(async (tx) => {
      await tx`select id from users where id = ${MEMBER_A} for update`;
      const running = startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
      await waitForLockWaiters(client, DB_NAME, 1);
      result = await running;
    });
    expectFailure(result!);
    // All-or-nothing: the first delete timed out, so nothing was removed.
    const seeded = {
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
    };
    expect(await countsFor(MEMBER_A)).toEqual(seeded);
    expect(await countsFor(MEMBER_B)).toEqual(seeded);
  }, 60_000);

  it("fails dry-run in bounded time behind a held table lock", async () => {
    let result: CliResult | undefined;
    await client.begin(async (tx) => {
      await tx.unsafe("lock table users in access exclusive mode");
      const running = startCli([`--discord-id=${MEMBER_A}`], cliEnv());
      await waitForLockWaiters(client, DB_NAME, 1);
      result = await running;
    });
    expectFailure(result!);
    const seeded = {
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
    };
    expect(await countsFor(MEMBER_A)).toEqual(seeded);
    expect(await countsFor(MEMBER_B)).toEqual(seeded);
  }, 60_000);

  it("succeeds when the held row lock is released before the budget expires", async () => {
    let running: Promise<CliResult> | undefined;
    await client.begin(async (tx) => {
      await tx`select id from users where id = ${MEMBER_A} for update`;
      running = startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
      await waitForLockWaiters(client, DB_NAME, 1);
      // Re-observe the waiter still queued before releasing, so the release
      // (not CLI startup) is what unblocks it; no fixed sleep.
      await waitForLockWaiters(client, DB_NAME, 1);
    });
    const result = await running!;
    expect(result.timedOut).toBe(false);
    expect(result.status).toBe(0);
    const seeded = {
      users: 1,
      profiles: 1,
      rsvps: 1,
      member_links: 0,
      web_sessions: 2,
      web_session_grace: 0,
      join_attempts: 1,
    };
    expect(JSON.parse(result.stdout)).toEqual({
      mode: "apply",
      counts: seeded,
      passes: 1,
      deletesPerPass: [2],
    });
    expect(await countsFor(MEMBER_A)).toEqual({
      users: 0,
      profiles: 0,
      rsvps: 0,
      member_links: 0,
      web_sessions: 0,
      web_session_grace: 0,
      join_attempts: 0,
    });
    expect(await countsFor(MEMBER_B)).toEqual(seeded);
  }, 60_000);
});
