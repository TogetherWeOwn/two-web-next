import { spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createPostgresSessionStore, migrate, type Sql } from "../src/sessions";
// @ts-expect-error Standalone Node CLI is intentionally JavaScript, like bin/import.
// biome-ignore format: keep the directive adjacent to TS7016 (wrapping detaches it)
import { createRevokeClient } from "../bin/revoke-sessions.mjs";
import { testDatabaseUrl } from "./helpers/member-data-db";

// Acceptance contract: the operator revoke-sessions CLI must bound its own
// SQL waits with finite server-enforced statement and lock budgets, on both
// dry-run and apply, without ever skipping a locked session or reporting
// success while a target session stays active. A timeout is a nonzero,
// redacted failure with every partial change rolled back. These tests drive
// the real CLI process against a per-invocation disposable database because
// the CLI pins search_path=public, so schema-scoped fixtures cannot reach it.

const repoRoot = fileURLToPath(new URL("..", import.meta.url).href);
const script = fileURLToPath(new URL("../bin/revoke-sessions.mjs", import.meta.url).href);
const MEMBER_A = "100000000000000301";
const MEMBER_B = "100000000000000302";
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

describe("revoke-sessions bounded waits: client budget and runbook", () => {
  it("configures finite server-side statement_timeout and lock_timeout on the CLI client", () => {
    let options: unknown;
    const capture = (firstArg: unknown, secondArg?: unknown) => {
      options = secondArg ?? firstArg;
      return {};
    };
    createRevokeClient(capture, "postgres://fixture@db.example.test/neondb?sslmode=verify-full");
    // Server-enforced budgets travel as session settings on this CLI's own
    // single connection, so they cover the dry-run count (no transaction)
    // and every apply statement alike, and cannot become a client-side race
    // that abandons a still-running statement.
    const statement = findTimeoutMs(options, "statement_timeout");
    const lock = findTimeoutMs(options, "lock_timeout");
    expect(statement, "statement_timeout must be set and finite").toBeDefined();
    expect(lock, "lock_timeout must be set and finite").toBeDefined();
    // Wide enough for a remote round trip, small enough that an emergency
    // revocation against a locked row fails in seconds, not minutes.
    for (const budget of [statement!, lock!]) {
      expect(budget).toBeGreaterThanOrEqual(1_000);
      expect(budget).toBeLessThanOrEqual(15_000);
    }
  });

  it("never uses SKIP LOCKED in the revocation path", () => {
    // Maintenance-style skip-locked semantics are expressly unsuitable for
    // emergency revocation: a locked target session must wait or fail the
    // whole operation, never be silently left active.
    for (const path of ["../src/session-revocation.ts", "../bin/revoke-sessions.mjs"]) {
      const source = readFileSync(fileURLToPath(new URL(path, import.meta.url).href), "utf8");
      expect(source).not.toMatch(/skip\s+locked/i);
    }
  });

  it("documents the bounded failure and the retry/escalation path in the runbook", () => {
    const runbook = readFileSync(
      fileURLToPath(new URL("../docs/runbook.md", import.meta.url).href),
      "utf8",
    );
    const start = runbook.indexOf("## A moderator lost their role");
    expect(start).toBeGreaterThan(-1);
    const section = runbook.slice(start, runbook.indexOf("\n## ", start + 1));
    expect(section).toMatch(/statement_timeout/);
    expect(section).toMatch(/lock_timeout/);
    // A timed-out run revoked nothing: the operator must be told the target
    // sessions may still be active and to verify with a dry-run.
    expect(section).toMatch(/still active|remain[s]? active|not revoked/i);
    expect(section).toMatch(/dry-run/);
    expect(section).toMatch(/re-?run|retry/i);
    expect(section).toMatch(/escalat/i);
  });

  it("still refuses untargeted production and non-verify-full remote TLS, without leaks", async () => {
    const production = "postgres://fixture:synthetic-password@db.production.test/neondb";
    const untargeted = await startCli([`--discord-id=${MEMBER_A}`], { DATABASE_URL: production });
    expect(untargeted.status).toBe(2);
    expect(untargeted.stdout + untargeted.stderr).not.toContain("synthetic-password");
    expect(untargeted.stdout + untargeted.stderr).not.toContain("postgres://");
    const weakTls = await startCli([`--discord-id=${MEMBER_A}`, "--target", "production"], {
      DATABASE_URL: "postgres://fixture:synthetic-password@db.example.test/neondb?sslmode=require",
    });
    expect(weakTls.status).toBe(2);
    expect(weakTls.stderr).toContain("sslmode=verify-full");
    expect(weakTls.stdout + weakTls.stderr).not.toContain("synthetic-password");
  }, 30_000);
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

describe.skipIf(!ambientUrl)(
  "revoke-sessions bounded waits: CLI against disposable Postgres",
  () => {
    let admin: postgres.Sql;
    let client: postgres.Sql;
    let created = false;
    const expiresLater = new Date(Date.now() + 3_600_000).toISOString();
    const expiresEarlier = new Date(Date.now() - 3_600_000).toISOString();
    const cliEnv = () => ({ DATABASE_URL: derivedUrl(ambientUrl!, DB_NAME) });
    const password = () => new URL(ambientUrl!).password;

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
      await migrate(client as unknown as Sql);
    });

    beforeEach(async () => {
      await client`delete from web_sessions`;
      await client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at, revoked_at)
        values ('active-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresLater}, null),
               ('revoked-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresLater}, clock_timestamp()),
               ('expired-a', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresEarlier}, null),
               ('active-b', ${MEMBER_B}, 'synthetic-b', true, false, ${expiresLater}, null)`;
    });

    afterAll(async () => {
      await client?.end({ timeout: 1 }).catch(() => {});
      try {
        if (created) await admin?.unsafe(`DROP DATABASE "${DB_NAME}" WITH (FORCE)`);
      } finally {
        await admin?.end({ timeout: 1 }).catch(() => {});
      }
    });

    const activeCount = async (id: string) => {
      const [row] = await client<{ n: number }[]>`select count(*)::int as n from web_sessions
        where user_id = ${id} and revoked_at is null and expires_at > clock_timestamp()`;
      return row?.n ?? 0;
    };

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
        "synthetic-a",
        "synthetic-b",
        "active-a",
      ])
        expect(output).not.toContain(secret);
    };

    it("runs normal dry-run/apply, stays idempotent and other-member safe, and leaves global timeout policy untouched", async () => {
      const before = await freshSessionSettings();
      const dry = await startCli([`--discord-id=${MEMBER_A}`], cliEnv());
      expect(dry.timedOut).toBe(false);
      expect(dry.status).toBe(0);
      expect(JSON.parse(dry.stdout)).toEqual({
        ok: true,
        mode: "dry-run",
        counts: { web_sessions: 1 },
        passes: 0,
        stampsPerPass: [],
      });
      expect(await activeCount(MEMBER_A)).toBe(1);

      const applied = await startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
      expect(applied.status).toBe(0);
      expect(JSON.parse(applied.stdout)).toEqual({
        ok: true,
        mode: "apply",
        counts: { web_sessions: 1 },
        passes: 1,
        stampsPerPass: [1],
      });
      expect(await activeCount(MEMBER_A)).toBe(0);
      expect(await activeCount(MEMBER_B)).toBe(1);

      const again = await startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
      expect(again.status).toBe(0);
      expect(JSON.parse(again.stdout)).toEqual({
        ok: true,
        mode: "apply",
        counts: { web_sessions: 0 },
        passes: 1,
        stampsPerPass: [0],
      });
      expect(await activeCount(MEMBER_B)).toBe(1);

      // Budgets are this CLI session's own settings, never database- or
      // role-level policy a later unrelated session would inherit.
      expect(await freshSessionSettings()).toEqual(before);
    }, 60_000);

    it("fails apply in bounded time behind a held target row lock, with no partial revocation", async () => {
      await client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('active-a2', ${MEMBER_A}, 'synthetic-a', true, true, ${expiresLater})`;
      let result: CliResult | undefined;
      await client.begin(async (tx) => {
        await tx`select token_hash from web_sessions where token_hash = 'active-a' for update`;
        const running = startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
        await waitForLockWaiters(client, DB_NAME, 1);
        result = await running;
      });
      // Bounded server-side failure: the CLI ends itself, nonzero, instead
      // of waiting on the lock forever or skipping the locked row and
      // reporting success for the unlocked one.
      expect(result!.timedOut).toBe(false);
      expect(result!.status).toBe(1);
      expect(result!.stdout).not.toContain('"mode":"apply"');
      // The lock-timeout rollback maps to its distinct retry message, not the
      // generic failure text: pin the 55P03 marker and the retry instruction.
      expect(result!.stderr).toContain("55P03");
      expect(result!.stderr).toContain("Retry once the lock clears");
      expectRedacted(result!);
      // All-or-nothing: the unlocked sibling session was not revoked either.
      expect(await activeCount(MEMBER_A)).toBe(2);
      expect(await activeCount(MEMBER_B)).toBe(1);
    }, 60_000);

    it("fails dry-run in bounded time behind a held table lock", async () => {
      let result: CliResult | undefined;
      await client.begin(async (tx) => {
        await tx.unsafe("lock table web_sessions in access exclusive mode");
        const running = startCli([`--discord-id=${MEMBER_A}`], cliEnv());
        await waitForLockWaiters(client, DB_NAME, 1);
        result = await running;
      });
      expect(result!.timedOut).toBe(false);
      expect(result!.status).toBe(1);
      expect(result!.stdout).not.toContain('"mode":"dry-run"');
      // The lock-timeout rollback maps to its distinct retry message, not the
      // generic failure text: pin the 55P03 marker and the retry instruction.
      expect(result!.stderr).toContain("55P03");
      expect(result!.stderr).toContain("Retry once the lock clears");
      expectRedacted(result!);
      expect(await activeCount(MEMBER_A)).toBe(1);
      expect(await activeCount(MEMBER_B)).toBe(1);
    }, 60_000);

    it("succeeds when the held row lock is released before the budget expires", async () => {
      let running: Promise<CliResult> | undefined;
      await client.begin(async (tx) => {
        await tx`select token_hash from web_sessions where token_hash = 'active-a' for update`;
        running = startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
        await waitForLockWaiters(client, DB_NAME, 1);
        // Re-observe the waiter still queued before releasing, so the release
        // (not CLI startup) is what unblocks it; no fixed sleep.
        await waitForLockWaiters(client, DB_NAME, 1);
      });
      const result = await running!;
      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({
        ok: true,
        mode: "apply",
        counts: { web_sessions: 1 },
        passes: 1,
        stampsPerPass: [1],
      });
      expect(await activeCount(MEMBER_A)).toBe(0);
      expect(await activeCount(MEMBER_B)).toBe(1);
    }, 60_000);

    it("revokes a rotation successor queued ahead of the CLI apply", async () => {
      await client`delete from web_sessions`;
      await client`insert into web_sessions (token_hash, user_id, username, member, moderator, expires_at)
        values ('race-other-user', ${MEMBER_B}, 'synthetic-b', true, false, ${expiresLater})`;
      const store = createPostgresSessionStore(client as unknown as Sql);
      const source = {
        tokenHash: "race-source",
        userId: MEMBER_A,
        username: "synthetic-a",
        avatar: null,
        member: true,
        moderator: true,
        // Fixture binds expiry as ISO text because postgres.js date serialization varies by version.
        expiresAt: expiresLater as unknown as Date,
      };
      await store.create(source);
      let rotation: Promise<boolean> | undefined;
      let running: Promise<CliResult> | undefined;
      await client.begin(async (tx) => {
        await tx`select token_hash from web_sessions where token_hash = ${source.tokenHash} for update`;
        rotation = store.rotate(source.tokenHash, { ...source, tokenHash: "race-replacement" });
        await waitForLockWaiters(client, DB_NAME, 1);
        running = startCli([`--discord-id=${MEMBER_A}`, "--apply"], cliEnv());
        await waitForLockWaiters(client, DB_NAME, 2);
      });
      expect(await rotation!).toBe(true);
      const result = await running!;
      expect(result.timedOut).toBe(false);
      expect(result.status).toBe(0);
      // Pass count depends on the race interleaving, so pin the counts plus
      // the pass invariants rather than an exact pass array.
      const parsed = JSON.parse(result.stdout) as {
        mode: string;
        counts: { web_sessions: number };
        passes: number;
        stampsPerPass: number[];
      };
      expect(parsed).toMatchObject({ mode: "apply", counts: { web_sessions: 1 } });
      expect(parsed.passes).toBe(parsed.stampsPerPass.length);
      expect(parsed.stampsPerPass.reduce((total, stamped) => total + stamped, 0)).toBe(
        parsed.counts.web_sessions,
      );
      expect(await activeCount(MEMBER_A)).toBe(0);
      expect(await activeCount(MEMBER_B)).toBe(1);
    }, 60_000);
  },
);
