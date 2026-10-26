// Acceptance-owned: consume unchanged; corrections return to the test author.
// Run with an approved disposable DATABASE_URL:
//   npm test -- test/jobs-server-timeouts-acceptance.test.ts
// Removing a statement's DB budget must fail its trigger case. A JS-only race,
// swallowed cancellation, disconnected backend, leaked SET or partial failed()
// commit must fail the error, PID, settings or persisted-row observations.
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgEventStore } from "../src/jobs/events";
import { pgQueueLedger, pgUniqueLock } from "../src/jobs/postgres";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { testDatabaseUrl } from "./helpers/member-data-db";

// An explicit URL is required so this suite cannot silently skip its SQL proof.
const DB = process.env.DATABASE_URL;
const BASE = { statement: "4s", lock: "0" };
// Independent consumer-facing budget, not imported from the implementation.
const MAX_BUDGET_MS = 2000;
const AVAILABLE = new Date("2026-01-01T00:00:00.000Z");
const RETRY_AT = new Date("2026-01-01T01:00:00.000Z");
const TOKEN = "11111111-1111-4111-8111-111111111111";
const OTHER_TOKEN = "22222222-2222-4222-8222-222222222222";
const CASES = [
  ["enqueued", "queue_jobs", "INSERT"],
  ["reserved", "queue_jobs", "UPDATE"],
  ["released", "queue_jobs", "UPDATE"],
  ["dequeued", "queue_jobs", "DELETE"],
  ["failed insert", "queue_failed_jobs", "INSERT"],
  ["failed delete", "queue_jobs", "DELETE"],
  ["acquire", "job_unique_locks", "INSERT"],
  ["release", "job_unique_locks", "DELETE"],
] as const;
type Operation = (typeof CASES)[number][0];
type Snapshot = { pid: number; statement: string; lock: string };
type Probe = { pid: number; statement_ms: number; lock_ms: number };

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function rejected(work: Promise<unknown>): Promise<unknown> {
  try {
    await work;
    return undefined;
  } catch (error) {
    return error;
  }
}

async function snapshot(sql: postgres.Sql | postgres.TransactionSql): Promise<Snapshot> {
  const [row] = await sql<Snapshot[]>`select pg_backend_pid() as pid,
    current_setting('statement_timeout') as statement, current_setting('lock_timeout') as lock`;
  return row!;
}

