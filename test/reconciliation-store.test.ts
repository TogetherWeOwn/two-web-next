// Reconciliation store through REAL Postgres (contract v2 §7.4/§11).
//
// First-writer-wins insert-or-touch keyed by the carrier UUID, bounded
// list reads, stamp-never-delete resolution. Runs against
// `pgReconciliationStore` on the disposable test database (agent-testdb /
// CI service), never production or staging.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { pgReconciliationStore, stuckIntent } from "../src/jobs/reconciliation";
import { pgEventStore } from "../src/jobs/events";
import type { ReconciliationStore } from "../src/jobs/reconciliation";
import type { TxClient } from "../src/jobs/types";
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

describe("reconciliation pg store", () => {
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

  it("resolve receipt commits with the stamp, and never exists for a lost or failed stamp", async () => {
    const receipt = async (tx: TxClient, row: { idempotencyKey: string }) => {
      await tx`insert into activity_log (log_name, description, subject_type, subject_id, event)
        values ('operations', 'bot-reconciliation.resolve', 'bot_reconciliation_intents',
          ${row.idempotencyKey}, 'resolve')`;
    };
    const receipts = async () =>
      (
        await sql`select count(*)::int as n from activity_log
        where description = 'bot-reconciliation.resolve' and subject_id = ${KEY_C}`
      )[0]!.n as number;
    await sql`delete from activity_log where description = 'bot-reconciliation.resolve'`;
    await store.recordStuck(intentFor(KEY_C));
    // A receipt that throws rolls the stamp back: row stays open, no receipt.
    await expect(
      store.resolveStuck(KEY_C, { by: "mod", note: "n" }, new Date(), async (tx, row) => {
        await receipt(tx, row);
        throw new Error("trail down");
      }),
    ).rejects.toThrow("trail down");
    expect((await store.getStuck(KEY_C))?.resolvedAt).toBeNull();
    expect(await receipts()).toBe(0);
    // The winning resolve commits stamp and receipt together.
    expect(
      await store.resolveStuck(KEY_C, { by: "mod", note: "n" }, new Date(), receipt),
    ).not.toBeNull();
    expect(await receipts()).toBe(1);
    // A later (concurrent-loser) resolve matches no open row: no second receipt.
    expect(
      await store.resolveStuck(KEY_C, { by: "mod2", note: "m" }, new Date(), receipt),
    ).toBeNull();
    expect(await receipts()).toBe(1);
    expect((await store.getStuck(KEY_C))?.resolvedBy).toBe("mod");
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

  for (const verb of ["event.upsert", "event.cancel"] as const) {
    it(`atomically fences ${verb} without retiring or re-keying its pending snapshot`, async () => {
      const eventKey = `evt-stuck-${verb}`;
      const [event] = await sql`insert into events
        (event_key, title, starts_at, ends_at, status, discord_event_id)
        values (${eventKey}, 'Synthetic', now(), now() + interval '1 hour',
          ${verb === "event.cancel" ? "cancelled" : "published"}, 'discord-synthetic') returning id`;
      const events = pgEventStore(sql);
      const prepared = await events.prepareSync(eventKey, KEY_A, new Date());
      expect(prepared && !("waiting" in prepared)).toBe(true);
      if (!prepared || "waiting" in prepared) throw new Error("missing pending snapshot");
      const claimed = await events.claimSync(prepared, new Date());
      expect(claimed?.requestAttempts).toBe(1);
      if (!claimed) throw new Error("missing claim");
      // Prove the store itself removes even previously scheduled eligibility.
      await events.deferSync(claimed, new Date(0));
      await store.recordStuck(intentFor(KEY_A, verb, eventKey));
      expect(await events.pendingSync(eventKey)).toMatchObject({
        idempotencyKey: KEY_A,
        state: "pending",
        requestAttempts: 1,
        nextAttemptAt: null,
      });
      await sql`update events set title = 'Later revision' where id = ${event!.id}`;
      expect(await events.needsSync(eventKey)).toBe(false);
      expect(await events.staleEventKeys()).not.toContain(eventKey);
      expect(await events.prepareSync(eventKey, KEY_B, new Date())).toBeNull();
      // Resolving the audit note never authorizes automatic replay of this key.
      await store.resolveStuck(KEY_A, { by: "mod", note: "checked manually" });
      expect(await events.needsSync(eventKey)).toBe(false);
      expect(
        await sql`select idempotency_key from event_sync_attempts where event_id = ${event!.id}`,
      ).toEqual([{ idempotency_key: KEY_A }]);
      await sql`delete from events where id = ${event!.id}`;
    });
  }

  it("refuses blank, over-long and non-UUID resolutions without touching the row", async () => {
    await store.recordStuck(intentFor(KEY_A));
    expect(await store.resolveStuck(KEY_A, { by: "mod-1", note: "   " })).toBeNull();
    expect(await store.resolveStuck(KEY_A, { by: "mod-1", note: "x".repeat(501) })).toBeNull();
    expect(await store.resolveStuck("not-a-uuid", { by: "mod-1", note: "note" })).toBeNull();
    expect(await store.getStuck("not-a-uuid")).toBeNull();
    expect((await store.getStuck(KEY_A))?.resolvedAt).toBeNull();
  });
});
