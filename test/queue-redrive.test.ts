import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { trackingQueue } from "../src/jobs/ledger";
import { pgQueueDepth, pgQueueLedger } from "../src/jobs/postgres";
import { discardFailedJob, listFailedJobs } from "../src/jobs/redrive";
import { createLedgerFixture } from "./helpers/queue-ledger-fixture";

// TOG-11707: proves the inspect-list-redrive loop over `queue_failed_jobs`
// against real SQL — list/retry-once/discard transitions an operator runs
// through docs/queue-redrive-runbook.md. Real Postgres in an isolated schema,
// never the caller's tables; skipped when DATABASE_URL is unset.
describe.skipIf(!process.env.DATABASE_URL)("queue redrive: list / retry-once / discard", () => {
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

  it("lists failed rows newest-first, with a kind filter and a bounded limit", async () => {
    const ledger = pgQueueLedger(sql);
    const first = crypto.randomUUID(), second = crypto.randomUUID();
    await ledger.enqueued({ jobId: first, kind: "sync-event", key: "sync-event:e1", availableAt: new Date(Date.now() - 1000) });
    await ledger.failed(first, "sync-event", "sync-event:e1", "bot down");
    await ledger.enqueued({ jobId: second, kind: "announcement", key: null, availableAt: new Date(Date.now() - 1000) });
    await ledger.failed(second, "announcement", null, "bot refused");

    const all = await listFailedJobs(sql);
    expect(all).toHaveLength(2);
    // Newest failure first: the announcement failed after the sync-event.
    expect(all[0]!.kind).toBe("announcement");
    expect(all[0]!.jobId).toBe(second);
    expect(all[0]!.key).toBeNull();
    expect(all[0]!.reason).toBe("bot refused");
    expect(all[1]!.jobId).toBe(first);
    expect(all[1]!.key).toBe("sync-event:e1");

    expect((await listFailedJobs(sql, { kind: "sync-event" })).map((r) => r.jobId)).toEqual([first]);
    expect(await listFailedJobs(sql, { limit: 1 })).toHaveLength(1);
    expect(await listFailedJobs(sql, { kind: "role-assign" })).toHaveLength(0);
  });

  it("retry-once mints a fresh live row and leaves the dead letter untouched", async () => {
    const ledger = pgQueueLedger(sql);
    const failedId = crypto.randomUUID();
    await ledger.enqueued({ jobId: failedId, kind: "sync-event", key: "sync-event:e9", availableAt: new Date(Date.now() - 1000) });
    await ledger.failed(failedId, "sync-event", "sync-event:e9", "transport error");

    // The redrive re-dispatches from the original authorized source through
    // the producer path — a new jobId, never the dead row moved back.
    const sent: unknown[] = [];
    const queue = trackingQueue({ send: async (body) => { sent.push(body); } }, pgQueueLedger(sql));
    await queue.send({ kind: "sync-event", eventKey: "e9", idempotencyKey: "redrive-e9" });

    expect(sent).toHaveLength(1);
    const live = (await sql`select job_id, kind, key from queue_jobs`).map((r) => r as { job_id: unknown; kind: string; key: string });
    expect(live).toHaveLength(1);
    // Fresh identity: the live row is not the dead row resurrected.
    expect(String(live[0]!.job_id)).not.toBe(failedId);
    expect(live[0]!.kind).toBe("sync-event");
    // The dead letter stays as evidence until a confirmed recovery discards it.
    const dead = await listFailedJobs(sql);
    expect(dead.map((r) => r.jobId)).toEqual([failedId]);
    const depth = await pgQueueDepth(sql);
    expect(depth.total).toBe(1);
    expect(depth.failed).toBe(1);
  });

  it("discard removes exactly one row and ignores unknown ids", async () => {
    const ledger = pgQueueLedger(sql);
    const keep = crypto.randomUUID(), drop = crypto.randomUUID();
    await ledger.enqueued({ jobId: keep, kind: "sync-event", key: "sync-event:k", availableAt: new Date(Date.now() - 1000) });
    await ledger.failed(keep, "sync-event", "sync-event:k", "recovered elsewhere");
    await ledger.enqueued({ jobId: drop, kind: "announcement", key: null, availableAt: new Date(Date.now() - 1000) });
    await ledger.failed(drop, "announcement", null, "poison payload");

    const [dropRow] = await sql`select id from queue_failed_jobs where job_id = ${drop}::uuid`;
    expect(await discardFailedJob(sql, Number((dropRow as { id: unknown }).id))).toBe(true);
    const remaining = await listFailedJobs(sql);
    expect(remaining.map((r) => r.jobId)).toEqual([keep]);

    expect(await discardFailedJob(sql, 2_147_483_647)).toBe(false);
    expect(await listFailedJobs(sql)).toHaveLength(1);
    expect((await pgQueueDepth(sql)).failed).toBe(1);
  });
});
