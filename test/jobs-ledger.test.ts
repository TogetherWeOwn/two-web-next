import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";

// Real Postgres in an isolated schema, never the caller's tables (TOG-9895
// review: this suite used to `drop table queue_jobs` on the shared database,
// erasing live ledger history). A disposable schema owns the ledger tables;
// the fixture is dropped at the end. Skipped when DATABASE_URL is unset.
import { createLedgerFixture } from "./helpers/queue-ledger-fixture";
// N3 (TOG-9895): proves the ledger's bucket semantics are the legacy `jobs`/`failed_jobs`
// ones that GET /up counts — pending/delayed/reserved/total/failed/oldest-pending-age.
describe.skipIf(!process.env.DATABASE_URL)("postgres queue ledger + depth", () => {
  let fixture: Awaited<ReturnType<typeof createLedgerFixture>>;
  let sql: Awaited<ReturnType<typeof createLedgerFixture>>["sql"];
  beforeAll(async () => {
    fixture = await createLedgerFixture(process.env.DATABASE_URL!);
    sql = fixture.sql;
  });
  beforeEach(async () => {
    await fixture.reset();
  });
  afterAll(async () => {
    await fixture.dispose();
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
    const ledger = pgQueueLedger(sql);
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    await ledger.enqueued({ jobId: first, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    await ledger.reserved(first);
    await ledger.enqueued({ jobId: second, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    const depth = await pgQueueDepth(sql);
    expect(depth.total).toBe(2);
    expect(depth.reserved).toBe(1);
    // Both rows are still present: the insert never deletes same-key rows.
    const rows = await sql`select job_id from queue_jobs`;
    expect(rows.map((r) => String((r as { job_id: unknown }).job_id)).sort()).toEqual([first, second].sort());
  });

  it("old same-key rows are never deleted: a transport-paused backlog stays counted", async () => {
    // Regression guard for the removed age-only sweep: 20 accepted jobs older
    // than an hour are a live backlog while the transport is paused, not
    // orphans — a 21st dispatch must keep all 21 rows (TOG-9895 review proof).
    const ledger = pgQueueLedger(sql);
    for (let i = 0; i < 20; i++) {
      await ledger.enqueued({
        jobId: crypto.randomUUID(), kind: "sync-event", key: `sync-event:e${i}`,
        availableAt: new Date(Date.now() - 2 * 3600_000),
      });
    }
    const next = crypto.randomUUID();
    await ledger.enqueued({ jobId: next, kind: "sync-event", key: "sync-event:e0", availableAt: new Date(Date.now() - 1000) });
    const depth = await pgQueueDepth(sql);
    expect(depth.total).toBe(21);
    expect(depth.pending).toBe(21);

    // Same-key dispatches never disturb each other either.
    await fixture.reset();
    const fresh = crypto.randomUUID(), third = crypto.randomUUID();
    await ledger.enqueued({ jobId: fresh, kind: "sync-event", key: "sync-event:e2", availableAt: new Date(Date.now() - 1000) });
    await ledger.enqueued({ jobId: third, kind: "sync-event", key: "sync-event:e2", availableAt: new Date(Date.now() - 1000) });
    expect((await pgQueueDepth(sql)).total).toBe(2);
  });

  it("empty ledger reports zeros and a null oldest age", async () => {
    // beforeEach reset: the schema is empty, so failed is 0 here (legacy
    // failed_jobs accumulates only within one database, never across runs).
    const depth = await pgQueueDepth(sql);
    expect(depth.pending).toBe(0);
    expect(depth.delayed).toBe(0);
    expect(depth.reserved).toBe(0);
    expect(depth.total).toBe(0);
    expect(depth.failed).toBe(0);
    expect(depth.oldestPendingAgeSeconds).toBeNull();
  });
});
