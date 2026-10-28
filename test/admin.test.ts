// route-inventory: GET /admin
// route-inventory: GET /admin/events
// route-inventory: GET /admin/events/new
// route-inventory: GET /admin/events/:key
// route-inventory: GET /admin/featured
// route-inventory: GET /admin/featured/new
// route-inventory: GET /admin/featured/:id
// route-inventory: POST /admin/events
// route-inventory: POST /admin/events/:key
// route-inventory: POST /admin/events/:key/publish
// route-inventory: POST /admin/events/:key/cancel
// route-inventory: POST /admin/featured
// route-inventory: POST /admin/featured/:id
// route-inventory: POST /admin/featured/:id/delete
// Canonical mounted paths; these tests also exercise adminApp at its child root.
// Admin pt1 tests (W11 M9): 403-pins + CRUD round-trips.
//
// Two layers, same seams as the site (src/index.tsx, test/app.test.ts):
// - Guard pins (memory session store, no DB): guests redirect to OAuth,
//   signed-in non-moderators 403 on every admin route shape, wrong-origin
//   POSTs 403, no store at all 503s fail-closed.
// - Live round-trips (agent-testdb, skipped without DATABASE_URL like
//   test/db.test.ts): moderator event create→publish→cancel with audit rows,
//   featured create→update→delete, admin reads emit access-log rows.
//
// The live suite truncates only the tables this slice owns, in FK-safe order.

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store-featured";
import { dispatchWriteBack } from "../src/admin/writeback";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import {
  activityLog,
  events,
  featuredContents,
  memberDataAccessLogs,
  rsvps,
} from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { users } from "../src/db/schema";
import {
  DISCARD_RE,
  EDIT_PATH,
  FORM,
  HIDDEN_RE,
  KEY,
  ROSTER_ANSWERED,
  ROSTER_IDS,
  ROSTER_NAMES,
  expectRefusedEditNotice,
  findRosterHiddenNotice,
  stripTags,
} from "./helpers/refused-edit-roster";
import { clearAuditRows } from "./helpers/audit-rows";
import {
  cookieFor as featuredCookieFor,
  env as featuredEnv,
  MEMBER,
  MODERATOR,
} from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import type { Env } from "../src/env";
import { listVisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";
import { isFeaturedImageUrl } from "../src/image-policy";
import { sameOrigin } from "../src/same-origin";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

vi.mock("../src/admin/writeback", () => ({ dispatchWriteBack: vi.fn() }));

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

/** Mint a bearer cookie for a session row seeded directly in the store. */
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

const MOD = { userId: "100000000000000111", username: "mod", moderator: true };
const PLEB = { userId: "222", username: "pleb", moderator: false };

describe("admin guard pins (memory store, no DB)", () => {
  it("redirects guests to Discord OAuth", async () => {
    const res = await adminApp(createMemorySessionStore()).request("/events", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
  });

  it("403s a signed-in non-moderator on every admin route", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    const cookie = await cookieFor(store, PLEB);
    const headers = { cookie };
    for (const path of [
      "/",
      "/events",
      "/events/new",
      "/events/abc",
      "/featured",
      "/featured/new",
      "/featured/1",
    ]) {
      const res = await app.request(path, { headers }, env);
      expect(res.status, `GET ${path}`).toBe(403);
    }
    for (const [method, path] of [
      ["POST", "/events"],
      ["POST", "/events/abc"],
      ["POST", "/events/abc/publish"],
      ["POST", "/events/abc/cancel"],
      ["POST", "/events/abc/rsvp-pause"],
      ["POST", "/events/abc/rsvp-reopen"],
      ["POST", "/featured"],
      ["POST", "/featured/1"],
      ["POST", "/featured/1/delete"],
    ] as const) {
      const res = await app.request(path, { method, headers }, env);
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });

  it("lets a moderator past the gate (dashboard renders, actor named)", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const res = await adminApp(store).request("/", { headers: { cookie } }, env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("mod");
  });

  it("403s a forged-origin POST even for a moderator", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    // Same-origin is an outer-app concern, not part of panel authorization.
    const mounted = new Hono<{ Bindings: Env }>()
      .use("*", sameOrigin)
      .route("/admin", adminApp(store));
    const res = await mounted.request(
      "/admin/events",
      {
        method: "POST",
        headers: { cookie, origin: "https://evil.test" },
        body: new URLSearchParams({ title: "x" }),
      },
      env,
    );
    expect(res.status).toBe(403);
  });

  it("503s without a session store instead of deciding open or closed", async () => {
    const res = await adminApp().request("/events", {}, env);
    expect(res.status).toBe(302); // no cookie at all → guest redirect, no decision needed
    // Well-formed bearer (two_ + 43 base64url) with nowhere to resolve → fail closed.
    // Malformed bearers are guests (302) with zero store reads.
    const forged = await serializeSigned(
      "__Host-two_session",
      `two_${"A".repeat(43)}`,
      SESSION_SECRET,
      {
        path: "/",
        secure: true,
        httpOnly: true,
        sameSite: "Lax",
      },
    );
    const denied = await adminApp().request(
      "/events",
      { headers: { cookie: forged.split(";")[0]! } },
      env,
    );
    // A bearer with nowhere to resolve → fail closed.
    expect(denied.status).toBe(503);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin round-trips (agent-testdb)", () => {
  // Roster acceptance keeps its own scoped fixture under the pre-existing DB gate.
  describe("refused event edit explains the missing roster (isolated test DB)", () => {
    let fixture: MemberDataFixture;
    let cookie: string;
    let env: Env;
    let app: Hono<{ Bindings: Env }>;
    const store = createMemorySessionStore();
    const SESSION_SECRET = "roster-refused-test-secret-at-least-32-bytes";

    // An authenticated GET rotates the session and the predecessor bearer
    // dies seconds later, so no case may inherit a cookie an earlier case
    // already spent on a GET: mint a fresh moderator session per case and
    // retain any rotated bearer a response hands back within the case.
    const mintCookie = async () => {
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "100000000000007700",
        username: "mod",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date(Date.now() + 3600_000),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
    };
    const retainCookie = (res: Response): Response => {
      const rotated = res.headers.get("set-cookie")?.match(/__Host-two_session=[^;,]+/)?.[0];
      if (rotated) cookie = rotated;
      return res;
    };

    beforeAll(async () => {
      if (!process.env.DATABASE_URL)
        throw new Error(
          "DATABASE_URL is required for the refused-edit roster DB cases; set it to a run-owned disposable test database (see README.md)",
        );
      fixture = await createMemberDataFixture(process.env.DATABASE_URL);
      env = {
        APP_URL,
        SESSION_SECRET,
        DISCORD_CLIENT_ID: "client-id",
        DISCORD_CLIENT_SECRET: "client-secret",
        DISCORD_GUILD_ID: "guild",
        DISCORD_INVITE_URL: "https://discord.gg/invite",
        DISCORD_BOT_TOKEN: "bot-token",
        ADMIN_DB: fixture.db,
      } as Env;
      app = new Hono<{ Bindings: Env }>()
        .use("*", sameOrigin)
        .route("/admin", adminApp({ sessionStore: store, db: fixture.db }));
    });
    afterAll(async () => {
      await fixture?.dispose();
    });
    beforeEach(async () => {
      await fixture.reset();
      await mintCookie();
      const [event] = await fixture.db
        .insert(events)
        .values({
          eventKey: KEY,
          title: "Stored title",
          timezone: FORM.timezone,
          status: "draft",
          startsAt: new Date("2026-11-04T20:00:00Z"),
          endsAt: new Date("2026-11-04T22:00:00Z"),
        })
        .returning();
      await fixture.db.insert(users).values([
        { id: ROSTER_IDS[0], username: ROSTER_NAMES[0] },
        { id: ROSTER_IDS[1], username: ROSTER_NAMES[1] },
      ]);
      await fixture.db.insert(rsvps).values([
        {
          eventId: event!.id,
          userId: ROSTER_IDS[0],
          status: "going",
          updatedAt: new Date(ROSTER_ANSWERED[0]!),
        },
        {
          eventId: event!.id,
          userId: ROSTER_IDS[1],
          status: "going",
          updatedAt: new Date(ROSTER_ANSWERED[1]!),
        },
      ]);
    });

    const get = async (path: string) =>
      retainCookie(await app.request(APP_URL + path, { headers: { cookie } }, env));
    const post = async (path: string, values: Record<string, string>) =>
      retainCookie(
        await app.request(
          APP_URL + path,
          {
            method: "POST",
            headers: { cookie, origin: APP_URL },
            body: new URLSearchParams(values),
          },
          env,
        ),
      );

    it("CONTROL: the plain GET edit page shows the roster and no hidden-roster notice", async () => {
      const res = await get(EDIT_PATH);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('data-testid="rsvp-roster"');
      for (const name of ROSTER_NAMES) expect(html).toContain(name);
      expect(findRosterHiddenNotice(html)).toBeNull();
      expect(stripTags(html)).not.toMatch(HIDDEN_RE);
    });

    it("a form-parse refusal (invalid start) shows the notice, leaks no roster, writes nothing", async () => {
      const eventsBefore = await fixture.db.select().from(events);
      const rsvpsBefore = await fixture.db.select().from(rsvps);
      const res = await post(EDIT_PATH, { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const notice = expectRefusedEditNotice(await res.text());
      expect(notice.href.startsWith(EDIT_PATH)).toBe(true);
      expect(await fixture.db.select().from(events)).toEqual(eventsBefore);
      expect(await fixture.db.select().from(rsvps)).toEqual(rsvpsBefore);
    });

    it("a locked-update refusal (capacity below going) shows the notice, leaks no roster, writes nothing", async () => {
      const eventsBefore = await fixture.db.select().from(events);
      const rsvpsBefore = await fixture.db.select().from(rsvps);
      // Two members are going; capacity 1 parses fine but the locked
      // update refuses it, exercising the second 422 re-render.
      const res = await post(EDIT_PATH, { ...FORM, capacity: "1" });
      expect(res.status).toBe(422);
      expectRefusedEditNotice(await res.text());
      expect(await fixture.db.select().from(events)).toEqual(eventsBefore);
      expect(await fixture.db.select().from(rsvps)).toEqual(rsvpsBefore);
    });

    it("following the notice link reloads the canonical edit page with the roster back", async () => {
      const res = await post(EDIT_PATH, { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const notice = expectRefusedEditNotice(await res.text());
      const linked = new URL(notice.href, APP_URL);
      expect(linked.pathname).toBe(EDIT_PATH);
      const reload = await get(linked.pathname + linked.search);
      expect(reload.status).toBe(200);
      const html = await reload.text();
      expect(html).toContain('data-testid="rsvp-roster"');
      for (const name of ROSTER_NAMES) expect(html).toContain(name);
      for (const answered of ROSTER_ANSWERED) expect(html).toContain(answered);
      expect(findRosterHiddenNotice(html)).toBeNull();
    });

    it("CONTROL: a create-mode refusal shows no roster-hidden notice", async () => {
      const res = await post("/admin/events", { ...FORM, starts_at: "not-a-time" });
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain('data-testid="form-errors"');
      expect(findRosterHiddenNotice(html)).toBeNull();
      const text = stripTags(html);
      expect(text).not.toMatch(HIDDEN_RE);
      expect(text).not.toMatch(DISCARD_RE);
      for (const name of ROSTER_NAMES) expect(html).not.toContain(name);
    });
  });

  // Sibling groups own their fixtures and hooks; CRUD cleanup and fake timers
  // must not wrap the unpublish cache/transaction proofs.
  describe("CRUD and access logging", () => {
    let fixture: MemberDataFixture;
    let db: Db;
    const store = createMemorySessionStore(() => Date.now());
    const modId = "100000000000000111";
    let cookie = "";
    // Sessions resolve through the memory store; admin tables through an isolated schema.
    const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
      db = fixture.db;
    });
    afterAll(() => fixture?.dispose());

    const form = (fields: Record<string, string>) => ({
      method: "POST" as const,
      headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    });

    beforeEach(async () => {
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      await db.delete(featuredContents);
      cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
      vi.clearAllMocks();
    });

    afterEach(async () => {
      vi.useRealTimers();
      await clearAuditRows(db, ["member_data_access_logs", "activity_log"]);
      await db.delete(events);
      await db.delete(featuredContents);
    });

    // Sessions resolve through the memory store; admin tables hit Postgres.
    const app = () => adminApp({ sessionStore: store, db });

    it("moderator event CRUD: create-as-draft → edit → publish → cancel, all audited", async () => {
      const create = await app().request(
        "/events",
        form({
          title: "Game night",
          game: "Chess",
          description: "Boards out",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
          location: "Voice",
          capacity: "8",
        }),
        liveEnv(),
      );
      expect(create.status).toBe(303);
      const key = new URL(create.headers.get("location")!, "https://x.test").pathname
        .split("/")
        .pop()!;

      const [draft] = await db.select().from(events).where(eq(events.eventKey, key));
      expect(draft?.status).toBe("draft");

      const edit = await app().request(
        `/events/${key}`,
        form({
          title: "Game night v2",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 23:00",
          timezone: "Europe/London",
          location: "Voice",
        }),
        liveEnv(),
      );
      expect(edit.status).toBe(303);

      const publish = await app().request(
        `/events/${key}/publish`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      );
      expect(publish.status).toBe(303);
      expect(dispatchWriteBack).toHaveBeenCalledWith(
        expect.anything(),
        { eventKey: key, status: "published" },
        undefined,
      );

      const cancel = await app().request(
        `/events/${key}/cancel`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      );
      expect(cancel.status).toBe(303);
      expect(dispatchWriteBack).toHaveBeenCalledWith(
        expect.anything(),
        { eventKey: key, status: "cancelled" },
        undefined,
      );

      const [final] = await db.select().from(events).where(eq(events.eventKey, key));
      expect(final?.status).toBe("cancelled");

      const audits = await db.select().from(activityLog);
      // create + update + publish + cancel.
      expect(audits).toHaveLength(4);
      expect(audits.map((a) => a.subjectType)).toEqual(["Event", "Event", "Event", "Event"]);
      expect(audits.map((a) => a.causerId)).toEqual([modId, modId, modId, modId]);
      // Republish of a cancelled event is refused (cancelled is terminal).
      const republish = await app().request(
        `/events/${key}/publish`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      );
      expect(republish.status).toBe(422);
    });

    it("invalid event input re-renders the form with field errors (422)", async () => {
      const res = await app().request(
        "/events",
        form({ title: "", starts_at: "nope", ends_at: "nope" }),
        liveEnv(),
      );
      expect(res.status).toBe(422);
      const html = await res.text();
      expect(html).toContain("Give the event a title.");
    });

    it("publishing a draft without a location is refused with a location field error; blanking a published location is refused", async () => {
      const LOCATION = "Add a location before publishing.";
      const create = await app().request(
        "/events",
        form({
          title: "No-location night",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
        }),
        liveEnv(),
      );
      expect(create.status).toBe(303);
      const key = new URL(create.headers.get("location")!, "https://x.test").pathname
        .split("/")
        .pop()!;
      const publish = await app().request(
        `/events/${key}/publish`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      );
      expect(publish.status).toBe(422);
      const publishHtml = await publish.text();
      expect(publishHtml).toContain(LOCATION);
      expect(publishHtml).toContain('name="location"');
      const [stillDraft] = await db.select().from(events).where(eq(events.eventKey, key));
      expect(stillDraft?.status).toBe("draft");
      expect(dispatchWriteBack).not.toHaveBeenCalled();
      // Adding a location unblocks publishing.
      const fix = await app().request(
        `/events/${key}`,
        form({
          title: "No-location night",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
          location: "Voice",
        }),
        liveEnv(),
      );
      expect(fix.status).toBe(303);
      expect(
        (
          await app().request(
            `/events/${key}/publish`,
            { method: "POST", headers: { cookie, origin: APP_URL } },
            liveEnv(),
          )
        ).status,
      ).toBe(303);
      // Blanking the published location is refused with the same field error.
      vi.clearAllMocks();
      const blank = await app().request(
        `/events/${key}`,
        form({
          title: "No-location night",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
          location: "   ",
        }),
        liveEnv(),
      );
      expect(blank.status).toBe(422);
      expect(await blank.text()).toContain(LOCATION);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("featured CRUD: create → publish toggle → reorder → delete, audited", async () => {
      const create = await app().request(
        "/featured",
        form({ title: "Slot one", body: "Hello", position: "2" }),
        liveEnv(),
      );
      expect(create.status).toBe(303);
      const id = Number(
        new URL(create.headers.get("location")!, "https://x.test").pathname.split("/").pop(),
      );

      const update = await app().request(
        `/featured/${id}`,
        form({ title: "Slot one", body: "Hello", is_published: "on", position: "0" }),
        liveEnv(),
      );
      expect(update.status).toBe(303);
      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row?.isPublished).toBe(true);
      expect(row?.position).toBe(0);

      const del = await app().request(
        `/featured/${id}/delete`,
        { method: "POST", headers: { cookie, origin: APP_URL } },
        liveEnv(),
      );
      expect(del.status).toBe(303);
      expect(
        await db.select().from(featuredContents).where(eq(featuredContents.id, id)),
      ).toHaveLength(0);

      const audits = await db.select().from(activityLog);
      expect(audits).toHaveLength(3);
    });

    it("scheduled featured content preserves links, images and UTC dates in list/edit reads", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-09-30T20:00:00Z"));
      cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
      const fields = {
        title: "Scheduled game night",
        body: "Bring your board",
        url: "https://example.test/details",
        image_url: "https://cdn.discordapp.com/attachments/board.jpg",
        image_alt: "A chess board ready for play",
        is_published: "on",
        position: "2",
        starts_at: "2026-11-04 09:05",
        ends_at: "2026-11-04 11:15",
      };
      const create = await app().request("/featured", form(fields), liveEnv());
      expect(create.status).toBe(303);
      const id = Number(
        new URL(create.headers.get("location")!, APP_URL).pathname.split("/").pop(),
      );
      expect(create.headers.get("location")).toBe(`/admin/featured/${id}`);

      const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
      expect(row).toMatchObject({
        title: fields.title,
        body: fields.body,
        url: fields.url,
        imageUrl: fields.image_url,
        imageAlt: fields.image_alt,
        isPublished: true,
        position: 2,
        startsAt: new Date("2026-11-04T09:05:00.000Z"),
        endsAt: new Date("2026-11-04T11:15:00.000Z"),
      });
      const auditsBeforeReads = await db.select().from(activityLog);
      expect(auditsBeforeReads).toHaveLength(1);

      const list = await app().request("/featured", { headers: { cookie } }, liveEnv());
      expect(list.status).toBe(200);
      const listHtml = await list.text();
      expect(listHtml).toContain(`href="/admin/featured/${id}">${fields.title}</a>`);
      expect(listHtml).toContain(
        `data-testid="featured-status-${id}"><span class="featured-status featured-status-scheduled" data-status="scheduled">scheduled</span></td>`,
      );
      expect(listHtml).toContain(`data-testid="featured-position-${id}">2</td>`);
      expect(listHtml).toContain("2026-11-04T09:05:00.000Z");
      expect(listHtml).toContain("2026-11-04T11:15:00.000Z");

      const edit = await app().request(`/featured/${id}`, { headers: { cookie } }, liveEnv());
      expect(edit.status).toBe(200);
      const editHtml = await edit.text();
      expect(editHtml).toContain('data-status="scheduled">scheduled</span>');
      expect(editHtml).not.toContain('data-testid="featured-preview-hidden"');
      expect(editHtml).toContain('data-testid="featured-item"');
      expect(editHtml).toContain(`action="/admin/featured/${id}"`);
      expect(editHtml).toContain(`action="/admin/featured/${id}/delete"`);
      expect(editHtml).toContain(`name="title" type="text" value="${fields.title}"`);
      expect(editHtml).toContain(fields.body);
      expect(editHtml).toContain(`name="url" type="url" value="${fields.url}"`);
      expect(editHtml).toContain(`name="image_url" type="url" value="${fields.image_url}"`);
      expect(editHtml).toContain(`name="image_alt" type="text" value="${fields.image_alt}"`);
      expect(editHtml).toMatch(/name="is_published"[^>]*checked/);
      expect(editHtml).toContain('name="position" type="text" inputmode="numeric" value="2"');
      expect(editHtml).toContain(
        `name="starts_at" type="text" value="${fields.starts_at}:00.000000"`,
      );
      expect(editHtml).toContain(`name="ends_at" type="text" value="${fields.ends_at}:00.000000"`);
      expect(await db.select().from(activityLog)).toEqual(auditsBeforeReads);
      expect(dispatchWriteBack).not.toHaveBeenCalled();
    });

    it("event metadata reads have no member subjects; non-moderator reads stay 403", async () => {
      await app().request(
        "/events",
        form({
          title: "Log me",
          starts_at: "2026-11-04 20:00",
          ends_at: "2026-11-04 22:00",
          timezone: "Europe/London",
        }),
        liveEnv(),
      );

      const list = await app().request("/events", { headers: { cookie } }, liveEnv());
      expect(list.status).toBe(200);
      const logs = await db.select().from(memberDataAccessLogs);
      // Event metadata is explicitly non-sensitive; event IDs are not member keys.
      expect(logs).toHaveLength(0);

      // The same read as a non-moderator 403s and logs nothing new.
      const plebCookie = await cookieFor(store, {
        userId: "pleb-live",
        username: "pleb",
        moderator: false,
      });
      const denied = await app().request("/events", { headers: { cookie: plebCookie } }, liveEnv());
      expect(denied.status).toBe(403);
      expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
    });
  });

  describe("admin featured unpublish: moderator POST sets only isPublished=false (agent-testdb)", () => {
    const env = featuredEnv;
    const cookieFor = featuredCookieFor;
    // The incident shape: a published row whose stored image host was once
    // allowed but is not on today's allowlist, so the full edit form 422s on
    // image_url and the slot cannot be pulled through the edit POST at all.
    type SeedSlot = {
      title: string;
      body: string | null;
      url: string | null;
      imageUrl: string | null;
      imageAlt: string | null;
      isPublished: boolean;
      position: number;
      startsAt: Date | null;
      endsAt: Date | null;
    };
    const STALE_SLOT: SeedSlot = {
      title: "Stale headline",
      body: "Stale body",
      url: "https://example.test/stale",
      imageUrl: "https://stale-images-public.example.net/slot.png",
      imageAlt: "Stale alt text",
      isPublished: true,
      position: 4,
      startsAt: null,
      endsAt: null,
    };
    const unpublishPath = (id: number | string) => `/featured/${id}/unpublish`;
    let fixture: MemberDataFixture;
    let sessions: SessionStore;
    let modCookie = "";
    let memberCookie = "";
    const bindings = () => ({ ...env, ADMIN_DB: fixture.db }) as EnvWithAdminDb;
    const admin = () => adminApp({ sessionStore: sessions, db: fixture.db });
    const unpublish = (id: number | string, init: { cookie?: string; body?: string } = {}) =>
      admin().request(
        unpublishPath(id),
        {
          method: "POST",
          headers: {
            cookie: init.cookie ?? modCookie,
            origin: env.APP_URL,
            // JSON negotiation pins guard refusals as 401/403, like the
            // sibling body-cap suite; a browser Accept gets the login 303.
            accept: "application/json",
            "content-type": "application/x-www-form-urlencoded",
          },
          body: init.body ?? "",
        },
        bindings(),
      );

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      sessions = createMemorySessionStore();
      modCookie = await cookieFor(sessions, MODERATOR);
      memberCookie = await cookieFor(sessions, MEMBER);
    });
    afterAll(() => fixture?.dispose());

    async function seed(slot: SeedSlot = STALE_SLOT) {
      const [seeded] = await fixture.db
        .insert(featuredContents)
        .values({ ...slot })
        .returning();
      return seeded!;
    }
    const rows = () => fixture.db.select().from(featuredContents);
    const audits = () => fixture.db.select().from(activityLog);

    it("unpublishes a published row whose stored image host fails today's full-form validation", async () => {
      // Premise: the stored host is NOT approved today, so a resubmit of the
      // whole row through parseFeaturedForm would 422 on image_url.
      expect(isFeaturedImageUrl(STALE_SLOT.imageUrl!, env.FEATURED_IMAGE_HOSTS)).toBe(false);
      const seeded = await seed();

      const res = await unpublish(seeded.id);

      expect(res.status).toBe(303);
      expect(res.headers.get("location")).toBe("/admin/featured");
      const [after] = await rows();
      expect(after).toBeDefined();
      // Only isPublished moved: every other stored value is byte-identical,
      // including the stale image host the edit form would have refused.
      expect(after).toMatchObject({ ...STALE_SLOT, isPublished: false, id: seeded.id });
      expect(after!.imageUrl).toBe(STALE_SLOT.imageUrl);
    });

    it("audits the unpublish dirty-only, under the moderator causer", async () => {
      const seeded = await seed();

      expect((await unpublish(seeded.id)).status).toBe(303);

      const logged = await audits();
      expect(logged).toHaveLength(1);
      expect(logged[0]).toMatchObject({
        logName: "default",
        subjectType: "FeaturedContent",
        subjectId: String(seeded.id),
        causerId: MODERATOR.userId,
      });
      expect(logged[0]!.description).toContain(STALE_SLOT.title);
      // Same dirty() shape as the update audit: the only changed key is
      // isPublished true -> false; no other stored field is claimed changed.
      expect(logged[0]!.properties).toEqual({
        isPublished: { before: true, after: false },
      });
    });

    it("drops the row from guest-visible reads (cache retire observed through visible read)", async () => {
      const seeded = await seed();
      const before = await listVisibleFeatured(fixture.db, new Date());
      expect(before.map((r) => r.id)).toContain(seeded.id);

      expect((await unpublish(seeded.id)).status).toBe(303);

      // The committed unpublish retires the homepage guest cache like the
      // sibling writes; the visible read no longer serves the slot.
      expect(await listVisibleFeatured(fixture.db, new Date())).toEqual([]);
    });

    it("second POST on an already-unpublished row is the pinned no-op: 303, no new audit, row unchanged", async () => {
      const seeded = await seed();
      expect((await unpublish(seeded.id)).status).toBe(303);
      expect(await audits()).toHaveLength(1);
      const [afterFirst] = await rows();

      const second = await unpublish(seeded.id);

      expect(second.status).toBe(303);
      expect(second.headers.get("location")).toBe("/admin/featured");
      expect(await audits()).toHaveLength(1);
      expect(await rows()).toEqual([afterFirst]);
    });

    it("unknown id 404s and audits nothing", async () => {
      const res = await unpublish(424242);
      expect(res.status).toBe(404);
      expect(await audits()).toHaveLength(0);
    });

    it.each(["not-an-id", "007", "0", "-1", "2147483648"])(
      "non-canonical id %s 404s and audits nothing",
      async (raw) => {
        // Seed a real published row: a non-canonical spelling must never be
        // coerced onto it (007 must not unpublish row 7, 0/-1 must not widen).
        const seeded = await seed();
        const res = await unpublish(raw);
        expect(res.status, raw).toBe(404);
        expect(await audits()).toHaveLength(0);
        const [after] = await rows();
        expect(after!.id).toBe(seeded.id);
        expect(after!.isPublished).toBe(true);
      },
    );

    it("moderator-only: guest 401 and non-moderator 403 leave the row published and unaudited", async () => {
      const seeded = await seed();
      expect((await unpublish(seeded.id, { cookie: "" })).status).toBe(401);
      expect((await unpublish(seeded.id, { cookie: memberCookie })).status).toBe(403);
      const [after] = await rows();
      expect(after!.isPublished).toBe(true);
      expect(await audits()).toHaveLength(0);
    });

    it("body-capped like the sibling action routes: oversized body is 413 and changes nothing", async () => {
      const seeded = await seed();
      const res = await unpublish(seeded.id, {
        body: `pad=${"x".repeat(BODY_LIMIT_BYTES.action + 1)}`,
      });
      expect(res.status).toBe(413);
      const [after] = await rows();
      expect(after!.isPublished).toBe(true);
      expect(await audits()).toHaveLength(0);
    });

    it("approved-host published row also unpublishes (the stale host is not the gate)", async () => {
      const seeded = await seed({
        ...STALE_SLOT,
        title: "Fresh headline",
        imageUrl: "https://cdn.discordapp.com/slot.png",
      });
      const res = await unpublish(seeded.id);
      expect(res.status).toBe(303);
      const [after] = await rows();
      expect(after!.isPublished).toBe(false);
      expect(await audits()).toHaveLength(1);
    });
  });

  describe("featured unpublish: persisted and cached invariants", () => {
    const env = featuredEnv;
    const cookieFor = featuredCookieFor;
    const NOW = new Date("2035-06-15T12:00:00Z");
    const storedSlot = {
      legacyId: "987654321",
      title: "Withdraw this stale slot",
      body: "Keep the complete stored body unchanged.",
      url: "https://example.test/old-slot",
      imageUrl: "https://retired-images.example.net/old-slot.png",
      imageAlt: "Original alternative text",
      isPublished: true,
      position: 17,
      startsAt: new Date("2001-01-02T03:04:05Z"),
      endsAt: new Date("2099-12-30T23:59:00Z"),
      createdBy: "100000000000000104",
      createdAt: new Date("2018-02-03T04:05:06Z"),
      updatedAt: new Date("2019-03-04T05:06:07Z"),
    } satisfies typeof featuredContents.$inferInsert;

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }

    let fixture: MemberDataFixture;
    let db: Db;
    let sessions: SessionStore;
    let cookie: string;
    let opens: number;
    type Gate = {
      entered: ReturnType<typeof deferred<void>>;
      release: ReturnType<typeof deferred<boolean>>;
    };
    let nextTransaction: Gate | undefined;
    const bindings = () => ({ ...env, ADMIN_DB: db }) as Env;
    const readFeatured = () =>
      cachedFeatured(
        bindings(),
        async () => {
          opens++;
          return db;
        },
        NOW,
      );
    const unpublish = async (id: number) =>
      adminApp({ sessionStore: sessions, db }).request(
        `/featured/${id}/unpublish`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: "",
        },
        bindings(),
      );
    const rows = () => fixture.db.select().from(featuredContents).orderBy(featuredContents.id);
    const audits = () => fixture.db.select().from(activityLog).orderBy(activityLog.id);
    const seed = async (overrides: Partial<typeof featuredContents.$inferInsert> = {}) => {
      const [row] = await fixture.db
        .insert(featuredContents)
        .values({ ...storedSlot, ...overrides })
        .returning();
      return row!;
    };
    const holdNextTransaction = () => {
      const gate = { entered: deferred<void>(), release: deferred<boolean>() };
      nextTransaction = gate;
      return gate;
    };

    beforeAll(async () => {
      // The enclosing admin integration gate owns database admission.
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      __resetHomeGuestCacheForTests();
      opens = 0;
      nextTransaction = undefined;
      sessions = createMemorySessionStore();
      cookie = await cookieFor(sessions, MODERATOR);
      // Gate the real session adapter: dbFor clones the Drizzle facade for
      // read observation, so replacing only db.transaction would be bypassed.
      // The callback still executes against Postgres and COMMIT/ROLLBACK stays real.
      db = fixture.db;
      const session = (db as unknown as { session: { transaction: Db["transaction"] } }).session;
      const transaction = session.transaction.bind(session);
      vi.spyOn(session, "transaction").mockImplementation((work, config) => {
        const gate = nextTransaction;
        nextTransaction = undefined;
        return transaction(async (tx) => {
          const result = await work(tx);
          if (gate) {
            gate.entered.resolve();
            if (!(await gate.release.promise)) throw new Error("Acceptance transaction rollback");
          }
          return result;
        }, config);
      });
    });
    afterEach(() => {
      __resetHomeGuestCacheForTests();
      vi.restoreAllMocks();
    });
    afterAll(() => fixture?.dispose());

    it("changes only isPublished and updatedAt in the full stored row, including provenance", async () => {
      const before = await seed();
      const first = await unpublish(before.id);
      const afterPost = new Date();
      expect(first.status).toBe(303);
      expect(first.headers.get("location")).toBe("/admin/featured");
      const afterFirst = await rows();
      expect(afterFirst).toHaveLength(1);
      expect(afterFirst[0]!.updatedAt.getTime()).toBeGreaterThan(
        new Date("2019-03-04T05:06:07Z").getTime(),
      );
      expect(afterFirst[0]!.updatedAt.getTime()).toBeLessThanOrEqual(afterPost.getTime());
      expect(afterFirst).toEqual([
        { ...before, isPublished: false, updatedAt: afterFirst[0]!.updatedAt },
      ]);
      const firstAudits = await audits();
      expect(firstAudits).toHaveLength(1);
      expect(firstAudits[0]!.properties).toEqual({ isPublished: { before: true, after: false } });

      const second = await unpublish(before.id);
      expect(second.status).toBe(303);
      expect(second.headers.get("location")).toBe("/admin/featured");
      expect(await rows()).toEqual(afterFirst);
      expect(await audits()).toEqual(firstAudits);
    });

    it("moves the withdrawn row ahead of a newer untouched row in the updated_at-sorted list", async () => {
      const withdrawn = await seed();
      const untouched = await seed({
        legacyId: null,
        title: "Untouched newer slot",
        position: 18,
        updatedAt: new Date("2024-04-05T06:07:08Z"),
      });
      const byUpdatedAt = async () =>
        (await listFeatured(db, { sort: "updated_at", order: "desc" })).map((row) => row.id);
      expect(await byUpdatedAt()).toEqual([untouched.id, withdrawn.id]);
      expect((await unpublish(withdrawn.id)).status).toBe(303);
      expect(await byUpdatedAt()).toEqual([withdrawn.id, untouched.id]);
    });

    it("keeps the warm guest entry until commit, then retires it before returning success", async () => {
      const removed = await seed();
      const survivor = await seed({ legacyId: null, title: "Still published", position: 18 });
      expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
      expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
      expect(opens).toBe(1); // The premise is a real cache hit, not a direct SQL read.

      const gate = holdNextTransaction();
      const pending = unpublish(removed.id);
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then(() => {
            throw new Error("Write returned before the commit gate");
          }),
        ]);
        expect((await readFeatured()).map((row) => row.id)).toEqual([removed.id, survivor.id]);
        expect(opens).toBe(1); // Moving retirement inside the transaction breaks this.
      } finally {
        gate.release.resolve(true);
        await pending;
      }
      expect((await pending).status).toBe(303);
      expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
      expect(opens).toBe(2); // Deleting retirement serves the withdrawn cached slot.
    });

    it("a rolled-back write preserves the stored row, audit log and warm guest entry", async () => {
      const before = await seed();
      expect((await readFeatured()).map((row) => row.id)).toEqual([before.id]);
      expect(opens).toBe(1);
      vi.spyOn(console, "error").mockImplementation(() => {});
      const gate = holdNextTransaction();
      const pending = unpublish(before.id);
      try {
        await Promise.race([
          gate.entered.promise,
          pending.then(() => {
            throw new Error("Write returned before the rollback gate");
          }),
        ]);
      } finally {
        gate.release.resolve(false);
        await pending;
      }
      expect((await pending).status).toBe(500);
      expect(await rows()).toEqual([before]);
      expect(await audits()).toEqual([]);
      expect((await readFeatured()).map((row) => row.id)).toEqual([before.id]);
      expect(opens).toBe(1);
    });

    it("an already-unpublished no-op preserves a nonempty warm guest entry without another read", async () => {
      const withdrawn = await seed({ isPublished: false });
      const survivor = await seed({ legacyId: null, title: "Still published" });
      expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
      expect(opens).toBe(1);
      expect((await unpublish(withdrawn.id)).status).toBe(303);
      expect((await readFeatured()).map((row) => row.id)).toEqual([survivor.id]);
      expect(opens).toBe(1);
      expect(await rows()).toEqual([withdrawn, survivor]);
      expect(await audits()).toEqual([]);
    });
  });
});
