// Duplicate an event as a new draft: failing-first acceptance (roadmap item S4).
//
// The rolling four-week planning cadence repeats similar events, but no
// duplicate path exists: draft-first creation and publish/cancel are the only
// moderator event writes. These tests drive the new duplicate action on both
// moderator surfaces and pin the copy contract. Every test in this file FAILS
// on the base head (no duplicate route exists) and passes only with the
// builder change. Owned test file: the builder builds on this branch and never
// edits this file.
//
// Pinned contract (binding test-author decisions for the implementation):
// - POST /admin/events/:key/duplicate (HTML form, Hono-owned): moderator-only,
//   same-origin gated, 303 to /admin/events/<freshKey> on success. Malformed
//   or unknown keys answer the panel 404 ("Event not found"), mirroring the
//   publish/cancel admission. A source whose stored fields fail the current
//   form rules answers 422 naming the field instead of cloning corrupt rows.
// - POST /events/:key/duplicate (JSON, Hono-owned): joins the publish/cancel
//   family with 401/403/404 shapes, 201 { data: eventJson } on success (201,
//   not 200: the action creates a resource), and 422 { error: "invalid",
//   fields } on an invalid source. The action takes no body.
// - The copy is always an unpublished draft titled "Copy of <source>", with
//   the source's game/description/accessibility/location/organizer/joining/
//   capacity/times/timezone, a fresh ULID key, and the duplicating moderator
//   as creator. RSVPs, series linkage (parent/rule/index), Discord mirror
//   state, and agent linkage are cleared; rsvpOpen resets to open.
// - Overlong titles truncate the SOURCE part to fit 100 code points
//   ("Copy of " + first 92 code points), counted by code point, never UTF-16.
// - Exactly one activity-log row per duplicate, on the copy, whose
//   description names the duplication (matches /duplicat/i) and the copy
//   title; no write-back dispatch, no queue rows, no sibling materialization.
// - The edit page offers "Duplicate as draft" for draft, published and
//   cancelled sources as a plain POST form with data-testid="duplicate-event".
//
// Deliberately absent: // route-inventory comments (they would trip the
// stale-reference guard before the routes exist). The builder adds the two
// references plus test/fixtures/route-inventory.json and docs entries with
// the implementation.
//
// Hermeticity: disposable schema fixture only (createMemberDataFixture);
// write-back dispatch is mocked; no DATABASE_URL in the request env, so the
// write throttle degrades to allow and no queue tables are touched.

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { adminApp } from "../src/admin/routes";
import { getEvent } from "../src/admin/store";
import { newEventKey } from "../src/admin/validation";
import { dispatchWriteBack } from "../src/admin/writeback";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { agentEventGrants } from "../src/db/schema";
import type { Env, Session } from "../src/env";
import { registerEventRoutes } from "../src/events/routes";
import type { SessionReader } from "../src/events/routes-shared";
import { sameOrigin } from "../src/same-origin";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const MOD_ID = "100000000000000111";
const PLEB_ID = "100000000000000222";

const baseEnv: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; moderator: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: true,
    moderator: row.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

const moderatorSession: Session = {
  id: MOD_ID,
  username: "mod",
  avatar: null,
  member: true,
  moderator: true,
};
const memberSession: Session = {
  id: PLEB_ID,
  username: "pleb",
  avatar: null,
  member: true,
  moderator: false,
};
let currentSession: Session | null = null;
const reader: SessionReader = async () => currentSession;
const jsonApp = new Hono<{ Bindings: Env }>();
registerEventRoutes(jsonApp, reader, reader);

const JSON_HEADERS = { "content-type": "application/json" };

/** Assert the duplicate redirect shape and return the fresh key. */
function duplicateKey(res: Response): string {
  const location = res.headers.get("location");
  expect(location).toMatch(/^\/admin\/events\/[0-9A-HJKMNP-TV-Z]{26}$/i);
  return location!.split("/").pop()!;
}