describe("jobs server-side execution budgets (disposable Postgres, acceptance)", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let holder: postgres.Sql;
  let id: string;
  let notices: Probe[];
  let cleanup: (() => Promise<void>)[];

  beforeAll(async () => {
    if (!DB)
      throw new Error(
        "Set DATABASE_URL to the approved disposable test database before running this suite",
      );
    const url = testDatabaseUrl(DB); // Refuse production/staging before driver construction.
    fixture = await createJobsFixture(url.href);
    const options = {
      max: 1,
      port: 5432,
      connect_timeout: 5,
      password: () => url.password,
      connection: { search_path: fixture.schemaName, statement_timeout: 4000, lock_timeout: 0 },
    };
    sql = postgres(url.href, {
      ...options,
      onnotice: (notice) => {
        if (notice.message?.startsWith("job-budget:"))
          notices.push(JSON.parse(notice.message.slice(11)));
      },
    });
    holder = postgres(url.href, { ...options, onnotice: () => {} });
  });

  beforeEach(async () => {
    notices = [];
    cleanup = [];
    id = randomUUID();
    await fixture!.client`delete from queue_jobs`;
    await fixture!.client`delete from queue_failed_jobs`;
    await fixture!.client`delete from job_unique_locks`;
    await sql`select set_config('statement_timeout', '4s', false), set_config('lock_timeout', '0', false)`;
  });

  afterEach(async () => {
    for (const dispose of cleanup.reverse()) await dispose();
  });

  afterAll(async () => {
    await sql?.end({ timeout: 1 });
    await holder?.end({ timeout: 1 });
    await fixture?.dispose();
  });

  async function seed(operation: Operation) {
    if (operation === "acquire") return;
    if (operation === "release") {
      await fixture!.client`insert into job_unique_locks (key, expires_at, owner_token)
        values (${id}, clock_timestamp() + interval '1 hour', ${TOKEN}::uuid)`;
    } else if (operation !== "enqueued") {
      await fixture!.client`insert into queue_jobs (job_id, kind, key, available_at, reserved_at)
        values (${id}::uuid, 'sync-event', ${id}, ${AVAILABLE}, ${AVAILABLE})`;
    }
  }

  function invoke(operation: Operation, client = sql) {
    const ledger = pgQueueLedger(client);
    switch (operation) {
      case "enqueued":
        return ledger.enqueued({ jobId: id, kind: "sync-event", key: id, availableAt: AVAILABLE });
      case "reserved":
        return ledger.reserved(id);
      case "released":
        return ledger.released(id, RETRY_AT);
      case "dequeued":
        return ledger.dequeued(id);
      case "failed insert":
      case "failed delete":
        return ledger.failed(id, "sync-event", id, "terminal failure");
      case "acquire":
        return pgUniqueLock(client).acquire(id, 300);
      case "release":
        return pgUniqueLock(client).release(id, TOKEN);
    }
  }

  async function rows() {
    return {
      live: await fixture!
        .client`select job_id, kind, key, available_at, reserved_at from queue_jobs order by job_id`,
      failed: await fixture!
        .client`select job_id, kind, key, reason from queue_failed_jobs order by job_id`,
      locks: await fixture!
        .client`select key, expires_at, owner_token from job_unique_locks order by key`,
    };
  }

  async function trigger(table: string, event: string, stall: boolean) {
    // NOTICE survives rollback and reports the effective settings on the very
    // backend executing the real DML. The fixture cannot install its budget.
    // A lock-free loop wedges execution without a wall-clock sleep; the 4s
    // inherited watchdog keeps broken implementations finite, but cannot pass
    // the independent <=2s budget assertions below.
    await fixture!.client.unsafe(`create function job_budget_probe() returns trigger language plpgsql as $$
      begin
        raise notice 'job-budget:%', json_build_object('pid', pg_backend_pid(),
          'statement_ms', extract(epoch from current_setting('statement_timeout')::interval) * 1000,
          'lock_ms', extract(epoch from current_setting('lock_timeout')::interval) * 1000);
        ${stall ? "loop perform 1; end loop;" : "return coalesce(new, old);"}
      end $$`);
    await fixture!.client.unsafe(`create trigger job_budget_probe before ${event} on ${table}
      for each row execute function job_budget_probe()`);
    cleanup.push(async () => {
      await fixture!.client.unsafe(`drop trigger job_budget_probe on ${table}`);
      await fixture!.client`drop function job_budget_probe()`;
    });
  }

  function expectBudgets(pid: number) {
    expect(
      notices,
      "the operation must actually reach the instrumented SQL statement",
    ).toHaveLength(1);
    expect(notices[0]!.pid).toBe(pid);
    expect(notices[0]!.statement_ms, "statement timeout must be enabled").toBeGreaterThan(0);
    expect(
      notices[0]!.statement_ms,
      "SQL must not outlive the consumer's ledger budget",
    ).toBeLessThanOrEqual(MAX_BUDGET_MS);
    expect(notices[0]!.lock_ms, "lock timeout must be enabled").toBeGreaterThan(0);
    expect(notices[0]!.lock_ms).toBeLessThanOrEqual(MAX_BUDGET_MS);
  }

  for (const [operation, table, event] of CASES) {
    it(`${operation}: cancels wedged SQL, rolls back and reuses the same pooled backend`, async () => {
      await seed(operation);
      const before = await snapshot(sql);
      const persisted = await rows();
      await trigger(table, event, true);
      const error = await rejected(invoke(operation));
      // Before teardown: prove real cancellation, not a test-owned cancel or
      // release, and query the exact max:1 pool that ran the stalled operation.
      const after = await snapshot(sql);
      expect(after).toEqual({ pid: before.pid, ...BASE });
      expect(await rows()).toEqual(persisted);
      expect(error).toMatchObject({
        code: "57014",
        message: expect.stringContaining("statement timeout"),
      });
      await cleanup.pop()!();
      const retried = await invoke(operation);
      if (operation === "acquire") expect(retried).toEqual(expect.any(String));
      else expect(retried).toBeUndefined();
      expect(await snapshot(sql)).toEqual(before);
      expectBudgets(before.pid);
    });

    it(`${operation}: restores non-default pool settings after successful SQL`, async () => {
      await seed(operation);
      const before = await snapshot(sql);
      await trigger(table, event, false);
      await invoke(operation);
      expect(await snapshot(sql)).toEqual(before);
      expectBudgets(before.pid);
    });
  }

  async function parked(lock: (tx: postgres.TransactionSql) => Promise<unknown>) {
    const ready = deferred();
    const release = deferred();
    const pending = holder.begin(async (tx) => {
      await lock(tx);
      ready.resolve();
      await release.promise;
    });
    // A setup failure rejects instead of hanging on an unsignalled rendezvous.
    await Promise.race([
      ready.promise,
      pending.then(() => {
        throw new Error("holder ended before locking");
      }),
    ]);
    cleanup.push(async () => {
      release.resolve();
      await pending;
    });
    return {
      release: async () => {
        release.resolve();
        await pending;
      },
    };
  }

  for (const operation of [
    "reserved",
    "acquire",
    "release",
    "failed insert",
    "needsSync",
  ] as const) {
    it(`${operation}: lock_timeout rejects while the conflicting lock is still held`, async () => {
      if (operation !== "needsSync") await seed(operation);
      if (operation === "acquire") {
        await fixture!.client`insert into job_unique_locks (key, expires_at, owner_token)
          values (${id}, clock_timestamp() - interval '1 hour', ${TOKEN}::uuid)`;
      }
      const before = await snapshot(sql);
      const persisted = await rows();
      const gate = await parked(async (tx) => {
        if (operation === "needsSync") return tx`lock table events in access exclusive mode`;
        if (operation === "failed insert")
          return tx`select pg_advisory_xact_lock(hashtextextended('queue-failed:' || ${id}::uuid::text, 0))`;
        if (operation === "reserved")
          return tx`select 1 from queue_jobs where job_id = ${id}::uuid for update`;
        return tx`select 1 from job_unique_locks where key = ${id} for update`;
      });
      const error = await rejected(
        operation === "needsSync" ? pgEventStore(sql).needsSync(id) : invoke(operation),
      );
      // Capture every observation before releasing the holder. The inherited
      // statement watchdog produces 57014, never the required 55P03 lock error.
      const after = await snapshot(sql);
      const unchanged = await rows();
      await gate.release();
      expect(error).toMatchObject({
        code: "55P03",
        message: expect.stringContaining("lock timeout"),
      });
      expect(after).toEqual(before);
      expect(unchanged).toEqual(persisted);
      if (operation === "needsSync")
        await expect(pgEventStore(sql).needsSync(id)).resolves.toBe(false);
      else await invoke(operation);
      expect(await snapshot(sql)).toEqual(before);
    });
  }

  it("preserves ledger rows, retry timestamps, first failure and independent same-key dispatches", async () => {
    const ledger = pgQueueLedger(sql);
    const other = randomUUID();
    const before = await snapshot(sql);
    await ledger.enqueued({ jobId: id, kind: "sync-event", key: "shared", availableAt: AVAILABLE });
    await ledger.enqueued({
      jobId: other,
      kind: "sync-event",
      key: "shared",
      availableAt: RETRY_AT,
    });
    expect((await rows()).live).toEqual(
      expect.arrayContaining([
        {
          job_id: id,
          kind: "sync-event",
          key: "shared",
          available_at: AVAILABLE,
          reserved_at: null,
        },
        {
          job_id: other,
          kind: "sync-event",
          key: "shared",
          available_at: RETRY_AT,
          reserved_at: null,
        },
      ]),
    );
    await ledger.reserved(id);
    expect((await rows()).live.find((r) => r.job_id === id)?.reserved_at).toBeInstanceOf(Date);
    await ledger.released(id, RETRY_AT);
    expect((await rows()).live.find((r) => r.job_id === id)).toMatchObject({
      available_at: RETRY_AT,
      reserved_at: null,
    });
    await ledger.dequeued(other);
    expect((await rows()).live).toHaveLength(1);
    await ledger.failed(id, "sync-event", "shared", "x".repeat(2001));
    await ledger.failed(id, "announcement", null, "must not replace first failure");
    expect(await rows()).toEqual({
      live: [],
      locks: [],
      failed: [{ job_id: id, kind: "sync-event", key: "shared", reason: "x".repeat(2000) }],
    });
    expect(await snapshot(sql)).toEqual(before);
  });

  it("preserves lease tokens, contention, expiry takeover and stale-owner compare-and-delete", async () => {
    const lock = pgUniqueLock(sql);
    const before = await snapshot(sql);
    const token = await lock.acquire(id, 300);
    expect(token).toEqual(expect.any(String));
    expect((await rows()).locks).toEqual([
      { key: id, expires_at: expect.any(Date), owner_token: token },
    ]);
    const [ttl] = await fixture!
      .client`select extract(epoch from expires_at - clock_timestamp())::float8 as seconds
      from job_unique_locks where key = ${id}`;
    expect(ttl!.seconds).toBeGreaterThan(290);
    expect(ttl!.seconds).toBeLessThanOrEqual(300);
    await expect(lock.acquire(id, 300)).resolves.toBeNull();
    await lock.release(id, OTHER_TOKEN);
    expect((await rows()).locks).toHaveLength(1);
    await fixture!
      .client`update job_unique_locks set expires_at = clock_timestamp() - interval '1 hour' where key = ${id}`;
    const successor = await lock.acquire(id, 300);
    expect(successor).toEqual(expect.any(String));
    expect(successor).not.toBe(token);
    await lock.release(id, token!);
    expect((await rows()).locks[0]!.owner_token).toBe(successor);
    await lock.release(id, successor!);
    expect((await rows()).locks).toEqual([]);
    expect(await snapshot(sql)).toEqual(before);
  });

  it("unique-lock operations preserve the caller's existing transaction settings", async () => {
    await sql.begin(async (tx) => {
      await tx`select set_config('statement_timeout', '13s', true), set_config('lock_timeout', '11s', true)`;
      const before = await snapshot(tx);
      const lock = pgUniqueLock(tx);
      const token = await lock.acquire(id, 300);
      expect(token).toEqual(expect.any(String));
      expect(await snapshot(tx)).toEqual(before);
      await lock.release(id, token!);
      expect(await snapshot(tx)).toEqual(before);
    });
    expect((await rows()).locks).toEqual([]);
    expect(await snapshot(sql)).toMatchObject(BASE);
  });
});
