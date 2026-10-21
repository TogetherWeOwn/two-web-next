// route-inventory: POST /admin/events/:key
// route-inventory: PATCH /events/:key
// Acceptance: a parent series edit applies independent start/end deltas to
// future occurrences. If a delta would leave any affected future occurrence
// ending at or before it starts, the whole edit must be refused with the
// existing ends_at validation response — atomically, with no shifted rows,
// no audit rows, no waitlist promotions and no dispatched write-backs.
//
// Concrete counterexample: parent 20:00-22:00, an individually shortened
// future occurrence 20:00-20:30, then the parent end moves to 21:00. The
// -1h end delta would move that occurrence to 20:00-19:30.
//
// Live suite on the owned disposable-Postgres fixture, skipped without
// DATABASE_URL like test/admin-branch-floor.test.ts. November in
// Europe/London is GMT, so wall text and UTC coincide exactly.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { dispatchWriteBack } from "../src/admin/writeback";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { QueueMessage } from "../src/jobs/types";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env as baseEnv, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const END_AFTER_START = "The end is after the start.";
const FORM = {
  title: "Game night",
  game: "Chess",
  description: "Boards out",
  location: "Voice",
  capacity: "1",
  starts_at: "2099-11-04 20:00",
  ends_at: "2099-11-04 22:00",
  timezone: "Europe/London",
};

type SeriesChild = {
  eventKey: string;
  startsAt: string;
  endsAt: string;
};

