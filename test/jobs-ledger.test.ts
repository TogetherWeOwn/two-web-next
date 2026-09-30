import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";

// Real Postgres (agent-testdb locally, a service container in CI). Skipped when DATABASE_URL is unset.
// N3 (TOG-9895): proves the ledger's bucket semantics are the legacy `jobs`/`failed_jobs`
// ones that GET /up counts — pending/delayed/reserved/total/failed/oldest-pending-age.
describe.skipIf(!process.env.DATABASE_URL)("postgres queue ledger + depth", () => {
  const sql = postgres(process.env.DATABASE_URL!, { max: 4 });
  beforeAll(async () => {
    // Fresh shape per run: one row per accepted jobId (no key-unique — a
    // retry delay outlives the uniqueness window, so a second live dispatch
    // of the same key must not clobber the first row).
    await sql`drop table if exists queue_jobs`;
    await sql`create table queue_jobs (
      job_id uuid primary key,
      kind text not null,
      key text,
      available_at timestamptz not null,
      reserved_at timestamptz,
      created_at timestamptz not null default now()
    )`;
    await sql`create table if not exists queue_failed_jobs (
      id bigserial primary key,
      job_id uuid not null,
      kind text not null,
      key text,
      reason text not null,
      failed_at timestamptz not null default now()
    )`;
    await sql`delete from queue_jobs`;
    await sql`delete from queue_failed_jobs`;
  });
  afterAll(async () => {
    await sql`delete from queue_jobs`;
    await sql`delete from queue_failed_jobs`;
    await sql.end({ timeout: 1 });
  });

  it("counts the buckets exactly as QueueHealth::measure did", async () => {
    const ledger = pgQueueLedger(sql);
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 60_000);

    // 2 pending (available, unclaimed), 1 delayed (future), 1 reserved, 1 failed.
    const p1 = crypto.randomUUID(), p2 = crypto.randomUUID();
    const d1 = crypto.randomUUID(), r1 = crypto.randomUUID(), f1 = crypto.randomUUID();
    await ledger.enqueued({ jobId: p1, kind: "sync-event", key: "sync-event:p1", availableAt: past });
    await ledger.enqueued({ jobId: p2, kind: "sync-event", key: "sync-event:p2", availableAt: past });
    await ledger.enqueued({ jobId: d1, kind: "sync-event", key: "sync-event:d1", availableAt: future });
    await ledger.enqueued({ jobId: r1, kind: "sync-event", key: "sync-event:r1", availableAt: past });
    await ledger.reserved(r1);
    await ledger.enqueued({ jobId: f1, kind: "announcement", key: null, availableAt: past });
    await ledger.failed(f1, "announcement", null, "gave up after 5 attempts");

    const depth = await pgQueueDepth(sql);
    expect(depth).toEqual({
      pending: 2,
      delayed: 1,
      reserved: 1,
      total: 4,
      failed: 1,
      oldestPendingAgeSeconds: expect.any(Number),
    });
    expect(depth.oldestPendingAgeSeconds!).toBeGreaterThanOrEqual(0);
    expect(depth.oldestPendingAgeSeconds!).toBeLessThan(60);
  });

  it("released moves a reserved row back to the right availability bucket", async () => {
    await sql`delete from queue_jobs`;
    const ledger = pgQueueLedger(sql);
    const id = crypto.randomUUID();
    await ledger.enqueued({ jobId: id, kind: "sync-event", key: `sync-event:${id}`, availableAt: new Date(Date.now() - 1000) });
    await ledger.reserved(id);
    const future = new Date(Date.now() + 300_000);
    await ledger.released(id, future);
    const depth = await pgQueueDepth(sql);
    expect(depth.pending).toBe(0);
    expect(depth.delayed).toBe(1);
    expect(depth.reserved).toBe(0);
    await ledger.dequeued(id);
    expect((await pgQueueDepth(sql)).total).toBe(0);
  });

  it("two live dispatches of the same key keep one row each", async () => {
    // A retry delay (up to 3600s) outlives the 300s uniqueness lock, so a
    // second dispatch can land while the first message is still live
    // (delayed or reserved). Each accepted message gets its own row: the
    // earlier message's transitions must keep matching afterwards.
    await sql`delete from queue_jobs`;
    const ledger = pgQueueLedger(sql);
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    await ledger.enqueued({ jobId: first, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    await ledger.enqueued({ jobId: second, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() + 3_600_000) });
    const depth = await pgQueueDepth(sql);
    expect(depth.pending).toBe(1);
    expect(depth.delayed).toBe(1);
    expect(depth.total).toBe(2);
    // The first row still tracks the first message: completing the second must
    // not disturb it, and completing the first removes exactly its row.
    await ledger.dequeued(second);
    expect((await pgQueueDepth(sql)).total).toBe(1);
    await ledger.dequeued(first);
    expect((await pgQueueDepth(sql)).total).toBe(0);
  });

  it("a second dispatch keeps a reserved first row", async () => {
    await sql`delete from queue_jobs`;
    const ledger = pgQueueLedger(sql);
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    await ledger.enqueued({ jobId: first, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    await ledger.reserved(first);
    await ledger.enqueued({ jobId: second, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    const depth = await pgQueueDepth(sql);
    expect(depth.total).toBe(2);
    expect(depth.reserved).toBe(1);
    // Reserved rows survive the orphan sweep: the first row is still reserved.
    const rows = await sql`select job_id from queue_jobs`;
    expect(rows.map((r) => String((r as { job_id: unknown }).job_id)).sort()).toEqual([first, second].sort());
  });

  it("a stale same-key orphan is swept by the next dispatch, a fresh row is not", async () => {
    await sql`delete from queue_jobs`;
    const ledger = pgQueueLedger(sql);
    const orphan = crypto.randomUUID();
    // Orphaned by a post-insert send failure hours ago: unreserved, long available.
    await ledger.enqueued({
      jobId: orphan, kind: "sync-event", key: "sync-event:e1",
      availableAt: new Date(Date.now() - 2 * 3600_000),
    });
    const next = crypto.randomUUID();
    await ledger.enqueued({ jobId: next, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    expect((await pgQueueDepth(sql)).total).toBe(1);
    const rows = await sql`select job_id from queue_jobs`;
    expect(String((rows[0] as { job_id: unknown }).job_id)).toBe(next);

    // A recent same-key row is not an orphan: it survives the next dispatch.
    const fresh = crypto.randomUUID(), third = crypto.randomUUID();
    await sql`delete from queue_jobs`;
    await ledger.enqueued({ jobId: fresh, kind: "sync-event", key: "sync-event:e2", availableAt: new Date(Date.now() - 1000) });
    await ledger.enqueued({ jobId: third, kind: "sync-event", key: "sync-event:e2", availableAt: new Date(Date.now() - 1000) });
    expect((await pgQueueDepth(sql)).total).toBe(2);
  });

  it("empty ledger reports zeros and a null oldest age", async () => {
    await sql`delete from queue_jobs`;
    const depth = await pgQueueDepth(sql);
    expect(depth.pending).toBe(0);
    expect(depth.delayed).toBe(0);
    expect(depth.reserved).toBe(0);
    expect(depth.total).toBe(0);
    expect(depth.failed).toBe(1); // the failure recorded above accumulates, like legacy failed_jobs
    expect(depth.oldestPendingAgeSeconds).toBeNull();
  });
});
