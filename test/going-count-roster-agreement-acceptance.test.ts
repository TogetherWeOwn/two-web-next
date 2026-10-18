// Acceptance: the going-count badge, the full/waitlist verdict and the
// attendee roster tell one consistent story when nameless going rows exist.
//
// Chosen consistency rule (pinned here): the count is the attributable
// (named-only) count — exactly the rows the roster can list. A going row
// whose user has an empty stored name, or no user row at all, is never
// rendered as an identity and must not inflate the badge or flip the event
// to "full". So for every event: goingCount === listGoingAttendees().length
// (within one roster page), and `full` is goingCount >= capacity on that
// same attributable count.
//
// Real reads and the real event page against the disposable member-data
// fixture (isolated schema, synthetic identities; skipped without
// DATABASE_URL like the other live suites). No live member data.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { getPublicEvent, listGoingAttendees, listJson } from "../src/events/reads";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// A going row with an empty stored name, and one with no user row at all:
// the two shapes the roster already refuses to list.
const NAMELESS_EMPTY_ID = "100000000000000105";
const NAMELESS_MISSING_ID = "100000000000000106";

describe.skipIf(!process.env.DATABASE_URL)(
  "going-count badge agrees with the roster (isolated agent-testdb schema)",
  () => {
    let fixture: MemberDataFixture;
    let sessions = createMemorySessionStore();
    const request = (init: RequestInit = {}) =>
      app.request(`/e/${EVENT_KEY}`, init, {
        ...env,
        ADMIN_DB: fixture.db,
        SESSION_STORE: sessions,
      });
    const memberPage = async () => {
      const res = await request({ headers: { cookie: await cookieFor(sessions, MEMBER) } });
      expect(res.status).toBe(200);
      return res.text();
    };
    const logs = () => fixture.db.select().from(memberDataAccessLogs);
    const eventRow = async () => (await fixture.db.select().from(events))[0]!;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await seed(fixture.db);
      // Cap of two: one named + one nameless going row is exactly the case
      // where an all-rows count reads "full" over a one-name roster.
      await fixture.db.update(events).set({ capacity: 2 });
      sessions = createMemorySessionStore();
    });
    afterEach(async () => {
      await fixture?.reset();
    });
    afterAll(() => fixture?.dispose());

    it.each([
      ["empty stored name", NAMELESS_EMPTY_ID, true],
      ["missing user row", NAMELESS_MISSING_ID, false],
    ])(
      "one nameless (%s) + one named going row: badge, full verdict and roster agree",
      async (_shape, namelessId, insertUser) => {
        const db = fixture.db;
        const event = await eventRow();
        if (insertUser) await db.insert(users).values({ id: namelessId, username: "" });
        await db.insert(rsvps).values({ eventId: event.id, userId: namelessId, status: "going" });

        // The roster lists only the attributable attendee (existing contract).
        const roster = await listGoingAttendees(db, event.id);
        expect(roster).toEqual([{ id: SUBJECT.userId, name: SUBJECT.username }]);

        // The badge count is that same attributable count, on the single-event
        // read and on the grouped listing read alike.
        expect((await getPublicEvent(db, EVENT_KEY))?.goingCount).toBe(roster.length);
        const listed = (await listJson(db, { limit: 10, offset: 0 })).rows.find(
          (row) => row.eventKey === EVENT_KEY,
        );
        expect(listed?.goingCount).toBe(roster.length);

        // 1 of 2 attributable going: not full, one spot left, going CTA shown,
        // and no nameless identity anywhere on the page.
        const html = await memberPage();
        expect(html).toContain("<span data-count>1 of 2 going</span>");
        expect(html).toContain(">1 of 2 spots left</span>");
        expect(html).toContain('data-testid="rsvp-going"');
        expect(html).not.toContain("full. Cap is");
        expect(html).not.toContain('data-testid="waitlist-join"');
        expect(html).not.toContain('data-full="true"');
        expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
        expect(html).not.toContain(namelessId);
        expect(await logs()).toMatchObject([
          { subjectUserIds: [SUBJECT.userId], subjectCount: 1, route: "events.page" },
        ]);
      },
    );

    it("nameless-only going rows count as nobody going, with an empty roster", async () => {
      const db = fixture.db;
      const event = await eventRow();
      await db.delete(rsvps);
      await db.insert(users).values({ id: NAMELESS_EMPTY_ID, username: "" });
      await db
        .insert(rsvps)
        .values({ eventId: event.id, userId: NAMELESS_EMPTY_ID, status: "going" });

      expect(await listGoingAttendees(db, event.id)).toEqual([]);
      expect((await getPublicEvent(db, EVENT_KEY))?.goingCount).toBe(0);

      const html = await memberPage();
      expect(html).toContain("<span data-count>0 of 2 going</span>");
      expect(html).toContain(">2 of 2 spots left</span>");
      expect(html).not.toContain('data-testid="event-attendees"');
      expect(html).not.toContain(NAMELESS_EMPTY_ID);
      expect(await logs()).toHaveLength(0);
    });

    it("positive control: all-named at capacity is full and the roster lists both", async () => {
      const db = fixture.db;
      const event = await eventRow();
      await db
        .insert(rsvps)
        .values({ eventId: event.id, userId: MODERATOR.userId, status: "going" });

      const roster = await listGoingAttendees(db, event.id);
      expect(roster).toEqual([
        { id: SUBJECT.userId, name: SUBJECT.username },
        { id: MODERATOR.userId, name: MODERATOR.username },
      ]);
      expect((await getPublicEvent(db, EVENT_KEY))?.goingCount).toBe(roster.length);

      const html = await memberPage();
      expect(html).toContain("<span data-count>2 of 2 going</span>");
      expect(html).toContain(">Full</span>");
      expect(html).toContain("This one&#39;s full. Cap is 2.");
      expect(html).toContain('data-testid="waitlist-join"');
      expect(html).not.toContain('data-testid="rsvp-going"');
    });

    it("positive control: all-named below capacity agrees and is not full", async () => {
      const db = fixture.db;
      const event = await eventRow();

      const roster = await listGoingAttendees(db, event.id);
      expect(roster).toEqual([{ id: SUBJECT.userId, name: SUBJECT.username }]);
      expect((await getPublicEvent(db, EVENT_KEY))?.goingCount).toBe(roster.length);

      const html = await memberPage();
      expect(html).toContain("<span data-count>1 of 2 going</span>");
      expect(html).toContain(">1 of 2 spots left</span>");
      expect(html).toContain('data-testid="rsvp-going"');
      expect(html).not.toContain("full. Cap is");
    });

    it("positive control: empty event counts zero with no roster", async () => {
      const db = fixture.db;
      const event = await eventRow();
      await db.delete(rsvps);

      expect(await listGoingAttendees(db, event.id)).toEqual([]);
      expect((await getPublicEvent(db, EVENT_KEY))?.goingCount).toBe(0);

      const html = await memberPage();
      expect(html).toContain("<span data-count>0 of 2 going</span>");
      expect(html).toContain(">2 of 2 spots left</span>");
      expect(html).not.toContain('data-testid="event-attendees"');
      expect(html).toContain('data-testid="rsvp-going"');
      expect(await logs()).toHaveLength(0);
    });
  },
);