describe.skipIf(!process.env.DATABASE_URL)(
  "parent edits that would invert a future occurrence (live)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore();
    const sent: QueueMessage[] = [];
    let cookie = "";
    let jsonEnv: Env;
    const liveEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as Env;
    const native = () => adminApp({ sessionStore: store, db });

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
      cookie = await cookieFor(store, MODERATOR);
      jsonEnv = {
        ...baseEnv,
        ADMIN_DB: db,
        SESSION_STORE: store,
        SYNC_EVENT_QUEUE: {
          send: async (message: unknown) => {
            sent.push(message as QueueMessage);
            return { metadata: { metrics: { backlogCount: 1, backlogBytes: 1 } } };
          },
        },
      } as unknown as Env;
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      sent.length = 0;
      vi.mocked(dispatchWriteBack).mockClear();
    });

    const post = (path: string, values: Record<string, string>) =>
      native().request(
        path,
        { method: "POST", headers: { cookie }, body: new URLSearchParams(values) },
        liveEnv(),
      );
    const patch = (key: string, body: unknown) =>
      app.request(
        `/events/${key}`,
        {
          method: "PATCH",
          headers: { cookie, origin: baseEnv.APP_URL, "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        jsonEnv,
      );

    async function seedSeries(children: SeriesChild[]) {
      const [parent] = await db
        .insert(events)
        .values({
          eventKey: "01K00000000000000000000022",
          title: FORM.title,
          game: FORM.game,
          description: FORM.description,
          location: FORM.location,
          capacity: 1,
          timezone: "Europe/London",
          status: "published",
          startsAt: new Date("2099-11-04T20:00:00Z"),
          endsAt: new Date("2099-11-04T22:00:00Z"),
          recurrenceFrequency: "weekly",
          recurrenceCount: children.length + 1,
          recurrenceIndex: 1,
        })
        .returning();
      const rows = [parent!];
      for (const [index, child] of children.entries()) {
        const [row] = await db
          .insert(events)
          .values({
            eventKey: child.eventKey,
            title: FORM.title,
            game: FORM.game,
            description: FORM.description,
            location: FORM.location,
            capacity: 1,
            timezone: "Europe/London",
            status: "published",
            startsAt: new Date(child.startsAt),
            endsAt: new Date(child.endsAt),
            parentEventId: parent!.id,
            recurrenceIndex: index + 2,
          })
          .returning();
        rows.push(row!);
      }
      return rows;
    }

    const snapshot = async () => ({
      events: await db.select().from(events).orderBy(events.id),
      audits: await db.select().from(activityLog),
      rsvps: await db.select().from(rsvps).orderBy(rsvps.id),
    });

    const stored = async (eventKey: string) =>
      (await db.select().from(events).where(eq(events.eventKey, eventKey)))[0]!;

    const SHORTENED: SeriesChild = {
      eventKey: "series-window-shortened",
      startsAt: "2099-11-11T20:00:00Z",
      endsAt: "2099-11-11T20:30:00Z",
    };
    const SIBLING: SeriesChild = {
      eventKey: "series-window-sibling",
      startsAt: "2099-11-18T20:00:00Z",
      endsAt: "2099-11-18T22:00:00Z",
    };

    it("refuses the shortened-child edit atomically: no rows, audits, promotions or write-backs", async () => {
      const [parent] = await seedSeries([SHORTENED, SIBLING]);
      await db.insert(rsvps).values([
        { eventId: parent!.id, userId: "100000000000000301", status: "going" },
        { eventId: parent!.id, userId: "100000000000000302", status: "waitlisted" },
      ]);
      const before = await snapshot();
      // The same edit raises capacity 1 -> 2, which would promote the waiter
      // if any part of it landed.
      const res = await post(`/events/${parent!.eventKey}`, {
        ...FORM,
        ends_at: "2099-11-04 21:00",
        capacity: "2",
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(END_AFTER_START);
      expect(await snapshot()).toEqual(before);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("refuses an edit that would leave a future occurrence with exactly zero duration", async () => {
      const [parent] = await seedSeries([
        { ...SHORTENED, endsAt: "2099-11-11T21:00:00Z" },
        SIBLING,
      ]);
      const before = await snapshot();
      const res = await post(`/events/${parent!.eventKey}`, {
        ...FORM,
        ends_at: "2099-11-04 21:00",
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(END_AFTER_START);
      expect(await snapshot()).toEqual(before);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("refuses a start-delta edit that would move a shortened occurrence's start past its end", async () => {
      const [parent] = await seedSeries([SHORTENED, SIBLING]);
      const before = await snapshot();
      const res = await post(`/events/${parent!.eventKey}`, {
        ...FORM,
        starts_at: "2099-11-04 21:30",
      });
      expect(res.status).toBe(422);
      expect(await res.text()).toContain(END_AFTER_START);
      expect(await snapshot()).toEqual(before);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("refuses the same edit over JSON PATCH with the ends_at field error and no writes", async () => {
      const [parent] = await seedSeries([SHORTENED, SIBLING]);
      const before = await snapshot();
      const res = await patch(parent!.eventKey, { ends_at: "2099-11-04 21:00" });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({
        error: "invalid",
        fields: { ends_at: END_AFTER_START },
        request_id: res.headers.get("x-request-id"),
      });
      expect(await snapshot()).toEqual(before);
      expect(sent).toEqual([]);
    });

    it("still applies a valid delta to every future occurrence and promotes the waiter", async () => {
      const [parent] = await seedSeries([SHORTENED, SIBLING]);
      await db.insert(rsvps).values([
        { eventId: parent!.id, userId: "100000000000000301", status: "going" },
        { eventId: parent!.id, userId: "100000000000000302", status: "waitlisted" },
      ]);
      const res = await post(`/events/${parent!.eventKey}`, {
        ...FORM,
        starts_at: "2099-11-04 21:00",
        ends_at: "2099-11-04 23:00",
        capacity: "2",
      });
      expect(res.status).toBe(303);
      const shortened = await stored(SHORTENED.eventKey);
      expect(shortened.startsAt.toISOString()).toBe("2099-11-11T21:00:00.000Z");
      expect(shortened.endsAt.toISOString()).toBe("2099-11-11T21:30:00.000Z");
      const sibling = await stored(SIBLING.eventKey);
      expect(sibling.startsAt.toISOString()).toBe("2099-11-18T21:00:00.000Z");
      expect(sibling.endsAt.toISOString()).toBe("2099-11-18T23:00:00.000Z");
      const line = await db.select().from(rsvps).orderBy(rsvps.id);
      expect(line.map((r) => r.status)).toEqual(["going", "going"]);
      expect((await db.select().from(activityLog)).length).toBeGreaterThan(0);
      expect(dispatchWriteBack).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ eventKey: parent!.eventKey }),
        undefined,
      );
    });

    it("an already-started shortened occurrence does not block the edit and is left alone", async () => {
      const started: SeriesChild = {
        eventKey: "series-window-started",
        startsAt: "2020-01-08T20:00:00Z",
        endsAt: "2020-01-08T20:30:00Z",
      };
      const [parent] = await seedSeries([started, SIBLING]);
      const startedBefore = await stored(started.eventKey);
      const res = await post(`/events/${parent!.eventKey}`, {
        ...FORM,
        ends_at: "2099-11-04 21:00",
      });
      expect(res.status).toBe(303);
      expect(await stored(started.eventKey)).toEqual(startedBefore);
      const sibling = await stored(SIBLING.eventKey);
      expect(sibling.startsAt.toISOString()).toBe("2099-11-18T20:00:00.000Z");
      expect(sibling.endsAt.toISOString()).toBe("2099-11-18T21:00:00.000Z");
    });
  },
);
