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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { reconcileEvents } from "../src/jobs/cron";
import { pgEventStore } from "../src/jobs/events";
import type { UniqueLock } from "../src/jobs/types";
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
      const preStale = (await pgEventStore(sql).staleEventKeys()).sort();
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

      expect(r).toEqual({ closed: 2, materialized: 0, resynced: 3 });
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
      expect(again).toEqual({ closed: 0, materialized: 0, resynced: 3 });
      expect(sent.map((b) => b.eventKey).sort()).toEqual(stale);
    });
  },
);