describe.skipIf(!process.env.DATABASE_URL)(
  "duplicate an event as a new draft (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore();
    let modCookie = "";
    let plebCookie = "";

    const htmlApp = () => adminApp({ sessionStore: store, db });
    const htmlEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as Env;
    const jsonEnv = () => ({ ...baseEnv, ADMIN_DB: db }) as EnvWithAdminDb;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(agentEventGrants);
      await fixture.client`delete from queue_jobs`;
      vi.clearAllMocks();
      currentSession = null;
      modCookie = await cookieFor(store, {
        userId: MOD_ID,
        username: "mod",
        moderator: true,
      });
      plebCookie = await cookieFor(store, {
        userId: PLEB_ID,
        username: "pleb",
        moderator: false,
      });
    });

    const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
      const [row] = await fixture.db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Rolling plan night",
          game: "Chess",
          description: "Boards out",
          accessibilityNotes: "Step-free venue",
          startsAt: new Date("2099-06-04T19:00:00.000Z"),
          endsAt: new Date("2099-06-04T21:00:00.000Z"),
          timezone: "Europe/London",
          location: "Voice",
          organizer_name: "Night host",
          join_url: "https://example.test/join/night",
          join_instructions: "Ask at the door",
          capacity: 8,
          status: "published",
          ...over,
        })
        .returning();
      return row!;
    };

    const seedRsvps = async (eventId: number) => {
      await fixture.db.insert(rsvps).values([
        { eventId, userId: "100000000000000301", status: "going" },
        { eventId, userId: "100000000000000302", status: "maybe" },
        { eventId, userId: "100000000000000303", status: "waitlisted" },
      ]);
    };

    const duplicateHtml = (key: string, cookie: string) =>
      htmlApp().request(
        `/events/${key}/duplicate`,
        { method: "POST", headers: { cookie } },
        htmlEnv(),
      );

    it("edit page offers Duplicate as draft for draft, published and cancelled events", async () => {
      for (const status of ["draft", "published", "cancelled"] as const) {
        const row = await seed({ status, title: `Affordance ${status}` });
        const res = await htmlApp().request(
          `/events/${row.eventKey}`,
          { headers: { cookie: modCookie } },
          htmlEnv(),
        );
        expect(res.status, status).toBe(200);
        const html = await res.text();
        expect(html, status).toContain("Duplicate as draft");
        expect(html, status).toContain(`action="/admin/events/${row.eventKey}/duplicate"`);
        expect(html, status).toContain('data-testid="duplicate-event"');
      }
    });

    it("duplicating a published event creates an unpublished draft copy with cleared RSVPs", async () => {
      const source = await seed({
        status: "published",
        rsvpOpen: false,
        discordEventId: "123456789012345678",
        syncRevision: 5,
        syncedRevision: 4,
        discordSyncFailedAt: new Date("2099-01-01T00:00:00.000Z"),
        discordSyncFailureCode: "410",
        createdBy: "100000000000000999",
      });
      await seedRsvps(source.id);
      const before = await getEvent(db, source.eventKey);
      const eventsBefore = await db.select().from(events);

      const res = await duplicateHtml(source.eventKey, modCookie);
      expect(res.status).toBe(303);
      const newKey = duplicateKey(res);
      expect(newKey).not.toBe(source.eventKey);

      const copy = await getEvent(db, newKey);
      expect(copy).not.toBeNull();
      expect(copy!.status).toBe("draft");
      expect(copy!.title).toBe(`Copy of ${source.title}`);
      expect(copy!.game).toBe(source.game);
      expect(copy!.description).toBe(source.description);
      expect(copy!.accessibilityNotes).toBe(source.accessibilityNotes);
      expect(copy!.startsAt.getTime()).toBe(source.startsAt.getTime());
      expect(copy!.endsAt.getTime()).toBe(source.endsAt.getTime());
      expect(copy!.timezone).toBe(source.timezone);
      expect(copy!.location).toBe(source.location);
      expect(copy!.organizer_name).toBe(source.organizer_name);
      expect(copy!.join_url).toBe(source.join_url);
      expect(copy!.join_instructions).toBe(source.join_instructions);
      expect(copy!.capacity).toBe(source.capacity);
      expect(copy!.id).not.toBe(source.id);
      expect(copy!.createdBy).toBe(MOD_ID);
      expect(copy!.createdAt.getTime()).toBeGreaterThanOrEqual(source.createdAt.getTime());
      expect(copy!.rsvpOpen).toBe(true);
      expect(copy!.parentEventId).toBeNull();
      expect(copy!.recurrenceIndex).toBeNull();
      expect(copy!.recurrenceFrequency).toBeNull();
      expect(copy!.recurrenceCount).toBeNull();
      expect(copy!.recurrenceEndsOn).toBeNull();
      expect(copy!.discordEventId).toBeNull();
      expect(copy!.agentGrantId).toBeNull();
      expect(copy!.proofMarker).toBeNull();
      expect(copy!.agentVersion).toBe(1);
      expect(copy!.syncRevision).toBe(1);
      expect(copy!.syncedRevision).toBe(0);
      expect(copy!.discordSyncFailedAt).toBeNull();
      expect(copy!.discordSyncFailureCode).toBeNull();

      expect(await db.select().from(rsvps).where(eq(rsvps.eventId, copy!.id))).toEqual([]);
      expect(await db.select().from(rsvps).where(eq(rsvps.eventId, source.id))).toHaveLength(3);
      expect(await getEvent(db, source.eventKey)).toEqual(before);
      expect(await db.select().from(events)).toHaveLength(eventsBefore.length + 1);

      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        logName: "default",
        subjectType: "Event",
        subjectId: newKey,
        causerId: MOD_ID,
      });
      expect(audits[0]!.description).toMatch(/duplicat/i);
      expect(audits[0]!.description).toContain(copy!.title);

      expect(dispatchWriteBack).not.toHaveBeenCalled();
      expect(await fixture.client`select job_id from queue_jobs`).toEqual([]);

      const edit = await htmlApp().request(
        `/events/${newKey}`,
        { headers: { cookie: modCookie } },
        htmlEnv(),
      );
      expect(edit.status).toBe(200);
      expect(await edit.text()).toContain(copy!.title);
    });

    // Mutants: carrying source.agentGrantId/proofMarker into the insert hits
    // the migrated UNIQUE constraints; carrying agentVersion fails the read.
    // Non-default persisted source values make every reset assertion nonvacuous.
    it.each(["HTML", "JSON"] as const)(
      "%s duplicate clears a real grant-bound source's ownership, proof and version without changing it",
      async (surface) => {
        const [grant] = await db
          .insert(agentEventGrants)
          .values({
            agentId: "duplicate-fixture-agent",
            companyId: "duplicate-fixture-company",
            guildId: baseEnv.DISCORD_GUILD_ID,
            verifierHash: "d".repeat(64),
          })
          .returning();
        const source = await seed({
          agentGrantId: grant!.id,
          proofMarker: "duplicate-fixture-proof",
          agentVersion: 7,
          createdBy: "100000000000000999",
        });
        const before = await getEvent(db, source.eventKey);
        expect(before).toMatchObject({
          agentGrantId: grant!.id,
          proofMarker: "duplicate-fixture-proof",
          agentVersion: 7,
        });
        currentSession = moderatorSession;
        const res =
          surface === "HTML"
            ? await duplicateHtml(source.eventKey, modCookie)
            : await jsonApp.request(
                `/events/${source.eventKey}/duplicate`,
                { method: "POST", headers: JSON_HEADERS },
                jsonEnv(),
              );
        expect(res.status).toBe(surface === "HTML" ? 303 : 201);
        const newKey =
          surface === "HTML"
            ? duplicateKey(res)
            : ((await res.json()) as { data: { event_key: string } }).data.event_key;
        expect(newKey).not.toBe(source.eventKey);
        const copy = await getEvent(db, newKey);
        expect(copy).toMatchObject({
          status: "draft",
          createdBy: MOD_ID,
          agentGrantId: null,
          proofMarker: null,
          agentVersion: 1,
        });
        expect(await getEvent(db, source.eventKey)).toEqual(before);
        expect(await db.select().from(agentEventGrants)).toEqual([grant]);
        expect(await db.select().from(events)).toHaveLength(2);
        expect(await db.select().from(activityLog)).toHaveLength(1);
        expect(dispatchWriteBack).not.toHaveBeenCalled();
        expect(await fixture.client`select job_id from queue_jobs`).toEqual([]);
      },
    );

    it("duplicating a draft keeps the copy a draft and allows a blank location", async () => {
      const source = await seed({ status: "draft", location: null });
      const res = await duplicateHtml(source.eventKey, modCookie);
      expect(res.status).toBe(303);
      const copy = await getEvent(db, duplicateKey(res));
      expect(copy!.status).toBe("draft");
      expect(copy!.title).toBe(`Copy of ${source.title}`);
      expect(copy!.location).toBeNull();
      expect((await getEvent(db, source.eventKey))!.status).toBe("draft");
      expect(await db.select().from(activityLog)).toHaveLength(1);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("duplicating a cancelled event creates a draft without resurrecting the source", async () => {
      const source = await seed({ status: "cancelled" });
      const res = await duplicateHtml(source.eventKey, modCookie);
      expect(res.status).toBe(303);
      const copy = await getEvent(db, duplicateKey(res));
      expect(copy!.status).toBe("draft");
      expect(copy!.title).toBe(`Copy of ${source.title}`);
      expect((await getEvent(db, source.eventKey))!.status).toBe("cancelled");
      expect(await db.select().from(activityLog)).toHaveLength(1);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("duplicating a series parent copies one standalone draft without materializing siblings", async () => {
      const parent = await seed({
        status: "published",
        title: "Series parent",
        recurrenceFrequency: "weekly",
        recurrenceCount: 4,
        recurrenceIndex: 1,
      });
      const [child] = await db
        .insert(events)
        .values({
          eventKey: newEventKey(),
          title: "Series child",
          startsAt: new Date("2099-06-11T19:00:00.000Z"),
          endsAt: new Date("2099-06-11T21:00:00.000Z"),
          timezone: "Europe/London",
          status: "draft",
          parentEventId: parent.id,
          recurrenceIndex: 2,
        })
        .returning();

      const res = await duplicateHtml(parent.eventKey, modCookie);
      expect(res.status).toBe(303);
      const copy = await getEvent(db, duplicateKey(res));
      expect(copy!.status).toBe("draft");
      expect(copy!.parentEventId).toBeNull();
      expect(copy!.recurrenceIndex).toBeNull();
      expect(copy!.recurrenceFrequency).toBeNull();
      expect(copy!.recurrenceCount).toBeNull();
      expect(copy!.recurrenceEndsOn).toBeNull();
      // Exactly one row added: indexes 3 and 4 are not materialized.
      expect(await db.select().from(events)).toHaveLength(3);
      expect((await getEvent(db, child!.eventKey))!.parentEventId).toBe(parent.id);
      expect(await db.select().from(activityLog)).toHaveLength(1);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("duplicating a series child copies a standalone draft", async () => {
      const parent = await seed({
        status: "published",
        title: "Series parent",
        recurrenceFrequency: "weekly",
        recurrenceCount: 4,
        recurrenceIndex: 1,
      });
      const child = await seed({
        status: "draft",
        title: "Series child",
        parentEventId: parent.id,
        recurrenceIndex: 2,
      });

      const res = await duplicateHtml(child.eventKey, modCookie);
      expect(res.status).toBe(303);
      const copy = await getEvent(db, duplicateKey(res));
      expect(copy!.status).toBe("draft");
      expect(copy!.title).toBe(`Copy of ${child.title}`);
      expect(copy!.parentEventId).toBeNull();
      expect(copy!.recurrenceIndex).toBeNull();
      expect(copy!.recurrenceFrequency).toBeNull();
      expect(await db.select().from(events)).toHaveLength(3);
      expect(await db.select().from(activityLog)).toHaveLength(1);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("truncates an overlong Copy of title to the 100-character limit by code point", async () => {
      const longAscii = "T".repeat(100);
      const source = await seed({ status: "published", title: longAscii });
      const res = await duplicateHtml(source.eventKey, modCookie);
      expect(res.status).toBe(303);
      const copy = await getEvent(db, duplicateKey(res));
      expect(copy!.title).toBe(`Copy of ${"T".repeat(92)}`);
      expect([...copy!.title].length).toBe(100);

      const emojiTitle = `${"🎸".repeat(50)}${"x".repeat(50)}`;
      expect([...emojiTitle].length).toBe(100);
      const source2 = await seed({ status: "draft", title: emojiTitle });
      const res2 = await duplicateHtml(source2.eventKey, modCookie);
      expect(res2.status).toBe(303);
      const copy2 = await getEvent(db, duplicateKey(res2));
      expect(copy2!.title).toBe(`Copy of ${[...emojiTitle].slice(0, 92).join("")}`);
      expect([...copy2!.title].length).toBe(100);

      expect((await getEvent(db, source.eventKey))!.title).toBe(longAscii);
      expect((await getEvent(db, source2.eventKey))!.title).toBe(emojiTitle);
    });

    it("refuses non-moderators and guests while moderators succeed", async () => {
      // Folded by necessity: Hono runs use() middleware on unregistered paths,
      // so the 403/303 legs already answer on the base head. The moderator
      // leg is the failing-first leg that proves the route exists.
      const source = await seed({ status: "published" });
      const denied = await duplicateHtml(source.eventKey, plebCookie);
      expect(denied.status).toBe(403);
      const guest = await htmlApp().request(
        `/events/${source.eventKey}/duplicate`,
        { method: "POST" },
        htmlEnv(),
      );
      expect(guest.status).toBe(303);
      expect(guest.headers.get("location")).toContain("/auth/recover");
      expect(await db.select().from(events)).toHaveLength(1);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
      const ok = await duplicateHtml(source.eventKey, modCookie);
      expect(ok.status).toBe(303);
    });

    it("duplicate POST is same-origin gated", async () => {
      // Folded: the outer middleware 403s forged origins before routing, so
      // that leg already answers on the base head. The same-origin success
      // leg is the failing-first leg.
      const source = await seed({ status: "published" });
      const mounted = new Hono<{ Bindings: Env }>()
        .use("*", sameOrigin)
        .route("/admin", adminApp({ sessionStore: store, db }));
      const forged = await mounted.request(
        `/admin/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: { cookie: modCookie, origin: "https://evil.test" } },
        htmlEnv(),
      );
      expect(forged.status).toBe(403);
      const ok = await mounted.request(
        `/admin/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: { cookie: modCookie, origin: APP_URL } },
        htmlEnv(),
      );
      expect(ok.status).toBe(303);
    });

    it.each([
      { label: "short key", segment: "abc" },
      { label: "embedded NUL", segment: "AB%00CD" },
      { label: "oversized key", segment: "A".repeat(300) },
    ])("malformed key $label answers the panel 404 with zero mutations", async ({ segment }) => {
      const res = await htmlApp().request(
        `/events/${segment}/duplicate`,
        { method: "POST", headers: { cookie: modCookie } },
        htmlEnv(),
      );
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Event not found");
      expect(await db.select().from(events)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("unknown event key answers the panel 404 with zero mutations", async () => {
      const res = await duplicateHtml(newEventKey(), modCookie);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Event not found");
      expect(await db.select().from(events)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("refuses to duplicate a source whose stored fields fail current validation (422)", async () => {
      // Binding: the duplicate validates the copied fields against the
      // current form rules instead of cloning corrupt rows verbatim.
      const source = await seed({ status: "published", join_url: "not a url" });
      const res = await duplicateHtml(source.eventKey, modCookie);
      expect(res.status).toBe(422);
      expect(await res.text()).toContain("valid public HTTP");
      expect(await db.select().from(events)).toHaveLength(1);
      expect((await getEvent(db, source.eventKey))!.join_url).toBe("not a url");
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("JSON duplicate creates a draft copy and answers 201 with the event envelope", async () => {
      currentSession = moderatorSession;
      const source = await seed({
        status: "published",
        rsvpOpen: false,
        discordEventId: "123456789012345678",
      });
      await seedRsvps(source.id);
      const before = await getEvent(db, source.eventKey);

      const res = await jsonApp.request(
        `/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: JSON_HEADERS },
        jsonEnv(),
      );
      expect(res.status).toBe(201);
      const body = (await res.json()) as { data: Record<string, unknown> };
      expect(body.data).toMatchObject({
        status: "draft",
        title: `Copy of ${source.title}`,
        going_count: 0,
        rsvp_open: true,
        synced_to_discord: false,
      });
      const newKey = body.data.event_key as string;
      expect(newKey).not.toBe(source.eventKey);

      const copy = await getEvent(db, newKey);
      expect(copy!.status).toBe("draft");
      expect(copy!.location).toBe(source.location);
      expect(copy!.capacity).toBe(source.capacity);
      expect(copy!.organizer_name).toBe(source.organizer_name);
      expect(copy!.join_url).toBe(source.join_url);
      expect(copy!.parentEventId).toBeNull();
      expect(copy!.discordEventId).toBeNull();
      expect(await db.select().from(rsvps).where(eq(rsvps.eventId, copy!.id))).toEqual([]);
      expect(await getEvent(db, source.eventKey)).toEqual(before);
      expect(await db.select().from(events)).toHaveLength(2);

      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({ subjectType: "Event", subjectId: newKey });
      expect(audits[0]!.description).toMatch(/duplicat/i);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("JSON duplicate refuses non-moderators (403) and guests (401) with zero mutations", async () => {
      const source = await seed({ status: "published" });
      currentSession = memberSession;
      const denied = await jsonApp.request(
        `/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: JSON_HEADERS },
        jsonEnv(),
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toEqual({ error: "forbidden" });
      currentSession = null;
      const guest = await jsonApp.request(
        `/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: JSON_HEADERS },
        jsonEnv(),
      );
      expect(guest.status).toBe(401);
      expect(await guest.json()).toEqual({ error: "unauthenticated" });
      expect(await db.select().from(events)).toHaveLength(1);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("JSON duplicate answers not_found for malformed and unknown keys", async () => {
      currentSession = moderatorSession;
      for (const key of ["abc", newEventKey()]) {
        const res = await jsonApp.request(
          `/events/${key}/duplicate`,
          { method: "POST", headers: JSON_HEADERS },
          jsonEnv(),
        );
        expect(res.status, key).toBe(404);
        expect(res.headers.get("content-type"), key).toContain("application/json");
        expect(await res.json(), key).toEqual({ error: "not_found" });
      }
      expect(await db.select().from(events)).toHaveLength(0);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("JSON duplicate refuses an invalid source with the invalid shape (422)", async () => {
      currentSession = moderatorSession;
      const source = await seed({ status: "published", game: "g".repeat(101) });
      const res = await jsonApp.request(
        `/events/${source.eventKey}/duplicate`,
        { method: "POST", headers: JSON_HEADERS },
        jsonEnv(),
      );
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        error: "invalid",
        fields: { game: expect.stringContaining("100 characters") },
      });
      expect(await db.select().from(events)).toHaveLength(1);
      expect(await db.select().from(activityLog)).toEqual([]);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });
  },
);
