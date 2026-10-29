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

import { asc, eq, sql } from "drizzle-orm";
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EnvWithAdminDb } from "../src/admin/db";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store-featured";
import {
  deleteFeatured,
  featuredSaveBaseline,
  getFeatured,
  StaleFeaturedSaveError,
  unpublishFeatured,
  updateFeatured,
} from "../src/admin/store";
import { parseFeaturedForm } from "../src/admin/validation";
import { compileKitForms } from "./helpers/admin-validation-correction";
import { compileFeaturedSaveLoad } from "./helpers/featured-save-kit-load";
import { draftFields, reviewCurrentHref, savedForm } from "./helpers/featured-save-document";
import { dispatchWriteBack } from "../src/admin/writeback";
import { BODY_LIMIT_BYTES } from "../src/body-limit";
import {
  activityLog,
  events,
  featuredContents,
  memberDataAccessLogs,
} from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { clearAuditRows } from "./helpers/audit-rows";
import { featuredBaselineFields } from "./helpers/featured-baseline";
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
  // Sibling groups own their fixtures and hooks; CRUD cleanup and fake timers
  // must not wrap the featured cache/transaction or stale-save proofs.
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
        form({
          ...(await featuredBaselineFields(db, id)),
          title: "Slot one",
          body: "Hello",
          is_published: "on",
          position: "0",
        }),
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

  // Independent form-save acceptance. The low-level unconditional update contract
  // remains covered by featured-write-concurrency.test.ts, without modification.
  describe("featured stale Save acceptance (disposable Postgres)", () => {
    const env: Env = {
      APP_URL: "https://next.example.test",
      DISCORD_CLIENT_ID: "client-id",
      DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_GUILD_ID: "guild-id",
      DISCORD_INVITE_URL: "https://discord.gg/invite",
      DISCORD_BOT_TOKEN: "bot-token",
      SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
    };
    const preciseStart = "2026-10-01 12:34:56.789123";
    const preciseEnd = "2026-11-01 13:45:12.345678";
    const completeDraft = {
      title: '  B headline & "quoted" <draft>  ',
      body: " B paragraph & <not markup>\nSecond line with 'quotes' ",
      url: "https://example.test/draft?a=1&b=2",
      image_url: "https://cdn.discordapp.com/attachments/draft.png",
      image_alt: ' Draft image & "alt" ',
      position: "17",
      starts_at: "2026-10-02 12:34:56.789124",
      ends_at: "2026-11-02 13:45:12.345679",
      is_published: "on",
    };

    let fixture: MemberDataFixture;
    let admin: ReturnType<typeof adminApp>;
    let cookie: string;
    let id: number;

    let kit: Awaited<ReturnType<typeof compileKitForms>>;
    let kitLoad: Awaited<ReturnType<typeof compileFeaturedSaveLoad>>;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 3 });
      await fixture.client`SET TIME ZONE 'UTC'`;
      kit = await compileKitForms();
      kitLoad = await compileFeaturedSaveLoad(env);
    });
    afterAll(async () => {
      kit?.dispose();
      await fixture?.dispose();
    });
    afterEach(() => {
      vi.useRealTimers();
      __resetHomeGuestCacheForTests();
    });
    beforeEach(async () => {
      __resetHomeGuestCacheForTests();
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      const [row] = await fixture.db
        .insert(featuredContents)
        .values({
          title: "Original headline",
          body: "Original body",
          position: 2,
          isPublished: true,
          imageUrl: "https://cdn.discordapp.com/attachments/original.png",
          imageAlt: "Original alt",
        })
        .returning();
      id = row!.id;
      await fixture.client`UPDATE featured_contents SET starts_at = ${preciseStart}::timestamptz,
        ends_at = ${preciseEnd}::timestamptz WHERE id = ${id}`;
      const store = createMemorySessionStore();
      const token = newSessionToken();
      await store.create({
        tokenHash: await hashToken(token),
        userId: "333333333333333333",
        username: "moderator",
        avatar: null,
        member: true,
        moderator: true,
        expiresAt: new Date("2035-01-01T00:00:00Z"),
      });
      cookie = (
        await serializeSigned("__Host-two_session", token, env.SESSION_SECRET, {
          path: "/",
          secure: true,
          httpOnly: true,
          sameSite: "Lax",
        })
      ).split(";")[0]!;
      admin = adminApp({ sessionStore: store, db: fixture.db });
    });

    const bindings = (): EnvWithAdminDb => ({ ...env, ADMIN_DB: fixture.db });
    const read = async (href = `/admin/featured/${id}`) => {
      const response = await admin.request(
        href.replace(/^\/admin/, ""),
        { headers: { cookie } },
        bindings(),
      );
      expect(response.status).toBe(200);
      return savedForm(await response.text());
    };
    const save = async (fields: Record<string, string>) =>
      admin.request(
        `/featured/${id}`,
        {
          method: "POST",
          headers: {
            cookie,
            origin: env.APP_URL,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams(fields),
        },
        bindings(),
      );
    const state = async () => {
      const [row] = await fixture.client`SELECT *, starts_at::text AS precise_start,
        ends_at::text AS precise_end FROM featured_contents WHERE id = ${id}`;
      const audits = await fixture.db.select().from(activityLog).orderBy(asc(activityLog.id));
      return { row, audits };
    };
    const conflict = async (response: Response, draft: Record<string, string>) => {
      expect.soft(response.status, "a stale Save is not a redirect/success").toBe(409);
      expect.soft(response.headers.get("cache-control")).toMatch(/private/);
      expect.soft(response.headers.get("cache-control")).toMatch(/no-store/);
      if (response.status !== 409) return null;
      const html = await response.text();
      const form = savedForm(html);
      expect(draftFields(form.fields)).toEqual(draftFields(draft));
      expect(html).not.toMatch(/http-equiv=["']refresh/i);
      reviewCurrentHref(html, id);
      return { html, form };
    };

    it("renders a nonempty saved-content precondition on the actual Hono Save form", async () => {
      const document = await read();
      expect(document.attrs.method?.toLowerCase()).toBe("post");
      expect(document.attrs.action).toBe(`/admin/featured/${id}`);
      expect(Object.values(document.hidden).some((value) => value.length > 0)).toBe(true);
      expect(draftFields(document.fields)).toMatchObject({
        title: "Original headline",
        body: "Original body",
        starts_at: preciseStart,
        ends_at: preciseEnd,
      });
    });

    it.each([true, false])(
      "A survives B's complete stale draft, repeat Save and explicit fresh review (published=%s)",
      async (published) => {
        const a = await read();
        const b = await read();
        expect((await save({ ...a.fields, title: "A committed headline" })).status).toBe(303);
        const committed = await state();
        const draft: Record<string, string> = { ...b.fields, ...completeDraft };
        if (!published) delete draft.is_published;
        const rejected = await conflict(await save(draft), draft);
        expect
          .soft(await state(), "stale refusal leaves content and all audit rows untouched")
          .toEqual(committed);
        if (!rejected) return;
        // Re-render must carry B's original baseline, never one minted from A.
        expect(rejected.form.hidden).toEqual(b.hidden);
        await conflict(await save(rejected.form.fields), draft);
        expect(await state()).toEqual(committed);
        const fresh = await read(reviewCurrentHref(rejected.html, id));
        expect(fresh.fields.title).toBe("A committed headline");
        expect(fresh.hidden).not.toEqual(b.hidden);
        const response = await save({ ...fresh.fields, title: "Reviewed then edited" });
        expect(response.status).toBe(303);
        expect(response.headers.get("location")).toBe(`/admin/featured/${id}`);
        const final = await state();
        expect(final.row!.title).toBe("Reviewed then edited");
        expect(final.audits).toHaveLength(2);
        expect(final.audits[1]!.properties).toMatchObject({
          title: { before: "A committed headline", after: "Reviewed then edited" },
        });
      },
    );

    it.each(["missing", "malformed", "empty"])(
      "cannot bypass the form precondition with a %s baseline",
      async (kind) => {
        const document = await read();
        const fields: Record<string, string> = { ...document.fields, ...completeDraft };
        const names = Object.keys(document.hidden);
        for (const name of names) {
          if (kind === "missing") delete fields[name];
          else fields[name] = kind === "empty" ? "" : "not-a-saved-content-baseline";
        }
        // On the old document no baseline is rendered at all: exercise the actual
        // unprotected POST too, rather than failing only at a missing selector.
        if (!names.length && kind !== "missing")
          fields.saved_baseline = kind === "empty" ? "" : "not-a-saved-content-baseline";
        const before = await state();
        const response = await save(fields);
        expect
          .soft([400, 409, 422], "invalid preconditions are never treated as unconditional writes")
          .toContain(response.status);
        expect.soft(await state()).toEqual(before);
        if (response.status >= 400 && response.status < 500) {
          expect(response.headers.get("cache-control")).toMatch(
            /private.*no-store|no-store.*private/,
          );
          const html = await response.text();
          expect(draftFields(savedForm(html).fields)).toEqual(draftFields(fields));
          reviewCurrentHref(html, id);
          const repeated = await save(savedForm(html).fields);
          expect(
            [400, 409, 422],
            "rejected input cannot acquire a current baseline on retry",
          ).toContain(repeated.status);
          expect(await state()).toEqual(before);
        }
      },
    );

    it.each([
      ["title", "Concurrent title"],
      ["body", "Concurrent body"],
      ["url", "https://example.test/concurrent"],
      ["image_url", "https://cdn.discordapp.com/attachments/concurrent.png"],
      ["image_alt", "Concurrent alt"],
      ["position", "9"],
      ["is_published", ""],
      ["starts_at", "2026-10-01 12:34:56.789124"],
      ["ends_at", "2026-11-01 13:45:12.345679"],
    ])(
      "detects a changed %s even when updated_at shares the same JavaScript millisecond",
      async (field, value) => {
        const instant = new Date("2026-10-20T12:00:00.123Z");
        await fixture.client`UPDATE featured_contents SET updated_at = ${instant.toISOString()}::timestamptz WHERE id = ${id}`;
        const a = await read();
        const b = await read();
        vi.useFakeTimers({ toFake: ["Date"] });
        vi.setSystemTime(instant);
        const first = { ...a.fields, [field]: value };
        if (field === "is_published") delete first.is_published;
        expect((await save(first)).status).toBe(303);
        const committed = await state();
        expect(new Date(committed.row!.updated_at).getTime()).toBe(instant.getTime());
        await conflict(await save({ ...b.fields, title: "B must not restore old content" }), {
          ...b.fields,
          title: "B must not restore old content",
        });
        expect.soft(await state()).toEqual(committed);
      },
    );

    it("retains the original baseline through 422 correction instead of silently rebasing a stale draft", async () => {
      const a = await read();
      const b = await read();
      const rejected = await save({ ...b.fields, ...completeDraft, title: "" });
      expect(rejected.status).toBe(422);
      const correction = savedForm(await rejected.text());
      expect(correction.hidden).toEqual(b.hidden);
      expect(draftFields(correction.fields)).toEqual(
        draftFields({ ...b.fields, ...completeDraft, title: "" }),
      );
      expect((await state()).audits).toHaveLength(0);
      expect((await save({ ...a.fields, title: "A during B correction" })).status).toBe(303);
      const committed = await state();
      const corrected = { ...correction.fields, title: "B corrected" };
      await conflict(await save(corrected), corrected);
      expect.soft(await state()).toEqual(committed);
    });

    it("fresh correction still normalizes inputs, preserves microseconds and audits once", async () => {
      const document = await read();
      const invalid = await save({ ...document.fields, ...completeDraft, title: "" });
      expect(invalid.status).toBe(422);
      const retry = savedForm(await invalid.text());
      const response = await save({ ...retry.fields, title: "  Corrected headline  " });
      expect(response.status).toBe(303);
      const result = await state();
      expect(result.row).toMatchObject({
        title: "Corrected headline",
        position: 17,
        precise_start: "2026-10-02 12:34:56.789124+00",
        precise_end: "2026-11-02 13:45:12.345679+00",
      });
      expect(result.audits).toHaveLength(1);
      expect(result.audits[0]!.properties).toMatchObject({
        title: { before: "Original headline", after: "Corrected headline" },
      });
    });

    it("returns 404 after deletion rather than resurrecting a draft or inserting a mutation audit", async () => {
      const document = await read();
      await fixture.db.delete(featuredContents).where(eq(featuredContents.id, id));
      expect((await save({ ...document.fields, ...completeDraft })).status).toBe(404);
      expect(await state()).toEqual({ row: undefined, audits: [] });
    });

    it("Kit load renders a real precondition and its native POST participates in Hono conflict/review recovery", async () => {
      const headers: Record<string, string> = {};
      const data = await kitLoad(fixture.db, id, (value) => Object.assign(headers, value));
      expect(headers["Cache-Control"] ?? headers["cache-control"]).toMatch(
        /private.*no-store|no-store.*private/,
      );
      const kitDocument = savedForm(kit.renderForm(3, data));
      expect.soft(Object.values(kitDocument.hidden).some((value) => value.length > 0)).toBe(true);
      expect(kitDocument.attrs.method?.toLowerCase()).toBe("post");
      expect(kitDocument.attrs.action).toBe(`/admin/featured/${id}`);
      expect(draftFields(kitDocument.fields)).toMatchObject({
        title: "Original headline",
        starts_at: preciseStart,
        ends_at: preciseEnd,
      });
      // A Kit-loaded form can save through Hono, without a Kit mutation endpoint.
      const honoDocument = await read();
      expect((await save({ ...kitDocument.fields, title: "Kit committed headline" })).status).toBe(
        303,
      );
      const committed = await state();
      const draft = { ...honoDocument.fields, ...completeDraft };
      await conflict(await save(draft), draft);
      expect.soft(await state()).toEqual(committed);
      const freshData = await kitLoad(fixture.db, id, () => {});
      const fresh = savedForm(kit.renderForm(3, freshData));
      expect(fresh.fields.title).toBe("Kit committed headline");
      expect.soft(fresh.hidden).not.toEqual(kitDocument.hidden);
      expect((await save({ ...fresh.fields, title: "Fresh Kit edit" })).status).toBe(303);
    });

    it("does not retire a warmed homepage cache on conflict, but does on a successful Save", async () => {
      const b = await read();
      const visible = () =>
        cachedFeatured(
          bindings(),
          async () => fixture.db,
          new Date("2026-10-20T12:00:00Z"),
          undefined,
        );
      expect((await visible()).map((row) => row.title)).toContain("Original headline");
      expect((await save({ ...b.fields, title: "A visible headline" })).status).toBe(303);
      const warm = await visible();
      expect(warm.map((row) => row.title)).toContain("A visible headline");
      // A direct fixture write deliberately does not retire. If the refused POST
      // retires anyway, the next cache read exposes this sentinel body.
      await fixture.client`UPDATE featured_contents SET body = 'unretired cache sentinel' WHERE id = ${id}`;
      const committed = await state();
      const draft: Record<string, string> = { ...b.fields, ...completeDraft };
      await conflict(await save(draft), draft);
      expect.soft(await state()).toEqual(committed);
      expect
        .soft(await visible(), "refusal must not evict a valid existing cache generation")
        .toEqual(warm);
    });

    it.each(["commit", "rollback", "delete"] as const)(
      "checks the form baseline after the held committing lock resolves (%s)",
      async (outcome) => {
        const b = await read();
        const actor = { id: "444444444444444444", username: "other moderator" };
        let pending: Promise<Response> | undefined;
        let settled = false;
        const rollback = new Error("intentional fixture rollback");
        try {
          try {
            await fixture.db.transaction(async (tx) => {
              const [holder] = await tx.execute<{ pid: number }>(
                sql`select pg_backend_pid() as pid`,
              );
              if (outcome === "delete") await deleteFeatured(tx as unknown as Db, actor, id);
              else
                await updateFeatured(
                  tx as unknown as Db,
                  actor,
                  id,
                  parseFeaturedForm({ ...b.fields, title: "Held A headline" }),
                );
              pending = save({ ...b.fields, title: "Waiting B headline" });
              void pending.then(
                () => {
                  settled = true;
                },
                () => {
                  settled = true;
                },
              );
              const deadline = performance.now() + 3000;
              let observed = false;
              while (performance.now() < deadline) {
                const rows = await fixture.client`select pid from pg_stat_activity
                where datname = current_database() and wait_event_type = 'Lock'
                  and ${holder!.pid} = any(pg_blocking_pids(pid))`;
                if (rows.length) {
                  observed = true;
                  break;
                }
              }
              expect(
                observed,
                "independent observer saw B blocked on A's actual PostgreSQL lock",
              ).toBe(true);
              expect(settled).toBe(false);
              if (outcome === "rollback") throw rollback;
            });
          } catch (error) {
            if (error !== rollback) throw error;
          }
          const response = await pending!;
          const result = await state();
          if (outcome === "commit") {
            await conflict(response, { ...b.fields, title: "Waiting B headline" });
            expect.soft(result.row!.title).toBe("Held A headline");
            expect.soft(result.audits).toHaveLength(1);
            expect(result.row!.precise_start).toBe(`${preciseStart}+00`);
            expect(result.row!.precise_end).toBe(`${preciseEnd}+00`);
          } else if (outcome === "delete") {
            expect(response.status).toBe(404);
            expect(result.row).toBeUndefined();
            expect(result.audits).toHaveLength(1);
          } else {
            expect(response.status).toBe(303);
            expect(result.row!.title).toBe("Waiting B headline");
            expect(result.audits).toHaveLength(1);
            expect(result.audits[0]!.properties).toMatchObject({
              title: { before: "Original headline", after: "Waiting B headline" },
            });
          }
        } finally {
          // Drain the contender after the holder's transaction releases on every
          // assertion/error path; never leave an orphan operation between tests.
          await pending;
        }
      },
    );

    it("a failed audit rolls back the save without consuming its baseline, then permits a fresh retry", async () => {
      const document = await read();
      const [sentinel] = await fixture.db
        .insert(featuredContents)
        .values({
          title: "Sibling cache sentinel",
          body: "Cached sibling body",
          isPublished: true,
          position: 99,
        })
        .returning();
      const visible = () =>
        cachedFeatured(
          bindings(),
          async () => fixture.db,
          new Date("2026-10-20T12:00:00Z"),
          undefined,
        );
      const warm = await visible();
      await fixture.client`UPDATE featured_contents SET body = 'unretired sibling body' WHERE id = ${sentinel!.id}`;
      const before = await state();
      const schema = fixture.schemaName;
      await fixture.client.unsafe(`CREATE FUNCTION "${schema}".reject_featured_save_audit()
        RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
        RAISE EXCEPTION 'synthetic featured save audit failure'; END; $$;
        CREATE TRIGGER reject_featured_save_audit BEFORE INSERT ON "${schema}".activity_log
        FOR EACH ROW WHEN (NEW.subject_type = 'FeaturedContent')
        EXECUTE FUNCTION "${schema}".reject_featured_save_audit();`);
      try {
        const response = await save({ ...document.fields, title: "Must roll back" });
        expect(response.status).toBeGreaterThanOrEqual(500);
        expect(await state()).toEqual(before);
        expect(await visible(), "rollback must not retire the existing homepage cache").toEqual(
          warm,
        );
      } finally {
        await fixture.client.unsafe(
          `DROP TRIGGER reject_featured_save_audit ON "${schema}".activity_log;
           DROP FUNCTION "${schema}".reject_featured_save_audit()`,
        );
      }
      expect((await save({ ...document.fields, title: "Retry after rollback" })).status).toBe(303);
      expect((await state()).audits).toHaveLength(1);
    });
  });

  describe("featured form incarnation (disposable Postgres)", () => {
    const actor = { id: "333333333333333333", username: "moderator" };
    let fixture: MemberDataFixture;
    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(async () => {
      vi.useRealTimers();
      await fixture?.dispose();
    });

    it("refuses the original baseline after publish then Unpublish restores identical content", async () => {
      const [seed] = await fixture.db
        .insert(featuredContents)
        .values({
          title: "Originally unpublished",
          isPublished: false,
          position: 0,
        })
        .returning();
      const id = seed!.id;
      const original = (await getFeatured(fixture.db, id))!;
      const baseline = await featuredSaveBaseline(original);
      const input = parseFeaturedForm({ title: original.title, position: "0", is_published: "on" });
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-28T12:00:00.123Z"));
      await updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline });
      await expect(
        updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline }),
      ).rejects.toBeInstanceOf(StaleFeaturedSaveError);
      await unpublishFeatured(fixture.db, actor, id);
      const withdrawn = (await getFeatured(fixture.db, id))!;
      expect(withdrawn.isPublished).toBe(false);
      expect(await featuredSaveBaseline(withdrawn)).not.toBe(baseline);
      await expect(
        updateFeatured(fixture.db, actor, id, input, { expectedBaseline: baseline }),
      ).rejects.toBeInstanceOf(StaleFeaturedSaveError);
      expect((await getFeatured(fixture.db, id))!.isPublished).toBe(false);
      // Explicit fresh review is still allowed after the withdrawal.
      await updateFeatured(fixture.db, actor, id, input, {
        expectedBaseline: await featuredSaveBaseline(withdrawn),
      });
      expect((await getFeatured(fixture.db, id))!.isPublished).toBe(true);
      vi.useRealTimers();
    });

    it("carries the locked conflicting snapshot without requiring a second database read", async () => {
      const [seed] = await fixture.db
        .insert(featuredContents)
        .values({
          title: "Before",
          isPublished: false,
          position: 0,
        })
        .returning();
      const id = seed!.id;
      const baseline = await featuredSaveBaseline((await getFeatured(fixture.db, id))!);
      await updateFeatured(
        fixture.db,
        actor,
        id,
        parseFeaturedForm({ title: "Committed successor" }),
      );
      const error = await updateFeatured(
        fixture.db,
        actor,
        id,
        parseFeaturedForm({ title: "Draft" }),
        {
          expectedBaseline: baseline,
        },
      ).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(StaleFeaturedSaveError);
      expect(error).toHaveProperty("current.title", "Committed successor");
      expect((await getFeatured(fixture.db, id))!.title).toBe("Committed successor");
    });
  });
});
