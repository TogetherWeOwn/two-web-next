// Reconciliation store through REAL Postgres (contract v2 §7.4/§11).
//
// First-writer-wins insert-or-touch keyed by the carrier UUID, bounded
// list reads, stamp-never-delete resolution. Runs against
// `pgReconciliationStore` on the disposable test database (agent-testdb /
// CI service), never production or staging.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgReconciliationStore, stuckIntent } from "../src/jobs/reconciliation";
import type { ReconciliationStore } from "../src/jobs/reconciliation";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const KEY_A = "11111111-1111-4111-8111-111111111111";
const KEY_B = "22222222-2222-4222-8222-222222222222";
const KEY_C = "33333333-3333-4333-8333-333333333333";

const intentFor = (key: string, verb = "announcement.post", subject = "channel-synthetic") =>
  stuckIntent({
    idempotencyKey: key,
    verb,
    subject,
    lastCode: "needs_reconciliation",
    lastStatus: 409,
    lastRequestId: "req-1",
    attempts: 2,
  });

describe.skipIf(!process.env.DATABASE_URL)("reconciliation pg store", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;
  let store: ReconciliationStore;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 1 });
    sql = fixture.client;
    store = pgReconciliationStore(sql);
  });
  afterAll(async () => {
    await fixture?.dispose();
  });
  beforeEach(async () => {
    await sql`delete from bot_reconciliation_intents`;
  });

  it("records and reads back a stuck intent with queue bookkeeping", async () => {
    const at = new Date("2026-10-01T12:00:00Z");
    const record = await store.recordStuck(intentFor(KEY_A), at);
    expect(record).toMatchObject({
      idempotencyKey: KEY_A,
      verb: "announcement.post",
      subject: "channel-synthetic",
      lastCode: "needs_reconciliation",
      lastStatus: 409,
      lastRequestId: "req-1",
      resolvedAt: null,
      resolvedBy: null,
      resolution: null,
    });
    expect(record.firstSeenAt).toEqual(at);
    expect(record.lastAttemptAt).toEqual(at);
    expect(await store.getStuck(KEY_A)).toEqual(record);
  });

  it("insert-or-touch keeps the first writer and refreshes the last outcome", async () => {
    const first = new Date("2026-10-01T12:00:00Z");
    const later = new Date("2026-10-01T13:00:00Z");
    await store.recordStuck(intentFor(KEY_A), first);
    const touched = await store.recordStuck(
      stuckIntent({
        ...intentFor(KEY_A),
        lastCode: "upstream_timeout",
        lastStatus: 504,
        attempts: 5,
      }),
      later,
    );
    expect(touched.firstSeenAt).toEqual(first);
    expect(touched.lastAttemptAt).toEqual(later);
    expect(touched.lastCode).toBe("upstream_timeout");
    expect(touched.attempts).toBe(5);
    expect((await store.listOpen(10)).map((r) => r.idempotencyKey)).toEqual([KEY_A]);
  });

  it("lists open oldest-first and resolved newest-first, bounded", async () => {
    await store.recordStuck(intentFor(KEY_A), new Date("2026-10-01T12:00:00Z"));
    await store.recordStuck(
      intentFor(KEY_B, "event.upsert", "evt-synthetic"),
      new Date("2026-10-01T13:00:00Z"),
    );
    await store.resolveStuck(KEY_A, { by: "mod-1", note: "checked Discord; already posted" });
    expect((await store.listOpen(10)).map((r) => r.idempotencyKey)).toEqual([KEY_B]);
    expect((await store.listResolved(10)).map((r) => r.idempotencyKey)).toEqual([KEY_A]);
    expect(await store.listOpen(0)).toEqual([]);
    expect(await store.listResolved(-1)).toEqual([]);
  });

  it("resolve stamps the row and never deletes it; unknown and repeat resolves return null", async () => {
    await store.recordStuck(intentFor(KEY_C));
    expect(
      await store.resolveStuck("44444444-4444-4444-8444-444444444444", { by: "m", note: "n" }),
    ).toBeNull();
    const resolved = await store.resolveStuck(KEY_C, { by: "mod-9", note: "re-posted by hand" });
    expect(resolved).toMatchObject({ resolvedBy: "mod-9", resolution: "re-posted by hand" });
    expect(resolved?.resolvedAt).toBeInstanceOf(Date);
    // Repeat resolve is a no-op, not a second stamp.
    expect(await store.resolveStuck(KEY_C, { by: "mod-9", note: "again" })).toBeNull();
    // The row stands as audit evidence: still readable, no longer open.
    expect((await store.getStuck(KEY_C))?.resolution).toBe("re-posted by hand");
    expect(await store.listOpen(10)).toEqual([]);
    // A late redelivery never overwrites a reconciled row.
    const kept = await store.recordStuck(intentFor(KEY_C));
    expect(kept.resolution).toBe("re-posted by hand");
    expect(kept.resolvedAt).toBeInstanceOf(Date);
  });

  it("refuses blank, over-long and non-UUID resolutions without touching the row", async () => {
    await store.recordStuck(intentFor(KEY_A));
    expect(await store.resolveStuck(KEY_A, { by: "mod-1", note: "   " })).toBeNull();
    expect(await store.resolveStuck(KEY_A, { by: "mod-1", note: "x".repeat(501) })).toBeNull();
    expect(await store.resolveStuck("not-a-uuid", { by: "mod-1", note: "note" })).toBeNull();
    expect(await store.getStuck("not-a-uuid")).toBeNull();
    expect((await store.getStuck(KEY_A))?.resolvedAt).toBeNull();
  });
});
