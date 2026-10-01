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
import { adminApp } from "../src/admin/routes";
import { dispatchWriteBack } from "../src/admin/writeback";
import { activityLog, events, featuredContents, memberDataAccessLogs } from "../src/db/admin-schema";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import type { Env } from "../src/env";
import { sameOrigin } from "../src/same-origin";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";

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

const MOD = { userId: "111", username: "mod", moderator: true };
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
    for (const path of ["/", "/events", "/events/new", "/events/abc", "/featured", "/featured/new", "/featured/1"]) {
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
    const mounted = new Hono<{ Bindings: Env }>().use("*", sameOrigin).route("/admin", adminApp(store));
    const res = await mounted.request("/admin/events", {
      method: "POST",
      headers: { cookie, origin: "https://evil.test" },
      body: new URLSearchParams({ title: "x" }),
    }, env);
    expect(res.status).toBe(403);
  });

  it("503s without a session store instead of deciding open or closed", async () => {
    const res = await adminApp().request("/events", {}, env);
    expect(res.status).toBe(302); // no cookie at all → guest redirect, no decision needed
    const forged = await serializeSigned("__Host-two_session", "two_bogus", SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    });
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
  let fixture: MemberDataFixture;
  let db: MemberDataFixture["db"];
  beforeAll(async () => {
    // Replay every canonical migration into a guarded, owned schema (never public).
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterAll(async () => { await fixture?.dispose(); });
  const store = createMemorySessionStore();
  const modId = `admintest-mod-${Date.now()}`;
  let cookie = "";
  // Sessions resolve through the memory store; admin tables through ADMIN_DB.
  const liveEnv = { ...env, get ADMIN_DB() { return db; } } as Env;

  const form = (fields: Record<string, string>) => ({
    method: "POST" as const,
    headers: { cookie, origin: APP_URL, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });

  beforeEach(async () => {
    await db.delete(memberDataAccessLogs);
    await db.delete(activityLog);
    await db.delete(events);
    await db.delete(featuredContents);
    cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
    vi.clearAllMocks();
  });

  afterEach(async () => {
    await db.delete(memberDataAccessLogs);
    await db.delete(activityLog);
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
      liveEnv,
    );
    expect(create.status).toBe(303);
    const key = new URL(create.headers.get("location")!, "https://x.test").pathname.split("/").pop()!;

    const [draft] = await db.select().from(events).where(eq(events.eventKey, key));
    expect(draft?.status).toBe("draft");

    const edit = await app().request(
      `/events/${key}`,
      form({
        title: "Game night v2",
        starts_at: "2026-11-04 20:00",
        ends_at: "2026-11-04 23:00",
        timezone: "Europe/London",
      }),
      liveEnv,
    );
    expect(edit.status).toBe(303);

    const publish = await app().request(
      `/events/${key}/publish`,
      { method: "POST", headers: { cookie, origin: APP_URL } },
      liveEnv,
    );
    expect(publish.status).toBe(303);
    expect(dispatchWriteBack).toHaveBeenCalledWith(expect.anything(), { eventKey: key, status: "published" });

    const cancel = await app().request(
      `/events/${key}/cancel`,
      { method: "POST", headers: { cookie, origin: APP_URL } },
      liveEnv,
    );
    expect(cancel.status).toBe(303);
    expect(dispatchWriteBack).toHaveBeenCalledWith(expect.anything(), { eventKey: key, status: "cancelled" });

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
      liveEnv,
    );
    expect(republish.status).toBe(422);
  });

  it("invalid event input re-renders the form with field errors (422)", async () => {
    const res = await app().request("/events", form({ title: "", starts_at: "nope", ends_at: "nope" }), liveEnv);
    expect(res.status).toBe(422);
    const html = await res.text();
    expect(html).toContain("Give the event a title.");
  });

  it("featured CRUD: create → publish toggle → reorder → delete, audited", async () => {
    const create = await app().request("/featured", form({ title: "Slot one", body: "Hello", position: "2" }), liveEnv);
    expect(create.status).toBe(303);
    const id = Number(new URL(create.headers.get("location")!, "https://x.test").pathname.split("/").pop());

    const update = await app().request(
      `/featured/${id}`,
      form({ title: "Slot one", body: "Hello", is_published: "on", position: "0" }),
      liveEnv,
    );
    expect(update.status).toBe(303);
    const [row] = await db.select().from(featuredContents).where(eq(featuredContents.id, id));
    expect(row?.isPublished).toBe(true);
    expect(row?.position).toBe(0);

    const del = await app().request(
      `/featured/${id}/delete`,
      { method: "POST", headers: { cookie, origin: APP_URL } },
      liveEnv,
    );
    expect(del.status).toBe(303);
    expect(await db.select().from(featuredContents).where(eq(featuredContents.id, id))).toHaveLength(0);

    const audits = await db.select().from(activityLog);
    expect(audits).toHaveLength(3);
  });

  it("scheduled featured content preserves links, images and UTC dates in list/edit reads", async () => {
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
    const create = await app().request("/featured", form(fields), liveEnv);
    expect(create.status).toBe(303);
    const id = Number(new URL(create.headers.get("location")!, APP_URL).pathname.split("/").pop());
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

    const list = await app().request("/featured", { headers: { cookie } }, liveEnv);
    expect(list.status).toBe(200);
    const listHtml = await list.text();
    expect(listHtml).toContain(`href="/admin/featured/${id}">${fields.title}</a>`);
    expect(listHtml).toContain(`data-testid="featured-published-${id}">yes</td>`);
    expect(listHtml).toContain(`data-testid="featured-position-${id}">2</td>`);
    expect(listHtml).toContain("2026-11-04T09:05:00.000Z");
    expect(listHtml).toContain("2026-11-04T11:15:00.000Z");

    const edit = await app().request(`/featured/${id}`, { headers: { cookie } }, liveEnv);
    expect(edit.status).toBe(200);
    const editHtml = await edit.text();
    expect(editHtml).toContain(`action="/admin/featured/${id}"`);
    expect(editHtml).toContain(`action="/admin/featured/${id}/delete"`);
    expect(editHtml).toContain(`name="title" type="text" value="${fields.title}"`);
    expect(editHtml).toContain(fields.body);
    expect(editHtml).toContain(`name="url" type="url" value="${fields.url}"`);
    expect(editHtml).toContain(`name="image_url" type="url" value="${fields.image_url}"`);
    expect(editHtml).toContain(`name="image_alt" type="text" value="${fields.image_alt}"`);
    expect(editHtml).toMatch(/name="is_published"[^>]*checked/);
    expect(editHtml).toContain('name="position" type="text" inputmode="numeric" value="2"');
    expect(editHtml).toContain(`name="starts_at" type="text" value="${fields.starts_at}:00.000000"`);
    expect(editHtml).toContain(`name="ends_at" type="text" value="${fields.ends_at}:00.000000"`);
    expect(await db.select().from(activityLog)).toEqual(auditsBeforeReads);
    expect(dispatchWriteBack).not.toHaveBeenCalled();
  });

  it("admin reads emit access-log rows; non-moderator reads stay 403", async () => {
    await app().request(
      "/events",
      form({
        title: "Log me",
        starts_at: "2026-11-04 20:00",
        ends_at: "2026-11-04 22:00",
        timezone: "Europe/London",
      }),
      liveEnv,
    );

    const list = await app().request("/events", { headers: { cookie } }, liveEnv);
    expect(list.status).toBe(200);
    const logs = await db.select().from(memberDataAccessLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.resource).toBe("events");
    expect(logs[0]?.action).toBe("list");
    expect(logs[0]?.route).toBe("admin.events.index");
    expect(logs[0]?.subjectCount).toBe(1);
    expect(logs[0]?.viewerDiscordId).toBe(modId);

    // The same read as a non-moderator 403s and logs nothing new.
    const plebCookie = await cookieFor(store, { userId: "pleb-live", username: "pleb", moderator: false });
    const denied = await app().request("/events", { headers: { cookie: plebCookie } }, liveEnv);
    expect(denied.status).toBe(403);
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(1);
  });
});
