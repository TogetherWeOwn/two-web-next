// Reconcile orchestration through the REAL pg store (TOG-12107).
//
// Ledger `docs/w15-events-acceptance-ledger.md:120` (`ReconcileEventsCommandTest`):
// `test/jobs.test.ts` proves close-before-resync ordering with fakes, and
// `test/event-store-pg.test.ts` proves each adapter method in isolation. This
// suite closes the remaining gap: one `reconcileEvents` pass against the real
// `pgEventStore` on real Postgres (agent-testdb / CI service), proving the
// close-before-resync EFFECT order through the store itself — a finished row
// that is stale-eligible at pass start is closed first and therefore never
// re-dispatched in the same pass (a stale-before-close order would resend it).
//
// Runs against the adapter directly, not through `src/jobs/worker.ts`
// (PR #68 hot, do not rewire). Test-only: no src changes.
// The first pass additionally runs the prepare phase inside a `sql.begin`
// write transaction (the production shape in `src/jobs/worker.ts`) and
// asserts the pre-pass `staleEventKeys` selection directly.
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { toQueueMessage } from "../src/jobs/envelope";
import { reconcileEventSync } from "../src/jobs/event-reconciliation";
import { pgEventStore } from "../src/jobs/events";
import {
  pgReconciliationStore,
  SYNC_RECONCILIATION_MARKER,
  type ReconciliationIntent,
} from "../src/jobs/reconciliation";
import { reconcileFailedJob } from "../src/jobs/replay";
import { handleSyncEvent } from "../src/jobs/sync-event";
import type { BotClient, UniqueLock } from "../src/jobs/types";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

const LEASE = "11111111-1111-4111-8111-111111111111";

function memLock(): UniqueLock {
  const held = new Set<string>();
  return {
    acquire: async (k) => (held.has(k) ? null : (held.add(k), LEASE)),
    release: async (k, token) => {
      if (token === LEASE) held.delete(k);
    },
  };
}

