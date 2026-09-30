import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { users } from "../src/db/schema";
import { listGoingAttendees } from "../src/events/reads";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR, OUTSIDER, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe.skipIf(!process.env.DATABASE_URL)("member-only event attendees (isolated agent-testdb schema)", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();
  const request = (path = `/e/${EVENT_KEY}`, init: RequestInit = {}, enforce?: string) => app.request(path, init, {
    ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions, MEMBER_ACCESS_LOG_ENFORCE: enforce,
  });
  const headers = async (actor = MEMBER) => ({ cookie: await cookieFor(sessions, actor) });
  const logs = () => fixture.db.select().from(memberDataAccessLogs);

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => { await fixture.reset(); await seed(fixture.db); sessions = createMemorySessionStore(); });
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.reset(); });
  afterAll(() => fixture?.dispose());

  it.each(["guest", "non-member"])("%s HTML/source contains no attendee identity or list count", async (role) => {
    const res = await request(undefined, { headers: role === "guest" ? {} : await headers(OUTSIDER) });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("1 going");
    for (const value of [SUBJECT.username, SUBJECT.userId, "event-attendees", "Who's going"])
      expect(html).not.toContain(value);
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(html.includes('data-testid="event-join-pitch"')).toBe(role === "guest");
    expect(html).toContain('data-testid="event-copy-link"');
    expect(await logs()).toHaveLength(0);
  });

  it.each([MEMBER, MODERATOR])("$username sees a linked name and records its subject before serving", async (actor) => {
    const res = await request(undefined, { headers: await headers(actor) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(await logs()).toMatchObject([{
      viewerDiscordId: actor.userId, viewerUserId: actor.userId, resource: "member", action: "list",
      subjectUserIds: [SUBJECT.userId], subjectCount: 1, route: "events.page",
    }]);
  });

  it.each(["published", "past", "draft"])("%s keeps the logged attendee list alongside event states and canonical sharing", async (status) => {
    await fixture.db.update(events).set({ status, location: "Lobby & voice" });
    const res = await request(undefined, { headers: await headers(status === "draft" ? MODERATOR : MEMBER) });
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain(`<a href="/members/${SUBJECT.userId}">${SUBJECT.username}</a>`);
    expect(html).toContain('data-testid="event-venue">Lobby &amp; voice');
    expect(html).toContain(`data-copy-link="${env.APP_URL}/e/${EVENT_KEY}"`);
    expect(html).not.toContain('data-testid="event-join-pitch"');
    if (status !== "published") {
      expect(html).toContain(`data-testid="event-${status}"`);
      expect(html).toContain('name="robots" content="noindex, nofollow"');
    }
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("vary")).toBe("Cookie");
    expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId], subjectCount: 1, route: "events.page" }]);
  });

  it("composes navigation with member-only attendee logging without leaking names to guests", async () => {
    const siblingKey = "01J00000000000000000000016";
    await fixture.db.insert(events).values({
      eventKey: siblingKey, title: "Next game night", status: "published",
      startsAt: new Date("2099-11-05T20:00:00Z"), endsAt: new Date("2099-11-05T22:00:00Z"),
    });
    for (const actor of [null, MEMBER]) {
      const res = await request(undefined, { headers: actor ? await headers(actor) : {} });
      const html = await res.text();
      expect(res.status).toBe(200);
      expect(html).toContain(`href="/e/${siblingKey}" rel="next" data-testid="event-next"`);
      expect(html).toContain(`href="/e/${siblingKey}" data-testid="event-related-link"`);
      expect(html.includes(SUBJECT.username)).toBe(actor !== null);
      expect(html.includes('data-testid="event-related-join"')).toBe(actor === null);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(res.headers.get("vary")).toBe("Cookie");
      expect(await logs()).toHaveLength(actor ? 1 : 0);
    }
    expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId], route: "events.page" }]);
  });

  it("orders by original answer time, excludes other statuses/events, missing users and empty names", async () => {
    const db = fixture.db;
    const [event] = await db.select().from(events);
    await db.update(rsvps).set({ createdAt: new Date("2026-01-03"), updatedAt: new Date("2026-01-01") });
    await db.insert(users).values({ id: "100000000000000105", username: "" });
    await db.insert(rsvps).values([
      { eventId: event!.id, userId: MEMBER.userId, status: "going", createdAt: new Date("2026-01-01"), updatedAt: new Date("2026-01-04") },
      { eventId: event!.id, userId: MODERATOR.userId, status: "waitlisted" },
      { eventId: event!.id, userId: OUTSIDER.userId, status: "not_going" },
      { eventId: event!.id, userId: "100000000000000105", status: "going" },
      { eventId: event!.id, userId: "100000000000000106", status: "going" },
    ]);
    const [other] = await db.insert(events).values({
      eventKey: "01J00000000000000000000016", title: "Other event", status: "published",
      startsAt: event!.startsAt, endsAt: event!.endsAt,
    }).returning();
    await db.insert(rsvps).values({ eventId: other!.id, userId: MODERATOR.userId, status: "going" });
    expect(await listGoingAttendees(db, event!.id)).toEqual([
      { id: MEMBER.userId, name: MEMBER.username }, { id: SUBJECT.userId, name: SUBJECT.username },
    ]);
    const html = await (await request(undefined, { headers: await headers(MEMBER) })).text();
    expect(html.indexOf(MEMBER.username)).toBeLessThan(html.indexOf(SUBJECT.username));
    expect(await logs()).toMatchObject([{ subjectUserIds: [SUBJECT.userId], subjectCount: 1 }]); // self excluded
  });

  it("escapes the stored name and never sends it in JSON or calendar exports", async () => {
    await fixture.db.update(users).set({ username: '<img src=x onerror="alert(1)">' }).where(eq(users.id, SUBJECT.userId));
    const html = await (await request(undefined, { headers: await headers(MEMBER) })).text();
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img src=x");
    for (const path of ["/events.json", "/events.ics", "/events.rss", `/events/${EVENT_KEY}.ics`]) {
      const res = await request(path, { headers: await headers(MEMBER) });
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).not.toContain(SUBJECT.userId);
      expect(body).not.toContain("onerror");
    }
    expect(await logs()).toHaveLength(1);
  });

  it("empty and self-only lists produce no access-log row", async () => {
    await fixture.db.delete(rsvps);
    const empty = await request(undefined, { headers: await headers(MEMBER) });
    expect(await empty.text()).not.toContain("event-attendees");
    expect(await logs()).toHaveLength(0);
    const [event] = await fixture.db.select().from(events);
    await fixture.db.insert(rsvps).values({ eventId: event!.id, userId: MEMBER.userId, status: "going" });
    const self = await request(undefined, { headers: await headers(MEMBER) });
    expect(await self.text()).toContain(MEMBER.username);
    expect(await logs()).toHaveLength(0);
  });

  it("missing/forbidden/cancelled pages do not render or log subjects", async () => {
    expect((await request("/e/invalid")).status).toBe(404);
    expect((await request("/e/01J00000000000000000000017")).status).toBe(404);
    await fixture.db.update(events).set({ status: "draft" });
    expect((await request(undefined, { headers: await headers(MEMBER) })).status).toBe(403);
    await fixture.db.update(events).set({ status: "cancelled" });
    const gone = await request(undefined, { headers: await headers(MEMBER) });
    expect(gone.status).toBe(410);
    expect(await gone.text()).not.toContain(SUBJECT.username);
    expect(await logs()).toHaveLength(0);
  });

  it.each([undefined, "false"])("failed log INSERT enforces=%s without spilling subjects", async (enforce) => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.db.execute(sql`ALTER TABLE member_data_access_logs ADD CONSTRAINT reject_test_access CHECK (false)`);
    try {
      const res = await request(undefined, { headers: await headers(MEMBER) }, enforce);
      expect(res.status).toBe(enforce === "false" ? 200 : 503);
      const html = await res.text();
      expect(html.includes(SUBJECT.username)).toBe(enforce === "false");
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      expect(await logs()).toHaveLength(0);
      const logged = JSON.stringify(error.mock.calls);
      expect(logged).not.toContain(SUBJECT.userId);
      expect(logged).not.toContain(SUBJECT.username);
    } finally {
      await fixture.db.execute(sql`ALTER TABLE member_data_access_logs DROP CONSTRAINT reject_test_access`);
    }
  });
});
