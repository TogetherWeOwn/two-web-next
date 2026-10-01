import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { consume } from "../src/jobs/consumer";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";
import { BotTerminalError, type BotClient, type EventStore, type UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

type Sql = Parameters<typeof pgQueueLedger>[0];

// Assert the SQL boundary, rather than using a Map fake that already dedupes.
function recordingSql(insertError?: Error) {
  const queries: { statement: string; values: unknown[] }[] = [];
  const tx = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => {
    const statement = parts.join("?").replace(/\s+/g, " ").trim();
    queries.push({ statement, values });
    if (statement.startsWith("insert") && insertError) throw insertError;
    return [];
  });
  const pool = vi.fn(() => { throw new Error("terminal queries must use the transaction"); });
  const begin = vi.fn(async (_options: string, fn: (client: typeof tx) => Promise<void>) => fn(tx));
  return { sql: Object.assign(pool, { begin }) as unknown as Sql, queries, begin, pool };
}

describe("terminal failure SQL contract", () => {
  it("locks one dispatch, conditionally inserts, then deletes in a READ COMMITTED transaction", async () => {
    const { sql, queries, begin, pool } = recordingSql();
    const id = randomUUID();
    await pgQueueLedger(sql).failed(id, "sync-event", "sync-event:e1", "x".repeat(2100));
    expect(begin).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledWith("isolation level read committed", expect.any(Function));
    expect(pool).not.toHaveBeenCalled();
    expect(queries).toEqual([
      {
        statement: "select pg_advisory_xact_lock(hashtextextended('queue-failed:' || ?::uuid::text, 0))",
        values: [id],
      },
      {
        statement: "insert into queue_failed_jobs (job_id, kind, key, reason) select ?::uuid, ?, ?, ? where not exists (select 1 from queue_failed_jobs where job_id = ?::uuid)",
        values: [id, "sync-event", "sync-event:e1", "x".repeat(2000), id],
      },
      { statement: "delete from queue_jobs where job_id = ?::uuid", values: [id] },
    ]);
  });

  it("does not delete or swallow a failed insertion", async () => {
    const error = new Error("insert failed");
    const { sql, queries } = recordingSql(error);
    await expect(pgQueueLedger(sql).failed(randomUUID(), "announcement", null, "failed")).rejects.toBe(error);
    expect(queries).toHaveLength(2);
    expect(queries[0]!.statement).toMatch(/^select pg_advisory_xact_lock/);
    expect(queries[1]!.statement).toMatch(/^insert/);
  });
});