describe.skipIf(!process.env.DATABASE_URL)(
  "reconcile against the real pg store (agent-testdb)",
  () => {
    let fixture: JobsFixture | undefined;
    let sql: postgres.Sql;

    beforeAll(async () => {
      fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
      sql = fixture.client;
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await sql`delete from rsvps`;
      await sql`delete from activity_log`;
      await sql`delete from events`;
    });

    const NOW = new Date("2026-10-01T12:00:00Z");
    let seq = 0;
    const key = (tag: string) => `test-reconcile-${tag}-${Date.now()}-${seq++}`;

    type EventSeed = {
      tag: string;
      status?: string;
      endsAt?: Date;
      discordEventId?: string | null;
    };
    async function seedEvent(s: EventSeed): Promise<{ id: number; eventKey: string }> {
      const eventKey = key(s.tag);
      const [row] = (await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      values (${eventKey}, ${`event ${s.tag}`},
        ${new Date("2026-10-01T10:00:00Z")}, ${s.endsAt ?? new Date("2026-10-01T14:00:00Z")},
        'Europe/London', 'hall', ${s.status ?? "published"}, ${s.discordEventId ?? null},
        null, null, null, null)
      returning id`) as { id: number }[];
      return { id: row!.id, eventKey };
    }
    async function seedRsvp(eventId: number, userId: string): Promise<void> {
      const at = new Date("2026-09-30T12:00:00Z");
      await sql`insert into rsvps (event_id, user_id, status, created_at, updated_at)
      values (${eventId}, ${userId}, 'going', ${at}, ${at})`;
    }
    // Mark the event fully mirrored: RSVPs stamped and the sync outbox acknowledged
    // (rsvp inserts and status changes advance sync_revision, so ack after seeding).
    async function markClean(eventId: number): Promise<void> {
      await sql`update rsvps set synced_to_discord_at = ${NOW} where event_id = ${eventId}`;
      await sql`update events set synced_revision = sync_revision where id = ${eventId}`;
    }
    const statuses = async (): Promise<Record<string, string>> =>
      Object.fromEntries(
        (
          (await sql`select event_key, status from events`) as {
            event_key: string;
            status: string;
          }[]
        ).map((r) => [r.event_key, r.status]),
      );

    it("closes finished, preserves running/cancelled/draft, resends only stale — close before resync", async () => {
      const pastEnd = new Date("2026-10-01T11:00:00Z");
      const futureEnd = new Date("2026-10-01T13:00:00Z");
      // Finished but stale-eligible at pass start: close must win, no resend.
      const finishedStale = await seedEvent({ tag: "finished-stale", endsAt: pastEnd });
      const finishedMirrored = await seedEvent({
        tag: "finished-mirrored",
        endsAt: pastEnd,
        discordEventId: "discord-done",
      });
      await seedRsvp(finishedMirrored.id, "u-done");
      await markClean(finishedMirrored.id);
      const runningStale = await seedEvent({ tag: "running-stale", endsAt: futureEnd });
      const runningMirrored = await seedEvent({
        tag: "running-mirrored",
        endsAt: futureEnd,
        discordEventId: "discord-full",
      });
      await seedRsvp(runningMirrored.id, "u-full");
      await markClean(runningMirrored.id);
      const halfSynced = await seedEvent({
        tag: "half",
        endsAt: futureEnd,
        discordEventId: "discord-half",
      });
      await seedRsvp(halfSynced.id, "u-half");
      // Revision acknowledged but the answer is unstamped: stale via the RSVP backstop.
      await sql`update events set synced_revision = sync_revision where id = ${halfSynced.id}`;
      // Cancelled rows are never closed; only the dirty one still owes a cancel mirror.
      const cancelled = await seedEvent({
        tag: "cancelled",
        status: "cancelled",
        endsAt: pastEnd,
        discordEventId: "discord-cancelled",
      });
      await markClean(cancelled.id);
      const cancelledDirty = await seedEvent({
        tag: "cancelled-dirty",
        status: "cancelled",
        endsAt: pastEnd,
        discordEventId: "discord-cancel-owed",
      });
      const draft = await seedEvent({ tag: "draft", status: "draft", endsAt: pastEnd });
      const past = await seedEvent({ tag: "past", status: "past", endsAt: pastEnd });

      const sent: { eventKey: string }[] = [];
      const queue = { send: async (b: unknown) => void sent.push(b as { eventKey: string }) };
      // Direct adapter selection before the pass: both finished rows are still
      // published, so the finished-but-dirty row is stale-eligible here. The
      // already-mirrored rows (running-mirrored, clean cancelled, draft, past,
      // finished-mirrored) are skipped by staleEventKeys itself, not just by dispatch.
      // Unpaged selection keeps the legacy array shape: every stale key, ordered.
      const preStale = ((await pgEventStore(sql).staleEventKeys()) as string[]).sort();
      expect(preStale).toEqual(
        [
          finishedStale.eventKey,
          runningStale.eventKey,
          halfSynced.eventKey,
          cancelledDirty.eventKey,
        ].sort(),
      );
      // Production path (src/jobs/worker.ts): the prepare phase runs inside the
      // scheduler's write transaction so close is visible to the stale selection.
      const r = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
        writeTransaction: (work) => sql.begin(async (tx) => work(pgEventStore(tx as never))),
      });

      expect(r).toEqual({
        closed: 2,
        materialized: 0,
        resynced: 3,
        absorbed: 0,
        failed: 0,
        deferred: 0,
      });
      expect(await statuses()).toMatchObject({
        [finishedStale.eventKey]: "past",
        [finishedMirrored.eventKey]: "past",
        [runningStale.eventKey]: "published",
        [runningMirrored.eventKey]: "published",
        [halfSynced.eventKey]: "published",
        [cancelled.eventKey]: "cancelled",
        [cancelledDirty.eventKey]: "cancelled",
        [draft.eventKey]: "draft",
        [past.eventKey]: "past",
      });
      // Only stale rows are dispatched (selection order is unspecified); the just-closed
      // finished row is NOT re-dispatched: close ran before the stale selection, through the
      // real store. Mirrored-clean and clean-cancelled rows are skipped.
      const stale = [runningStale.eventKey, halfSynced.eventKey, cancelledDirty.eventKey].sort();
      expect(sent.map((b) => b.eventKey).sort()).toEqual(stale);

      // Second pass: close is idempotent, stale rows re-dispatch (dispatch never mirrors).
      sent.length = 0;
      const again = await reconcileEvents({
        events: pgEventStore(sql),
        queue,
        lock: memLock(),
        now: () => NOW,
      });
      expect(again).toEqual({
        closed: 0,
        materialized: 0,
        resynced: 3,
        absorbed: 0,
        failed: 0,
        deferred: 0,
      });
      expect(sent.map((b) => b.eventKey).sort()).toEqual(stale);
    });

    it("replays in-progress requests with the original snapshot and caps sends across carriers", async () => {
      const { id, eventKey } = await seedEvent({
        tag: "in-progress",
        endsAt: new Date("2026-10-02T14:00:00Z"),
      });
      const events = pgEventStore(sql);
      const idempotencyKey = crypto.randomUUID();
      const upsertEvent = vi.fn<BotClient["upsertEvent"]>().mockResolvedValue({
        ok: false,
        code: "in_progress",
        status: 409,
        requestId: null,
        message: "Synthetic operation in progress",
        retryable: true,
        retryAfterSeconds: null,
      });
      const unexpectedBotCall = async () => {
        throw new Error("Unexpected bot action in the upsert replay fixture");
      };
      const bot: BotClient = {
        upsertEvent,
        cancelEvent: unexpectedBotCall,
        postAnnouncement: unexpectedBotCall,
        assignRole: unexpectedBotCall,
      };
      let now = NOW;
      const deps = { events, now: () => now, bot };
      const failed = { kind: "sync-event", key: `sync-event:${eventKey}` };
      const replay = () =>
        reconcileFailedJob({ ...events, hasFailedSync: events.hasFailedSync! }, failed, deps.now);
      const queue = { send: vi.fn(async (_body: unknown) => {}) };
      // Model recovery after the previous carrier released its lease.
      const reconcile = () => reconcileEvents({ ...deps, queue, lock: memLock() });

      expect(await handleSyncEvent({ eventKey, idempotencyKey }, 1, deps)).toEqual({
        retryInSeconds: 10,
      });
      const [originalPayload] = upsertEvent.mock.calls[0]!;
      expect(originalPayload.name).toBe("event in-progress");
      await sql`update events set title = 'Newer revision' where id = ${id}`;
      expect(await reconcile()).toMatchObject({ resynced: 0 });
      expect(queue.send).not.toHaveBeenCalled();
      expect(await replay()).toMatchObject({ action: "keep", eventKey });

      for (const [index, delay] of [10, 60, 300, 900, 3600].entries()) {
        now = new Date(now.getTime() + delay * 1000);
        expect(await replay()).toMatchObject({ action: "replay", eventKey, idempotencyKey });
        expect(await reconcile()).toMatchObject({ resynced: 1 });
        const carrier = toQueueMessage(queue.send.mock.calls[index]?.[0]);
        if (carrier?.kind !== "sync-event") throw new Error("Missing recovery carrier");
        expect(carrier.idempotencyKey).toBe(idempotencyKey);
        // A new carrier starts at delivery one, but spends the original request's budget.
        await handleSyncEvent(carrier, 1, deps);
      }

      expect(await reconcile()).toMatchObject({ resynced: 0 });
      expect(queue.send).toHaveBeenCalledTimes(5);
      expect(await replay()).toMatchObject({ action: "keep", eventKey });
      const postCap = await handleSyncEvent({ eventKey, idempotencyKey }, 1, deps);
      expect(postCap).not.toHaveProperty("retryInSeconds");
      expect(postCap).not.toHaveProperty("definitive");
      expect(await events.pendingSync(eventKey)).toMatchObject({
        idempotencyKey,
        state: "pending",
        requestAttempts: 6,
        nextAttemptAt: null,
      });
      const exhausted = await events.pendingSync(eventKey);
      if (!exhausted) throw new Error("Missing exhausted claim");
      const store = pgReconciliationStore(sql);
      const record = async (intent: ReconciliationIntent) => {
        await store.recordSync(intent);
        return "recorded" as const;
      };
      expect(await reconcileEventSync({ ...exhausted, requestAttempts: 5 }, 6, record)).toEqual({
        retryInSeconds: 3600,
        alert: expect.stringContaining("unconfirmed"),
      });
      expect(await reconcileEventSync(exhausted, 6, record)).toHaveProperty("failed");
      expect(
        await sql`select idempotency_key, attempts, resolved_at
          from bot_reconciliation_intents where subject = ${eventKey}`,
      ).toEqual([{ idempotency_key: idempotencyKey, attempts: 6, resolved_at: null }]);
      expect(upsertEvent.mock.calls).toEqual(
        Array.from({ length: 6 }, () => [originalPayload, idempotencyKey]),
      );
    });

    it.each(["event.upsert", "event.cancel"] as const)(
      "holds an uncertain %s on the original key through late settlement and a newer revision",
      async (verb) => {
        const { id, eventKey } = await seedEvent({
          tag: "uncertain",
          status: verb === "event.cancel" ? "cancelled" : "published",
          discordEventId: "discord-original",
          endsAt: new Date("2026-10-02T14:00:00Z"),
        });
        const idempotencyKey = crypto.randomUUID();
        const otherKey = crypto.randomUUID();
        const events = pgEventStore(sql);
        const prepared = await events.prepareSync(eventKey, idempotencyKey, NOW);
        if (!prepared || "waiting" in prepared) throw new Error("Missing sync snapshot");
        const attempt = await events.claimSync(prepared, NOW);
        if (!attempt) throw new Error("Missing sync claim");
        const intent = {
          idempotencyKey,
          verb,
          subject: eventKey,
          attempts: 1,
          lastCode: "needs_reconciliation",
          lastStatus: 409,
        };
        const store = pgReconciliationStore(sql);
        // Inject the uncertain result at the existing persistence boundary.
        await expect(store.recordSync({ ...intent, idempotencyKey: otherKey })).rejects.toThrow(
          "Sync claim changed before reconciliation",
        );
        const record = async (input: ReconciliationIntent) => {
          await store.recordSync(input);
          return "recorded" as const;
        };
        const persistenceUnavailable = async () => {
          throw new Error("Synthetic worker interruption before intent commit");
        };
        expect(await reconcileEventSync(attempt, 1, persistenceUnavailable)).toEqual({
          retryInSeconds: 10,
        });
        // The replacement worker starts with only the durable, closed claim.
        const pending = await events.pendingSync(eventKey);
        if (!pending) throw new Error("Unconfirmed write lost the original claim");
        expect(pending).toMatchObject({
          idempotencyKey,
          state: "pending",
          requestAttempts: 1,
          nextAttemptAt: null,
        });
        expect(await events.prepareSync(eventKey, otherKey, NOW)).toBeNull();
        expect(
          await reconcileEventSync(pending, 2, record, {
            code: intent.lastCode,
            status: intent.lastStatus,
          }),
        ).toHaveProperty("failed");
        // A crash after commit and before carrier retirement loses the response
        // evidence, but a same-key repeat must keep the recorded diagnostics.
        expect(await reconcileEventSync(pending, 3, record)).toHaveProperty("failed");
        await sql`update events set title = 'Newer revision' where id = ${id}`;
        const later = new Date(NOW.getTime() + 3600_000);
        await events.completeSync(attempt, "discord-late");
        await events.failSync(idempotencyKey);
        await events.deferSync(attempt, later);

        const queue = { send: vi.fn(async (_body: unknown) => {}) };
        expect(
          await reconcileEvents({ events, queue, lock: memLock(), now: () => later }),
        ).toMatchObject({ resynced: 0 });
        expect(queue.send).not.toHaveBeenCalled();
        const failed = { kind: "sync-event", key: `sync-event:${eventKey}` };
        expect(
          await reconcileFailedJob(
            { ...events, hasFailedSync: events.hasFailedSync! },
            failed,
            () => later,
          ),
        ).toMatchObject({
          action: "keep",
          eventKey,
          reason: expect.stringContaining("claim unsettled"),
        });
        expect(await events.prepareSync(eventKey, otherKey, later)).toBeNull();
        expect(
          await sql`select idempotency_key, state, request_attempts, next_attempt_at, terminal_reason
          from event_sync_attempts where event_id = ${id}`,
        ).toEqual([
          {
            idempotency_key: idempotencyKey,
            state: "pending",
            request_attempts: 1,
            next_attempt_at: null,
            terminal_reason: SYNC_RECONCILIATION_MARKER,
          },
        ]);
        expect(
          await sql`select idempotency_key, verb, attempts, last_code, last_status, resolved_at
          from bot_reconciliation_intents where subject = ${eventKey}`,
        ).toEqual([
          {
            idempotency_key: idempotencyKey,
            verb,
            attempts: 1,
            last_code: "needs_reconciliation",
            last_status: 409,
            resolved_at: null,
          },
        ]);
        expect(
          await sql`select discord_event_id, synced_revision = 0 as unacknowledged,
            sync_revision > ${attempt.revision} as revision_advanced
          from events where id = ${id}`,
        ).toEqual([
          { discord_event_id: "discord-original", unacknowledged: true, revision_advanced: true },
        ]);
      },
    );
  },
);
