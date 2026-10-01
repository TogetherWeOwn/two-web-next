import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { wallToUtc } from "../src/admin/validation";
import { pgEventStore } from "../src/jobs/events";
import { createJobsFixture, type JobsFixture } from "./helpers/jobs-db";

// Real-SQL EventStore adapter proof (TOG-11660): the reconcile pass's row
// selection against real Postgres, on a disposable agent-testdb/CI schema.
// Orchestration (close-before-resync ordering) stays proved with fakes in
// test/jobs.test.ts. No worker wiring here.
describe.skipIf(!process.env.DATABASE_URL)("pg EventStore adapter", () => {
  let fixture: JobsFixture | undefined;
  let sql: postgres.Sql;

  beforeAll(async () => {
    fixture = await createJobsFixture(process.env.DATABASE_URL!, { max: 4 });
    sql = fixture.client;
  });
  afterAll(async () => { await fixture?.dispose(); });
  beforeEach(async () => {
    await sql`delete from rsvps`;
    await sql`delete from activity_log`;
    await sql`delete from events`;
  });

  const NOW = new Date("2026-10-01T12:00:00Z");
  let seq = 0;
  const key = (tag: string) => `test-${tag}-${Date.now()}-${seq++}`;

  type EventSeed = {
    tag: string;
    status?: string;
    startsAt?: Date;
    endsAt?: Date;
    discordEventId?: string | null;
    recurrenceFrequency?: string | null;
    recurrenceCount?: number | null;
    parentEventId?: number | null;
    recurrenceIndex?: number | null;
  };
  async function seedEvent(s: EventSeed): Promise<{ id: number; eventKey: string }> {
    const eventKey = key(s.tag);
    const [row] = (await sql`insert into events
        (event_key, title, starts_at, ends_at, timezone, location, status, discord_event_id,
          recurrence_frequency, recurrence_count, parent_event_id, recurrence_index)
      values (${eventKey}, ${`event ${s.tag}`},
        ${s.startsAt ?? new Date("2026-10-01T10:00:00Z")}, ${s.endsAt ?? new Date("2026-10-01T14:00:00Z")},
        'Europe/London', 'hall', ${s.status ?? "published"}, ${s.discordEventId ?? null},
        ${s.recurrenceFrequency ?? null}, ${s.recurrenceCount ?? null},
        ${s.parentEventId ?? null}, ${s.recurrenceIndex ?? null})
      returning id`) as { id: number }[];
    return { id: row!.id, eventKey };
  }
  async function seedRsvp(eventId: number, userId: string, updatedAt: Date): Promise<void> {
    await sql`insert into rsvps (event_id, user_id, status, created_at, updated_at)
      values (${eventId}, ${userId}, 'going', ${updatedAt}, ${updatedAt})`;
  }

  describe("closeFinished", () => {
    it("closes only finished published rows and returns rows changed", async () => {
      const finished = await seedEvent({ tag: "finished", endsAt: new Date("2026-10-01T11:00:00Z") });
      const boundary = await seedEvent({ tag: "boundary", endsAt: NOW });
      const running = await seedEvent({ tag: "running", endsAt: new Date("2026-10-01T13:00:00Z") });
      const cancelled = await seedEvent({
        tag: "cancelled", status: "cancelled", endsAt: new Date("2026-10-01T11:00:00Z"),
      });
      const draft = await seedEvent({ tag: "draft", status: "draft", endsAt: new Date("2026-10-01T11:00:00Z") });
      const already = await seedEvent({ tag: "past", status: "past", endsAt: new Date("2026-10-01T11:00:00Z") });
      const store = pgEventStore(sql);
      expect(await store.closeFinished(NOW)).toBe(2);
      const statuses = async () =>
        Object.fromEntries(
          ((await sql`select event_key, status from events`) as { event_key: string; status: string }[]).map(
            (r) => [r.event_key, r.status],
          ),
        );
      expect(await statuses()).toMatchObject({
        [finished.eventKey]: "past",
        [boundary.eventKey]: "past",
        [running.eventKey]: "published",
        [cancelled.eventKey]: "cancelled",
        [draft.eventKey]: "draft",
        [already.eventKey]: "past",
      });
      expect(await store.closeFinished(NOW)).toBe(0); // idempotent
    });
  });

  describe("materializeSeries", () => {
    const seriesStarts = wallToUtc("2026-10-04 20:00", "Europe/London");
    const seriesEnds = wallToUtc("2026-10-04 21:00", "Europe/London");

    async function seedParent(tag: string, status = "published") {
      const eventKey = key(tag);
      const [row] = (await sql`insert into events
          (event_key, title, starts_at, ends_at, timezone, location, status,
            recurrence_frequency, recurrence_count, recurrence_index)
        values (${eventKey}, 'Sunday Squad', ${seriesStarts}, ${seriesEnds}, 'Europe/London', 'hall',
          ${status}, 'weekly', 4, 1)
        returning id`) as { id: number }[];
      return { id: row!.id, eventKey };
    }

    it("tops up missing occurrences as drafts with null-causer audits, idempotently", async () => {
      const { id } = await seedParent("series");
      const store = pgEventStore(sql);
      expect(await store.materializeSeries()).toBe(3);
      const rows = (await sql`select recurrence_index, status, parent_event_id from events order by recurrence_index`) as {
        recurrence_index: number | null; status: string; parent_event_id: number | null;
      }[];
      expect(rows).toEqual([
        { recurrence_index: 1, status: "published", parent_event_id: null },
        { recurrence_index: 2, status: "draft", parent_event_id: id },
        { recurrence_index: 3, status: "draft", parent_event_id: id },
        { recurrence_index: 4, status: "draft", parent_event_id: id },
      ]);
      const audits = (await sql`select subject_id, causer_id, description from activity_log`) as {
        subject_id: string; causer_id: string | null; description: string;
      }[];
      expect(audits).toHaveLength(3);
      expect(audits.every((a) => a.causer_id === null && a.description === "created event Sunday Squad")).toBe(true);
      expect(await store.materializeSeries()).toBe(0); // re-run creates nothing
    });

    it("never grows a cancelled series and never resurrects a skipped week", async () => {
      const { id } = await seedParent("cancelled-series", "cancelled");
      const live = await seedParent("live-series");
      // Moderator cancelled instance 3 to skip a week; instance 4 was never made.
      const [third] = (await sql`insert into events
          (event_key, title, starts_at, ends_at, timezone, status, parent_event_id, recurrence_index)
        values (${key("skipped")}, 'Sunday Squad', ${seriesStarts}, ${seriesEnds}, 'Europe/London',
          'cancelled', ${live.id}, 3)
        returning event_key`) as { event_key: string }[];
      const store = pgEventStore(sql);
      expect(await store.materializeSeries()).toBe(2); // live indexes 2 and 4 only
      const kept = (await sql`select recurrence_index, status from events
        where parent_event_id = ${live.id} order by recurrence_index`) as {
        recurrence_index: number; status: string;
      }[];
      expect(kept).toEqual([
        { recurrence_index: 2, status: "draft" },
        { recurrence_index: 3, status: "cancelled" },
        { recurrence_index: 4, status: "draft" },
      ]);
      expect(third!.event_key).toBeTruthy();
      expect(await sql`select id from events where parent_event_id = ${id}`).toHaveLength(0);
    });
  });
});