// The fixture refuses non-test targets before connecting and applies canonical
// migrations in a disposable schema. Multiple connections exercise real races.
describe.skipIf(!process.env.DATABASE_URL).each([
  { schema: "before the unique migration", migrated: false },
  { schema: "after the unique migration", migrated: true },
])("terminal redelivery on PostgreSQL $schema", ({ migrated }) => {
  let fixture: JobsFixture | undefined;
  let sql: Sql;
  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 6 });
    sql = fixture.client;
    if (!migrated) await sql`alter table queue_failed_jobs drop constraint queue_failed_jobs_job_id_unique`;
  });
  beforeEach(async () => {
    await sql`truncate queue_jobs, queue_failed_jobs restart identity`;
  });
  afterAll(async () => {
    await fixture?.dispose();
  });

  const enqueue = async (id: string, key: string | null = "sync-event:e1") => {
    const ledger = pgQueueLedger(sql);
    await ledger.enqueued({ jobId: id, kind: "sync-event", key, availableAt: new Date(Date.now() - 1000) });
    return ledger;
  };
  const failures = () => sql`select id, job_id, kind, key, reason, failed_at from queue_failed_jobs order by id`;
  const emptyLiveDepth = { pending: 0, delayed: 0, reserved: 0, total: 0, oldestPendingAgeSeconds: null };

  it("keeps the first outcome across sequential redelivery after the live row is gone", async () => {
    const id = randomUUID();
    const ledger = await enqueue(id);
    await ledger.reserved(id);
    await ledger.failed(id, "sync-event", "sync-event:e1", "first terminal outcome");
    const original = await failures();
    expect(original).toHaveLength(1);
    await ledger.failed(id, "announcement", null, "changed redelivery reason");
    await ledger.failed(id, "sync-event", "sync-event:e1", "third delivery");
    expect(await failures()).toEqual(original);
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
  });

  it("records one outcome and retires the live row under concurrent terminal deliveries", async () => {
    const id = randomUUID();
    const ledger = await enqueue(id);
    await ledger.reserved(id);
    const reasons = Array.from({ length: 12 }, (_, i) => `terminal delivery ${i}`);
    await Promise.all(reasons.map((reason, i) => ledger.failed(i % 2 ? id.toUpperCase() : id, "sync-event", "sync-event:e1", reason)));
    const rows = await failures();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ job_id: id, kind: "sync-event", key: "sync-event:e1" });
    expect(reasons).toContain(rows[0]!.reason);
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
  });

  it("counts two independent dispatches for the same event as two failures", async () => {
    const first = randomUUID(), second = randomUUID();
    const ledger = await enqueue(first);
    await enqueue(second);
    await Promise.all([first, second, first, second].map((id) => ledger.failed(id, "sync-event", "sync-event:e1", "terminal")));
    const rows = await failures();
    expect(rows.map((row) => row.job_id).sort()).toEqual([first, second].sort());
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 2 });
  });

  it("still retires a surviving live row on a conflict without overwriting failure evidence", async () => {
    const id = randomUUID();
    await sql`insert into queue_failed_jobs (job_id, kind, key, reason) values (${id}::uuid, 'sync-event', null, 'original')`;
    const original = await failures();
    const ledger = await enqueue(id);
    await ledger.failed(id, "sync-event", "sync-event:e1", "redelivery");
    expect(await failures()).toEqual(original);
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
  });

  it("preserves the live row and its retry accounting when insertion fails", async () => {
    const id = randomUUID();
    const ledger = await enqueue(id);
    await ledger.reserved(id);
    const live = await sql`select * from queue_jobs where job_id = ${id}::uuid`;
    await sql`alter table queue_failed_jobs add constraint test_reject_failure check (reason <> 'reject')`;
    try {
      await expect(ledger.failed(id, "sync-event", "sync-event:e1", "reject")).rejects.toMatchObject({ code: "23514" });
      expect(await sql`select * from queue_jobs where job_id = ${id}::uuid`).toEqual(live);
      expect(await failures()).toHaveLength(0);
      expect(await pgQueueDepth(sql)).toMatchObject({ total: 1, reserved: 1, failed: 0 });
    } finally {
      await sql`alter table queue_failed_jobs drop constraint test_reject_failure`;
    }
    // Normal retry transitions still work after rollback, followed by terminal settlement.
    await ledger.released(id, new Date(Date.now() + 60_000));
    expect(await pgQueueDepth(sql)).toMatchObject({ pending: 0, delayed: 1, reserved: 0, total: 1 });
    await ledger.failed(id, "sync-event", "sync-event:e1", "accepted");
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
  });

  it("rolls back the inserted failure if deleting the live row fails", async () => {
    const id = randomUUID();
    const ledger = await enqueue(id);
    await sql.unsafe(`create function test_reject_delete() returns trigger language plpgsql as $$
      begin raise exception 'fixture refuses live deletion'; end $$`);
    await sql`create trigger test_reject_delete before delete on queue_jobs for each row execute function test_reject_delete()`;
    try {
      await expect(ledger.failed(id, "sync-event", "sync-event:e1", "terminal")).rejects.toMatchObject({ code: "P0001" });
      expect(await failures()).toHaveLength(0);
      expect(await pgQueueDepth(sql)).toMatchObject({ total: 1, pending: 1, failed: 0 });
    } finally {
      await sql`drop trigger test_reject_delete on queue_jobs`;
      await sql`drop function test_reject_delete()`;
    }
    await ledger.failed(id, "sync-event", "sync-event:e1", "redelivery after rollback");
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
  });

  it("acknowledges a terminal consumer delivery with one durable failure across redelivery", async () => {
    const id = randomUUID();
    const ledger = pgQueueLedger(sql);
    await ledger.enqueued({ jobId: id, kind: "announcement", key: null, availableAt: new Date(Date.now() - 1000) });
    const bot = { postAnnouncement: async () => { throw new BotTerminalError("synthetic terminal failure"); } } as unknown as BotClient;
    const deps = { bot, events: {} as EventStore, lock: {} as UniqueLock, ledger };
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      let original;
      for (let delivery = 0; delivery < 2; delivery++) {
        const message = {
          body: { kind: "announcement", idempotencyKey: "fixture", jobId: id, action: { channelKey: "fixture", body: "synthetic" } },
          attempts: 1, ack: vi.fn(), retry: vi.fn(),
        };
        await consume({ messages: [message] }, deps);
        expect(message.ack).toHaveBeenCalledOnce();
        expect(message.retry).not.toHaveBeenCalled();
        const rows = await failures();
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ job_id: id, kind: "announcement", key: null });
        if (delivery === 0) original = rows;
        else expect(rows).toEqual(original);
        expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 1 });
      }
      expect(warnings).not.toHaveBeenCalled();
    } finally {
      warnings.mockRestore();
      errors.mockRestore();
    }
  });

  it("upgrades historical duplicates, preserving the first row and same-key dispatches", async () => {
    // Only our disposable schema is modified. Run the actual migration SQL,
    // including its table lock, on a pre-constraint fixture with duplicate history.
    await sql`alter table queue_failed_jobs drop constraint if exists queue_failed_jobs_job_id_unique`;
    const first = randomUUID(), second = randomUUID();
    await sql`insert into queue_failed_jobs (job_id, kind, key, reason) values
      (${first}::uuid, 'sync-event', 'sync-event:e1', 'first outcome'),
      (${first}::uuid, 'sync-event', 'sync-event:e1', 'duplicate outcome'),
      (${second}::uuid, 'sync-event', 'sync-event:e1', 'independent outcome')`;
    const original = (await failures()).filter((row) => row.reason !== "duplicate outcome");
    const migration = await readFile(fileURLToPath(new URL("../drizzle/1015_queue_failed_job_identity.sql", import.meta.url).href), "utf8");
    await sql.begin(async (tx) => {
      for (const statement of migration.split("--> statement-breakpoint")) {
        if (statement.trim()) await tx.unsafe(statement);
      }
    });
    expect(await failures()).toEqual(original);
    await expect(sql`insert into queue_failed_jobs (job_id, kind, key, reason)
      values (${first}::uuid, 'sync-event', null, 'duplicate')`).rejects.toMatchObject({ code: "23505" });
    await pgQueueLedger(sql).failed(first, "sync-event", "sync-event:e1", "redelivery after upgrade");
    expect(await failures()).toEqual(original);
    expect(await pgQueueDepth(sql)).toEqual({ ...emptyLiveDepth, failed: 2 });
  });
});
