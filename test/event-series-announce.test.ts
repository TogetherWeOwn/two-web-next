// Series-extension announcement boundary (TOG-11762).
//
// src/admin/store.ts promises extending a live series never announces a meeting
// a member already holds (children materialise as drafts), and src/events/sync.ts
// skips drafts/past. This suite pins that boundary end to end, asserting on the
// queued write-back set (store write-backs + the reconcile stale set), never on
// the bot transport:
// - extending a live series materialises drafts only and queues nothing new;
// - live, past and draft occurrences yield no announcement payload;
// - the stale set holds exactly the genuinely-new published occurrences;
// - the sync consumer drops unmirrored occurrences without calling the bot;
// - publishing a fresh draft occurrence still announces exactly that occurrence.

import postgres from "postgres";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { asc, eq, sql as dsql } from "drizzle-orm";
import type { Db } from "../src/db/index";
import {
  createMemberDataFixture,
  testDatabaseUrl,
  type MemberDataFixture,
} from "./helpers/member-data-db";
import { events } from "../src/db/admin-schema";
import { createEvent, materializeRecurringSeries, transitionEvent } from "../src/admin/store";
import { wallToUtc, type EventStatus } from "../src/admin/validation";
import { buildSyncMessage } from "../src/events/sync";
import { pgEventStore } from "../src/jobs/events";
import { handleSyncEvent } from "../src/jobs/sync-event";
import type { BotClient, EventStore } from "../src/jobs/types";

const starts = wallToUtc("2026-11-01 20:00", "Europe/London");
const ends = wallToUtc("2026-11-01 21:00", "Europe/London");

/** Sync payload, if any, a row in this status would queue. */
const payloadFor = (eventKey: string, status: string) =>
  buildSyncMessage(eventKey, status as EventStatus);

describe("series extension announce boundary (unit, no DB)", () => {
  it("builds no sync message for draft/past, upsert for published", () => {
    expect(payloadFor("K", "draft")).toBeNull();
    expect(payloadFor("K", "past")).toBeNull();
    expect(payloadFor("K", "published")?.kind).toBe("sync-event");
  });

  it("drops an unmirrored occurrence without calling the bot", async () => {
    let called = 0;
    const bot = {
      upsertEvent: async () => (
        called++, { ok: true, requestId: null, discordEventId: "discord-1" }
      ),
    } as unknown as BotClient;
    // The tracked store snapshots nothing for a row that is not mirrored (draft/past/unknown).
    const unmirrored: EventStore = {
      prepareSync: async () => null,
      completeSync: async () => {},
      claimSync: async () => null,
      deferSync: async () => {},
      failSync: async () => {},
      needsSync: async () => false,
      pendingSync: async () => null,
      closeFinished: async () => 0,
      materializeSeries: async () => 0,
      staleEventKeys: async () => [],
    };
    await expect(
      handleSyncEvent({ eventKey: "K", idempotencyKey: "k" }, 1, { bot, events: unmirrored }),
    ).resolves.toEqual({
      done: true,
    });
    expect(called).toBe(0);
  });
});

