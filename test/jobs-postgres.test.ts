import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgReconciliationReads } from "../src/admin/reconciliation-reads";
import {
  reconciliationService,
  reconciliationServiceFor,
} from "../src/admin/reconciliation-service";
import { CALL_INTERNAL_ACTION } from "../src/jobs/constants";
import { pgPruneStores, pgSingleFlight, pgUniqueLock } from "../src/jobs/postgres";
import { pgReconciliationStore } from "../src/jobs/reconciliation";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";
import { registerJobsServerTimeoutsAcceptance } from "./helpers/jobs-server-timeouts-acceptance";
import { env } from "./helpers/member-data";

// Real Postgres, guarded before driver construction: agent-testdb or the CI
// service only. Each fixture migrates and drops only its disposable schema.
describe.skipIf(!process.env.DATABASE_URL)("postgres single-flight + unique lock", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  const own = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const unavailable = { kind: "unavailable" };
  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  it("serializes concurrent announcement claims and counts only acquired sends", async () => {
    const store = pgReconciliationStore(sql);
    const key = crypto.randomUUID();
    const queuedAt = new Date();
    const claim = () => store.claimAnnouncement(key, "fixture-channel", queuedAt);
    for (let attempts = 1; attempts <= CALL_INTERNAL_ACTION.tries; attempts++) {
      const claims = await Promise.all([claim(), claim()]);
      expect(claims.map((claim) => claim.kind).sort()).toEqual(["claimed", "sending"]);
      expect(claims[0]).toMatchObject({ attempts, claimUntil: expect.any(Date) });
      expect(claims[1]).toMatchObject({ attempts });
      if (attempts > 1)
        expect(await store.finishAnnouncement(key, attempts - 1, "closed")).toBe(false);
      if (attempts < CALL_INTERNAL_ACTION.tries) {
        expect(await store.finishAnnouncement(key, attempts, "retryable")).toBe(true);
        // A different alias cannot acquire even an otherwise eligible slot.
        expect(await store.claimAnnouncement(key, "other-channel", queuedAt)).toEqual(unavailable);
      }
    }
    const attempts = CALL_INTERNAL_ACTION.tries;
    await expect(store.finishAnnouncement(key, attempts, "retryable")).rejects.toThrow(
      "Invalid announcement claim settlement",
    );
    expect(await claim()).toMatchObject({ kind: "sending", attempts });
    expect(await store.finishAnnouncement(key, attempts, "closed")).toBe(true);
    expect(await claim()).toMatchObject({ kind: "closed", attempts });
    expect(await store.finishAnnouncement(key, attempts - 1, "retryable")).toBe(false);
  });

  it("does not count a rejected database reservation", async () => {
    const key = crypto.randomUUID();
    const store = pgReconciliationStore(sql);
    const queuedAt = new Date();
    const claim = () => store.claimAnnouncement(key, "fixture-channel", queuedAt);
    expect(await claim()).toMatchObject({ kind: "claimed", attempts: 1 });
    expect(await store.finishAnnouncement(key, 1, "retryable")).toBe(true);
    await sql`alter table announcement_send_claims add constraint fixture_reject_second_send
      check (send_attempts <> 2) not valid`;
    try {
      await expect(claim()).rejects.toMatchObject({ code: "23514" });
    } finally {
      await sql`alter table announcement_send_claims drop constraint fixture_reject_second_send`;
    }
    expect(await claim()).toMatchObject({ kind: "claimed", attempts: 2 });
  });

  it("does not reopen an announcement whose lease expires behind a lock-only holder", async () => {
    const key = crypto.randomUUID();
    const store = pgReconciliationStore(sql);
    await sql`insert into announcement_send_claims (idempotency_key, channel_alias, send_attempts, state, claim_until)
      values (${key}, 'fixture-channel', 1, 'sending', clock_timestamp() + interval '1 second')`;
    let markLocked!: () => void;
    const locked = new Promise<void>((resolve) => {
      markLocked = resolve;
    });
    const settling = locked.then(() => store.finishAnnouncement(key, 1, "retryable"));
    const holding = sql.begin(async (tx) => {
      const [holder] = await tx<{ pid: number; claim_until: Date }[]>`
        select pg_backend_pid() as pid, claim_until
        from announcement_send_claims where idempotency_key = ${key} for update`;
      if (!holder) throw new Error("Missing fixture claim to lock");
      const { pid, claim_until } = holder;
      markLocked();
      await expect
        .poll(
          async () => {
            const rows =
              await sql`select 1 from pg_stat_activity where ${pid} = any(pg_blocking_pids(pid))
          and clock_timestamp() < ${claim_until}::timestamptz`;
            return rows.length;
          },
          { timeout: 750, interval: 10 },
        )
        .toBe(1);
      await tx`select pg_sleep_until(${claim_until}::timestamptz + interval '5 milliseconds')`;
    });
    const [settled] = await Promise.all([settling, holding]);
    expect(settled).toBe(false);
    expect(await store.claimAnnouncement(key, "fixture-channel", new Date())).toMatchObject({
      kind: "abandoned",
      attempts: 1,
    });
  });

  it("keeps a failed hard stop fenced and recovers an abandoned claim without wire diagnostics", async () => {
    const key = crypto.randomUUID();
    const store = pgReconciliationStore(sql);
    const queuedAt = new Date();
    const claim = () => store.claimAnnouncement(key, "fixture-channel", queuedAt);
    const evidence = { lastCode: "needs_reconciliation", lastStatus: 409 };
    expect(await claim()).toMatchObject({ kind: "claimed", attempts: 1 });
    await expect(store.recordAnnouncement(key, 1, null)).rejects.toThrow("claim changed");
    await sql`insert into bot_reconciliation_intents (idempotency_key, verb, subject, attempts)
      values (${key}, 'event.upsert', 'fixture-event', 1)`;
    await expect(store.recordAnnouncement(key, 1, evidence)).rejects.toThrow(
      "not an open matching intent",
    );
    expect(await claim()).toMatchObject({ kind: "sending", attempts: 1 });
    await sql`delete from bot_reconciliation_intents where idempotency_key = ${key}`;
    await sql`update announcement_send_claims set claim_until = now() - interval '31 days'
      where idempotency_key = ${key}`;
    expect(await claim()).toMatchObject({ kind: "abandoned", attempts: 1 });
    expect(await store.finishAnnouncement(key, 1, "retryable")).toBe(false);
    await expect(store.recordAnnouncement(key, 1, evidence)).rejects.toThrow("claim changed");
    await store.recordAnnouncement(key, 1, null);
    expect(await claim()).toMatchObject({ kind: "closed", attempts: 1 });
    const [saved] = await sql`select verb, subject, attempts, last_code, last_status
      from bot_reconciliation_intents where idempotency_key = ${key}`;
    expect(saved).toEqual({
      verb: "announcement.post",
      subject: "fixture-channel",
      attempts: 1,
      last_code: null,
      last_status: null,
    });
    expect(await store.pruneClosedAnnouncements()).toBe(0);
    expect(await store.resolve(key, "123", "not_applied", async () => {})).toBe(true);
    expect(await store.pruneClosedAnnouncements()).toBe(1);
    expect(await claim()).toEqual(unavailable); // Resolved key remains suppressed.
  });

  it("commits hard-stop diagnostics and never reacquires a pruned original carrier", async () => {
    const key = crypto.randomUUID();
    const retired = crypto.randomUUID();
    const store = pgReconciliationStore(sql);
    expect(await store.claimAnnouncement(key, "fixture-channel", new Date())).toMatchObject({
      kind: "claimed",
    });
    await store.recordAnnouncement(key, 1, { lastCode: "needs_reconciliation", lastStatus: 409 });
    const [saved] =
      await sql`select last_code, last_status from bot_reconciliation_intents where idempotency_key = ${key}`;
    expect(saved).toEqual({ last_code: "needs_reconciliation", last_status: 409 });
    const sending = crypto.randomUUID();
    const retryable = crypto.randomUUID();
    await sql`insert into announcement_send_claims (idempotency_key, channel_alias, send_attempts, state, claim_until)
      values (${retired}, 'fixture-channel', 1, 'closed', now() - interval '31 days'),
        (${sending}, 'fixture-channel', 1, 'sending', now() - interval '31 days'),
        (${retryable}, 'fixture-channel', 1, 'retryable', now() - interval '31 days')`;
    await sql`insert into announcement_send_claims (idempotency_key, channel_alias, send_attempts, state, claim_until)
      select gen_random_uuid(), 'fixture-channel', 1, 'closed', now() - interval '32 days'
      from generate_series(1, 1000)`;
    expect(await store.pruneClosedAnnouncements()).toBe(1000);
    await sql.begin(async (tx) => {
      const [clock] = await tx<{ expiry: Date; enqueued: Date }[]>`
        select now() + interval '750 milliseconds' as expiry,
        now() + interval '750 milliseconds' - interval '720 hours' as enqueued`;
      if (!clock) throw new Error("Missing fixture transaction time");
      await tx`select pg_sleep_until(${clock.expiry}::timestamptz + interval '5 milliseconds')`;
      expect(await store.pruneClosedAnnouncements()).toBe(1);
      // Run admission in a savepoint so it inherits the pre-expiry transaction timestamp.
      const { claimAnnouncement } = pgReconciliationStore(tx as unknown as postgres.Sql);
      expect(await claimAnnouncement(retired, "fixture-channel", clock.enqueued)).toEqual(
        unavailable,
      );
    });
    expect(
      await sql`select state from announcement_send_claims
      where idempotency_key in (${sending}, ${retryable}) order by state`,
    ).toEqual([{ state: "retryable" }, { state: "sending" }]);
  });

  it("never admits a pruned original carrier after the fall clock change", async () => {
    await sql.begin(async (tx) => {
      const key = crypto.randomUUID();
      // Freeze only the statement clock in this disposable schema and transaction.
      await tx`select set_config('search_path', quote_ident(current_schema()) || ', pg_catalog', true)`;
      await tx`set local time zone 'America/New_York'`;
      await tx`create function statement_timestamp() returns timestamptz stable language sql
        as $$ select current_setting('fixture.clock')::timestamptz $$`;
      await tx`insert into announcement_send_claims values (${key}, 'fixture-channel', 1, 'closed', '2026-10-02 01:58:30-04')`;
      const dst = pgReconciliationStore(tx as unknown as postgres.Sql);
      await tx`set local fixture.clock = '2026-11-01 01:59:50-04'`;
      expect(await dst.pruneClosedAnnouncements()).toBe(1);
      await tx`set local fixture.clock = '2026-11-01 01:00:10-05'`;
      const queuedAt = new Date("2026-10-02T01:58:00-04:00");
      expect(await dst.claimAnnouncement(key, "fixture-channel", queuedAt)).toEqual(unavailable);
      await tx`drop function statement_timestamp()`;
    });
  });

  it("returns filtered, ordered reconciliation windows at both limits", async ({
    onTestFinished,
  }) => {
    const windowFixture = await createJobsFixture(process.env.DATABASE_URL!);
    onTestFinished(() => windowFixture.dispose());
    const sql = windowFixture.client;
    const reads = pgReconciliationReads(sql);
    const key = (n: number) => `00000000-0000-0000-0000-${n.toString().padStart(12, "0")}`;
    const keys = (start: number, count: number) =>
      Array.from({ length: count }, (_, i) => key(start + i));
    const resultKeys = (rows: Awaited<ReturnType<typeof reads.listOpen>>) =>
      rows.map((row) => row.idempotencyKey);

    expect(await reads.listOpen()).toEqual([]);
    expect(await reads.listResolved()).toEqual([]);
    await sql`insert into bot_reconciliation_intents
      (idempotency_key, verb, subject, first_seen_at, resolved_at, attempts)
      select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
        'event.upsert', 'event:42', '2026-01-02'::timestamptz, null, 1
      from generate_series(1, 100) as n`;
    await sql`insert into bot_reconciliation_intents
      (idempotency_key, verb, subject, first_seen_at, resolved_at, attempts)
      select ('00000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
        'event.upsert', 'event:42', '2026-01-02'::timestamptz, '2026-01-02'::timestamptz, 1
      from generate_series(201, 250) as n`;
    expect(resultKeys(await reads.listOpen())).toEqual(keys(1, 100));
    expect(resultKeys(await reads.listResolved())).toEqual(keys(201, 50));

    await sql`insert into bot_reconciliation_intents
      (idempotency_key, verb, subject, first_seen_at, resolved_at, attempts) values
      (${key(101)}::uuid, 'event.upsert', 'event:42', '2026-01-01'::timestamptz, null, 1),
      (${key(251)}::uuid, 'event.upsert', 'event:42', '2026-01-02'::timestamptz, '2026-01-03'::timestamptz, 1)`;
    expect(resultKeys(await reads.listOpen())).toEqual([key(101), ...keys(1, 99)]);
    expect(resultKeys(await reads.listResolved())).toEqual([key(251), ...keys(201, 49)]);
  });

  it("returns exact Dates from both reconciliation clients regardless of DateStyle", async ({
    onTestFinished,
  }) => {
    // Both pools have one connection, so the setting reaches every read transaction.
    const dateFixture = await createJobsFixture(process.env.DATABASE_URL!);
    onTestFinished(() => dateFixture.dispose());
    const sql = dateFixture.client;
    const openKey = "00000000-0000-0000-0002-000000000001";
    const resolvedKey = "00000000-0000-0000-0002-000000000002";
    const firstSeenAt = "2026-12-17T09:10:11.123+02:00";
    const lastAttemptAt = "2026-12-18T10:11:12.456+02:00";
    const resolvedAt = "2026-12-19T11:12:13.789999+02:00";
    await sql`insert into bot_reconciliation_intents
      (idempotency_key, verb, subject, attempts, first_seen_at, last_attempt_at, resolved_at) values
      (${openKey}::uuid, 'event.upsert', 'event:42', 1, ${firstSeenAt}, ${lastAttemptAt}, null),
      (${resolvedKey}::uuid, 'event.upsert', 'event:43', 1, ${firstSeenAt}, ${lastAttemptAt}, ${resolvedAt})`;

    const actor = "100000000000000112";
    const injected = await reconciliationServiceFor({ ...env, ADMIN_DB: dateFixture.db }, actor);
    const timestamps = {
      firstSeenAt: new Date("2026-12-17T07:10:11.123Z"),
      lastAttemptAt: new Date("2026-12-18T08:11:12.456Z"),
    };
    const open = { ...timestamps, idempotencyKey: openKey, resolvedAt: null };
    const resolved = {
      ...timestamps,
      idempotencyKey: resolvedKey,
      resolvedAt: new Date("2026-12-19T09:12:13.789Z"),
    };
    for (const [client, service] of [
      [sql, reconciliationService(sql, actor)],
      [dateFixture.db.$client, injected!],
    ] as const) {
      for (const dateStyle of ["ISO, MDY", "SQL, DMY"]) {
        await client`select set_config('DateStyle', ${dateStyle}, false)`;
        expect(await service.get(openKey)).toMatchObject(open);
        expect(await service.get(resolvedKey)).toMatchObject(resolved);
        expect(await service.listOpen()).toEqual([expect.objectContaining(open)]);
        expect(await service.listResolved()).toEqual([expect.objectContaining(resolved)]);
        expect(await client`show DateStyle`).toEqual([{ DateStyle: dateStyle }]);
      }
    }
  });

  it("records moderator access, resolves once under contention, and refuses failed receipts", async () => {
    const key = (n: number) => `00000000-0000-0000-0001-${n.toString().padStart(12, "0")}`;
    const actor = "100000000000000111";
    const service = reconciliationService(sql, actor);
    await sql`insert into bot_reconciliation_intents (idempotency_key, verb, subject, attempts)
      values (${key(1)}::uuid, 'event.upsert', 'event:42', 1),
        (${key(2)}::uuid, 'event.upsert', 'event:43', 1)`;

    expect(await service.get(key(1))).toMatchObject({ idempotencyKey: key(1), resolvedAt: null });
    expect(await service.get(key(3))).toBeNull();
    expect(
      (
        await Promise.all([
          service.resolve(key(1), "confirmed"),
          service.resolve(key(1), "confirmed"),
        ])
      ).sort(),
    ).toEqual(["resolved", "unchanged"]);
    expect(await service.get(key(1))).toMatchObject({
      idempotencyKey: key(1),
      resolution: "confirmed",
    });
    const receipts = await sql`select subject_id, description from activity_log
      where causer_id = ${actor} and subject_type = 'bot_reconciliation_intents'`;
    expect(receipts.filter((row) => row.description === "bot-reconciliation.read")).toEqual(
      expect.arrayContaining([{ description: "bot-reconciliation.read", subject_id: null }]),
    );
    expect(receipts.filter((row) => row.description === "bot-reconciliation.resolve")).toEqual([
      { description: "bot-reconciliation.resolve", subject_id: key(1) },
    ]);

    // Refuse new receipts in this disposable schema, leaving existing evidence intact.
    await sql`alter table activity_log add constraint test_refuse_reconciliation_receipt
      check (subject_type <> 'bot_reconciliation_intents') not valid`;
    try {
      const receiptViolation = {
        code: "23514",
        constraint_name: "test_refuse_reconciliation_receipt",
      };
      await expect(service.get(key(2))).rejects.toMatchObject(receiptViolation);
      await expect(service.resolve(key(2), "not_applied")).rejects.toMatchObject(receiptViolation);
      expect(await pgReconciliationReads(sql).get(key(2))).toMatchObject({
        idempotencyKey: key(2),
        resolvedAt: null,
        resolution: null,
      });
    } finally {
      await sql`alter table activity_log drop constraint test_refuse_reconciliation_receipt`;
    }
  });

  // Observe the holder instead of guessing with a sleep: pg_try_advisory_xact_lock
  // never blocks, so there is no waiter to watch — poll pg_locks until the exact
  // advisory key for `name` is granted to another backend, with a deadline.
  async function waitForAdvisoryHeld(name: string): Promise<void> {
    const [keyRow] = await sql<{ k: string }[]>`
      select hashtextextended(${name}, 0)::text as k`;
    const signed = BigInt(keyRow!.k);
    const unsigned = signed >= 0n ? signed : signed + (1n << 64n);
    const high = Number(unsigned >> 32n);
    const low = Number(unsigned & 0xffffffffn);
    const deadline = performance.now() + 2000;
    for (;;) {
      const [held] = await sql<{ n: number }[]>`
        select count(*)::int as n from pg_locks
        where locktype = 'advisory' and granted
          and classid::bigint = ${high} and objid::bigint = ${low}
          and pid <> pg_backend_pid()`;
      if (held!.n > 0) return;
      if (performance.now() >= deadline)
        throw new Error("first flight did not hold the advisory lock");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  it("overlapping cron invocations single-flight, and the lock frees afterwards", async () => {
    const name = own("test-flight");
    const flight = pgSingleFlight(sql);
    let running = 0,
      maxRunning = 0,
      runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const job = async () => {
      running++;
      maxRunning = Math.max(maxRunning, running);
      runs++;
      await gate;
      running--;
    };
    const first = flight(name, job);
    let second = false;
    try {
      await waitForAdvisoryHeld(name); // first now holds the lock
      second = await flight(name, job); // overlaps: must skip
    } finally {
      // Release the gate even when observation times out so the blocked
      // first flight never leaks an open transaction into teardown.
      release();
      await Promise.allSettled([first]);
    }
    expect(await first).toBe(true);
    expect(second).toBe(false);
    expect(runs).toBe(1);
    expect(maxRunning).toBe(1);
    expect(await flight(name, async () => {})).toBe(true); // released after commit
  });

  it("different jobs do not block each other", async () => {
    const flight = pgSingleFlight(sql);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const nameA = own("a");
    const a = flight(nameA, () => gate);
    try {
      await waitForAdvisoryHeld(nameA);
      expect(await flight(own("b"), async () => {})).toBe(true);
    } finally {
      // Release the gate even when observation times out so the blocked
      // flight never leaks an open transaction into teardown.
      release();
      await Promise.allSettled([a]);
    }
    await a;
  });

  describe("reserved transaction", () => {
    let single: JobsFixture | undefined;
    beforeAll(async () => {
      // Keep schema/session migration outside the test's deadlock budget.
      single = await createJobsFixture(process.env.DATABASE_URL!, { max: 1 });
      const { migrate } = await import("../src/sessions");
      await migrate(single.client as unknown as Parameters<typeof migrate>[0]);
    });
    afterAll(async () => {
      await single?.dispose();
    });

    it("flight body queries run on the reserved tx (no max:1 deadlock)", async () => {
      // The outer pool has one connection held by the flight; prune queries
      // must use its reserved client. Dispatch uses a separate autocommit pool.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        const ran = await Promise.race([
          pgSingleFlight(single!.client)(own("prune"), async (db) => {
            const stores = pgPruneStores(db);
            const lock = pgUniqueLock(db);
            for (const table of [
              stores.agentEventAudits,
              stores.accessLog,
              stores.joinAttempts,
              stores.idempotencyKeys,
              stores.searchLog,
              stores.boardViews,
            ]) {
              expect(await table.pruneOlderThan(new Date(0))).toBe(0);
            }
            expect(await stores.sessions.sweepExpired(new Date())).toBe(0);
            expect(await lock.acquire(own("prune-tx"), 60)).toEqual(expect.any(String));
          }),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(
              () => reject(new Error("deadlock: body stalled on max:1 pool")),
              3000,
            );
          }),
        ]);
        expect(ran).toBe(true);
      } finally {
        clearTimeout(timeout);
      }
    });
  });

  it("unique lock: one winner, expiry frees it, release frees it", async () => {
    const lock = pgUniqueLock(sql);
    const key = own("k");
    const wins = await Promise.all([1, 2, 3, 4].map(() => lock.acquire(key, 300)));
    expect(wins.filter(Boolean)).toHaveLength(1);
    await sql`update job_unique_locks set expires_at = now() - interval '1 second' where key = ${key}`;
    const replacement = await lock.acquire(key, 300); // expired row is taken over
    expect(replacement).toEqual(expect.any(String));
    await lock.release(key, replacement!);
    const next = await lock.acquire(key, 300);
    expect(next).toEqual(expect.any(String));
    await lock.release(key, next!);
  });

  // Both lease proofs below compare database-clock readings taken inside one
  // transaction, so no host scheduling delay can flip them. `pg_sleep` only
  // guarantees the transaction is older than its start timestamp; the proofs
  // never bound how long it ran.
  async function elapsedInTx(tx: postgres.TransactionSql) {
    const [row] = await tx<{ elapsed: string }[]>`
      select (clock_timestamp() - transaction_timestamp())::text as elapsed`;
    return row!.elapsed;
  }

  /** True when the lease runs at least `elapsed + ttl` past the transaction start. */
  async function leaseCoversTtlFromAcquire(
    tx: postgres.TransactionSql,
    key: string,
    ttlSeconds: number,
    elapsedBeforeAcquire: string,
  ) {
    const [row] = await tx<{ ok: boolean }[]>`
      select (expires_at - transaction_timestamp())
        >= (${elapsedBeforeAcquire}::interval + make_interval(secs => ${ttlSeconds})) as ok
      from job_unique_locks where key = ${key}`;
    return row!.ok;
  }

  it("new locks get their full TTL even in an old transaction", async () => {
    await sql.begin(async (tx) => {
      await tx`select pg_sleep(0.2)`;
      const elapsed = await elapsedInTx(tx);
      const key = own("fresh-ttl");
      expect(await pgUniqueLock(tx).acquire(key, 60)).toEqual(expect.any(String));
      // Transaction-start expiry would sit exactly `ttl` past the start, short
      // of `elapsed + ttl` by at least the 0.2 s the sleep guaranteed.
      // Acquisition-time expiry always clears it, however slow the host.
      expect(await leaseCoversTtlFromAcquire(tx, key, 60, elapsed)).toBe(true);
    });
  });

  it("takes over a lock that expired after the transaction began", async () => {
    const key = own("elapsed-ttl");
    await sql.begin(async (tx) => {
      await tx`select pg_sleep(0.2)`;
      const elapsed = await elapsedInTx(tx);
      // Expiry at the midpoint of the transaction so far: strictly after the
      // transaction start (elapsed >= 0.2 s) and strictly before the acquire
      // below (the clock never runs backwards), at any host speed.
      await tx`insert into job_unique_locks (key, expires_at)
        values (${key}, transaction_timestamp() + ${elapsed}::interval / 2)`;
      // A start-of-transaction comparison sees this row as still live.
      expect(await pgUniqueLock(tx).acquire(key, 60)).toEqual(expect.any(String));
      expect(await leaseCoversTtlFromAcquire(tx, key, 60, elapsed)).toBe(true);
    });
  });

  registerJobsServerTimeoutsAcceptance();
});
