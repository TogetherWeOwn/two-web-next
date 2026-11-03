// route-inventory: GET /admin/echoes
// route-inventory: GET /admin/echoes/:id
// route-inventory: POST /admin/echoes/:id/headline
// Event Echoes render acceptance: a seeded Echo row on every surface.
// Disposable test database only (the fixture refuses before connecting
// without an approved DATABASE_URL); one Echo per event, frozen counts,
// host headline, F20 projections end to end.
import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import app from "./app";
import { adminApp } from "../src/admin/routes";
import { eventEchoMembers, eventEchoes, events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { users } from "../src/db/schema";
import type { Env } from "../src/env";
import { __resetAnonEventCacheForTests } from "../src/events/anon-cache";
import { __resetHomeGuestCacheForTests } from "../src/home-cache";
import { profilesApp } from "../src/profiles/routes";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const ECHO_KEY = "01J000000000000000000000E1";
const SIGNUP_KEY = "01J000000000000000000000E2";
const FUTURE_KEY = "01J000000000000000000000E3";
const HEADLINE = "3rd of 24 — semis heartbreak";

async function seedBase(db: Db): Promise<void> {
  await db.insert(users).values([
    { id: SUBJECT.userId, username: SUBJECT.username, member: true, avatar: null },
    { id: MEMBER.userId, username: MEMBER.username, member: true, avatar: null },
  ]);
  await db.insert(events).values([
    {
      eventKey: ECHO_KEY,
      title: "Echo render night",
      status: "published",
      startsAt: new Date("2026-10-25T18:00:00Z"),
      endsAt: new Date("2026-10-25T20:00:00Z"),
    },
    {
      // A pre-Echo record: status past, window long closed, never an Echo row.
      eventKey: SIGNUP_KEY,
      title: "Signup render night",
      status: "past",
      startsAt: new Date("2026-10-18T18:00:00Z"),
      endsAt: new Date("2026-10-18T20:00:00Z"),
    },
    {
      eventKey: FUTURE_KEY,
      title: "Future render night",
      status: "published",
      startsAt: new Date("2026-11-10T18:00:00Z"),
      endsAt: new Date("2026-11-10T20:00:00Z"),
    },
  ]);
  const [signup] = await db.select({ id: events.id }).from(events).where(eqEventKey(SIGNUP_KEY));
  await db.insert(rsvps).values([
    { eventId: signup!.id, userId: SUBJECT.userId, status: "going" },
    { eventId: signup!.id, userId: MEMBER.userId, status: "going" },
  ]);
}

const eqEventKey = (key: string) => eq(events.eventKey, key);

async function seedEcho(db: Db): Promise<number> {
  const [night] = await db.select({ id: events.id }).from(events).where(eqEventKey(ECHO_KEY));
  const [echo] = await db
    .insert(eventEchoes)
    .values({
      eventId: night!.id,
      eventKey: ECHO_KEY,
      windowStartsAt: new Date("2026-10-25T17:45:00Z"),
      windowEndsAt: new Date("2026-10-25T20:15:00Z"),
      thresholdMinutes: 10,
      peakConcurrent: 15,
      attendedCount: 12,
      rooms: [
        { channel_id: "111111111111111111", name_at_close: "Arena" },
        { channel_id: "222222222222222222", name_at_close: "Lobby" },
      ],
      headline: HEADLINE,
    })
    .returning({ id: eventEchoes.id });
  await db.insert(eventEchoMembers).values([
    { echoId: echo!.id, userId: SUBJECT.userId, minutes: 45, sessions: 2, firstJoinedAt: null },
    { echoId: echo!.id, userId: MEMBER.userId, minutes: 5, sessions: 1, firstJoinedAt: null },
  ]);
  return echo!.id;
}

describe("event echo render acceptance", () => {
  let fixture: MemberDataFixture;

  beforeEach(async () => {
    if (!fixture) fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    await fixture.reset();
    __resetHomeGuestCacheForTests();
    __resetAnonEventCacheForTests();
    await seedBase(fixture.db);
  }, 30_000);
  afterAll(() => fixture?.dispose());

  const mainBindings = (store = createMemorySessionStore()) =>
    ({ ...env, ADMIN_DB: fixture.db, SESSION_STORE: store }) as Env;

  describe("home cream band", () => {
    it("shows the frozen record with the host headline and an archive link", async () => {
      await seedEcho(fixture.db);
      const res = await app.request("/", {}, mainBindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="event-echoes-band"');
      expect(html).toContain("Fresh from the lobby");
      expect(html).toContain("Last time, as the bot recorded it");
      expect(html).toContain("12 showed up across 2 rooms · peak 15 in voice");
      expect(html).toContain(HEADLINE);
      expect(html).toContain("attendance record");
      expect(html).toContain(`/e/${ECHO_KEY}`);
      expect(html).toContain("/events/past");
    });

    it("renders no band when no Echo exists yet", async () => {
      const res = await app.request("/", {}, mainBindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).not.toContain('data-testid="event-echoes-band"');
      expect(html).not.toContain("Fresh from the lobby");
    });
  });

  describe("event detail", () => {
    it("shows the bot record for an Echo event", async () => {
      await seedEcho(fixture.db);
      const res = await app.request(`/e/${ECHO_KEY}`, {}, mainBindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="event-echo"');
      expect(html).toContain("Last time, as the bot recorded it");
      expect(html).toContain("12 showed up across 2 rooms · peak 15 in voice");
      expect(html).toContain(HEADLINE);
      expect(html).toContain("attendance record");
      expect(html).not.toContain("sign-up record");
    });

    it("keeps the sign-up record for a pre-Echo event", async () => {
      const res = await app.request(`/e/${SIGNUP_KEY}`, {}, mainBindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("Last time, from the sign-up sheet");
      expect(html).toContain("2 going · sign-up record");
      expect(html).not.toContain("as the bot recorded it");
    });
  });

  describe("past archive", () => {
    it("labels each card with its record kind", async () => {
      await seedEcho(fixture.db);
      const res = await app.request("/events/past", {}, mainBindings());
      expect(res.status).toBe(200);
      const html = await res.text();
      const labels = html.match(/data-testid="event-record-label"/g) ?? [];
      expect(labels).toHaveLength(2);
      expect(html).toContain("12 showed up across 2 rooms · peak 15 in voice");
      expect(html).toContain("attendance record");
      expect(html).toContain("2 going");
      expect(html).toContain("sign-up record");
      expect(html).toContain(`/e/${ECHO_KEY}`);
      expect(html).toContain(`/e/${SIGNUP_KEY}`);
    });
  });

  describe("own profile minutes", () => {
    const profileBindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;
    const reader = (store: ReturnType<typeof createMemorySessionStore>) =>
      profilesApp({ sessionStore: store });

    it("shows the owner's minutes with the headline, never another member", async () => {
      await seedEcho(fixture.db);
      const sessions = createMemorySessionStore();
      const own = await reader(sessions).request(
        `/members/${SUBJECT.userId}`,
        { headers: { cookie: await cookieFor(sessions, SUBJECT) } },
        profileBindings(),
      );
      expect(own.status).toBe(200);
      const ownHtml = await own.text();
      expect(ownHtml).toContain('data-testid="event-echo-own-minutes"');
      expect(ownHtml).toContain("Your recent game nights");
      expect(ownHtml).toContain("45 minutes in voice");
      expect(ownHtml).toContain(HEADLINE);
      expect(ownHtml).toContain(`/e/${ECHO_KEY}`);
      expect(ownHtml).not.toContain("below the 10-minute attendance mark");

      const other = await reader(sessions).request(
        `/members/${SUBJECT.userId}`,
        { headers: { cookie: await cookieFor(sessions, MEMBER) } },
        profileBindings(),
      );
      expect(other.status).toBe(200);
      const otherHtml = await other.text();
      expect(otherHtml).not.toContain('data-testid="event-echo-own-minutes"');
      expect(otherHtml).not.toContain("45 minutes in voice");
    });

    it("marks below-threshold minutes without publishing absence", async () => {
      await seedEcho(fixture.db);
      const sessions = createMemorySessionStore();
      const res = await reader(sessions).request(
        `/members/${MEMBER.userId}`,
        { headers: { cookie: await cookieFor(sessions, MEMBER) } },
        profileBindings(),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("5 minutes in voice (below the 10-minute attendance mark)");
    });
  });

  describe("admin ledger", () => {
    // adminApp is mounted at /admin by the main app; direct requests use the
    // unmounted paths (the 303 Location keeps the mounted public path).
    const admin = (store: ReturnType<typeof createMemorySessionStore>) =>
      adminApp({ sessionStore: store, db: fixture.db });
    const modCookie = async (store: ReturnType<typeof createMemorySessionStore>) =>
      cookieFor(store, {
        userId: "100000000000000103",
        username: "w15-moderator",
        member: true,
        moderator: true,
      });
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as Env;
    const postHeadline = (
      store: ReturnType<typeof createMemorySessionStore>,
      cookie: string,
      id: number,
      headline: string,
    ) =>
      admin(store).request(
        `/echoes/${id}/headline`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ headline }),
        },
        bindings(),
      );

    it("lists counts only, with the Discord post state", async () => {
      await seedEcho(fixture.db);
      const store = createMemorySessionStore();
      const res = await admin(store).request(
        "/echoes",
        { headers: { cookie: await modCookie(store) } },
        bindings(),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="echoes-table"');
      expect(html).toContain("Echo render night");
      expect(html).toContain("12");
      expect(html).toContain(HEADLINE);
      expect(html).toContain("pending");
      expect(html).not.toContain("45 minutes in voice");
    });

    it("shows member minutes on the detail view only", async () => {
      const id = await seedEcho(fixture.db);
      const store = createMemorySessionStore();
      const res = await admin(store).request(
        `/echoes/${id}`,
        { headers: { cookie: await modCookie(store) } },
        bindings(),
      );
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="echo-members-table"');
      expect(html).toContain(SUBJECT.userId);
      expect(html).toContain("45");
      expect(html).toContain("below threshold");
    });

    it("updates the headline and refuses an overlong one with 422", async () => {
      const id = await seedEcho(fixture.db);
      const store = createMemorySessionStore();
      const cookie = await modCookie(store);
      const saved = await postHeadline(store, cookie, id, "Tourney champs");
      expect(saved.status).toBe(303);
      expect(saved.headers.get("location")).toBe(`/admin/echoes/${id}`);
      const after = await admin(store).request(
        `/echoes/${id}`,
        { headers: { cookie } },
        bindings(),
      );
      const afterHtml = await after.text();
      expect(afterHtml).toContain("Tourney champs");
      expect(afterHtml).not.toContain(HEADLINE);

      const refused = await postHeadline(store, cookie, id, "x".repeat(141));
      expect(refused.status).toBe(422);
      expect(await refused.text()).toContain("at most 140 characters");
      const kept = await admin(store).request(`/echoes/${id}`, { headers: { cookie } }, bindings());
      expect(await kept.text()).toContain("Tourney champs");
    });

    it("renders the empty state before the first Echo", async () => {
      const store = createMemorySessionStore();
      const res = await admin(store).request(
        "/echoes",
        { headers: { cookie: await modCookie(store) } },
        bindings(),
      );
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("No echoes yet.");
    });
  });
});