describe.skipIf(!process.env.DATABASE_URL)(
  "series extension announce boundary (agent-testdb)",
  () => {
    let fixture: MemberDataFixture | undefined;
    let db: Db;
    let sql: postgres.Sql | undefined;
    const actor = { id: "series-announce-test", username: "mod" };
    const input = {
      title: "Sunday Squad",
      game: null,
      description: null,
      startsAtUtc: starts,
      endsAtUtc: ends,
      timezone: "Europe/London",
      location: "Hall",
      capacity: null,
    };
    beforeEach(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      // Raw postgres.js pool for the jobs adapter: drizzle installs transparent
      // date serializers on the client it wraps, so native-Date parameters must
      // go through their own pool (see test/helpers/jobs-db.ts).
      const url = testDatabaseUrl(process.env.DATABASE_URL!);
      sql = postgres(url.href, {
        max: 1,
        port: 5432,
        connect_timeout: 5,
        password: () => url.password,
        connection: { search_path: fixture.schemaName },
        onnotice: () => {},
      });
    });
    afterEach(async () => {
      try {
        await sql?.end({ timeout: 1 });
      } finally {
        sql = undefined;
        await fixture?.dispose();
        fixture = undefined;
      }
    });

    // Fully mirrored: Discord id known and every revision acknowledged.
    const markMirrored = (eventKey: string, discordEventId: string) =>
      db
        .update(events)
        .set({ discordEventId, syncedRevision: dsql`${events.syncRevision}` })
        .where(eq(events.eventKey, eventKey));

    const seriesRows = () =>
      db.select().from(events).orderBy(asc(events.recurrenceIndex), asc(events.id));

    it("extending a live series materialises drafts only and queues nothing new", async () => {
      const { row: parent } = await createEvent(db, actor, input, {
        frequency: "weekly",
        count: 2,
        endsOn: null,
      });
      // The parent's first announcement happens at publish time, not at extension time.
      const pub = await transitionEvent(db, actor, parent.eventKey, "published");
      expect(pub.writeBack).toEqual({ eventKey: parent.eventKey, status: "published" });
      // Fully mirror the live parent so the reconcile pass has nothing to re-announce for it.
      await markMirrored(parent.eventKey, "discord-parent");

      // Extend the live series 2 -> 4 and run the reconcile top-up.
      await db
        .update(events)
        .set({ recurrenceCount: 4 })
        .where(eq(events.eventKey, parent.eventKey));
      expect(await materializeRecurringSeries(db)).toBe(2);
      const rows = await seriesRows();
      expect(rows.map((r) => [r.recurrenceIndex, r.status])).toEqual([
        [1, "published"],
        [2, "draft"],
        [3, "draft"],
        [4, "draft"],
      ]);
      // The genuinely new occurrences are drafts, so no sync payload exists for them.
      for (const child of rows.filter((r) => (r.recurrenceIndex ?? 0) > 2)) {
        expect(payloadFor(child.eventKey, child.status)).toBeNull();
      }
      // Nothing is queued: the mirrored live parent stays silent and the drafts were never announced.
      const store = pgEventStore(sql!);
      expect(await store.staleEventKeys()).toEqual([]);
      // A re-run creates nothing and still queues nothing.
      expect(await materializeRecurringSeries(db)).toBe(0);
      expect(await store.staleEventKeys()).toEqual([]);
    });

    it("live, past and draft occurrences yield no announcement payload", async () => {
      // Live and fully mirrored: nothing left to announce.
      const { row: live } = await createEvent(db, actor, { ...input, title: "Live" });
      await transitionEvent(db, actor, live.eventKey, "published");
      await markMirrored(live.eventKey, "discord-live");
      // Draft: never announced.
      const { row: draft } = await createEvent(db, actor, { ...input, title: "Draft" });
      // Ended: published while live, then closed to past by the reconcile close half.
      const { row: ended } = await createEvent(db, actor, { ...input, title: "Ended" });
      await transitionEvent(db, actor, ended.eventKey, "published");
      await db
        .update(events)
        .set({
          startsAt: new Date("2026-09-01T09:00:00Z"),
          endsAt: new Date("2026-09-01T10:00:00Z"),
        })
        .where(eq(events.eventKey, ended.eventKey));
      const store = pgEventStore(sql!);
      expect(await store.closeFinished(new Date("2026-10-01T12:00:00Z"))).toBe(1);

      const rows = await db.select().from(events);
      const statusOf = (key: string) => rows.find((r) => r.eventKey === key)!.status;
      expect(statusOf(ended.eventKey)).toBe("past");
      expect(payloadFor(draft.eventKey, statusOf(draft.eventKey))).toBeNull();
      expect(payloadFor(ended.eventKey, statusOf(ended.eventKey))).toBeNull();
      // No queued write-back for any of them: mirrored live, draft, and past are all silent.
      expect(await store.staleEventKeys()).toEqual([]);
    });

    it("publishing a fresh occurrence announces exactly that occurrence; a skipped week stays silent", async () => {
      const { row } = await createEvent(db, actor, input, {
        frequency: "weekly",
        count: 3,
        endsOn: null,
      });
      const byIndex = async () =>
        Object.fromEntries((await seriesRows()).map((r) => [r.recurrenceIndex, r]));
      // A moderator cancelled instance 2 to skip a week.
      const before = await byIndex();
      await transitionEvent(db, actor, before[2]!.eventKey, "cancelled");
      // Publishing the fresh instance 3 is the genuine announcement.
      const freshKey = (await byIndex())[3]!.eventKey;
      const pub = await transitionEvent(db, actor, freshKey, "published");
      expect(pub.writeBack).toEqual({ eventKey: freshKey, status: "published" });

      // Extend 3 -> 4: only the missing index materialises, as a draft.
      await db.update(events).set({ recurrenceCount: 4 }).where(eq(events.id, row.id));
      expect(await materializeRecurringSeries(db)).toBe(1);
      const rows = await seriesRows();
      expect(rows.map((r) => [r.recurrenceIndex, r.status])).toEqual([
        [1, "draft"],
        [2, "cancelled"],
        [3, "published"],
        [4, "draft"],
      ]);
      // Tracked outbox: the new published occurrence plus the skipped week's
      // cancel (event.cancel). Never the draft parent or the draft top-up.
      const store = pgEventStore(sql!);
      const skippedKey = before[2]!.eventKey;
      expect((await store.staleEventKeys()).sort()).toEqual([freshKey, skippedKey].sort());
      expect(await materializeRecurringSeries(db)).toBe(0);
    });
  },
);
