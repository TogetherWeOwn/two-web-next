// route-inventory: POST /events/:key/rsvp-pause
// route-inventory: POST /events/:key/rsvp-reopen
// route-inventory: POST /admin/events/:key/rsvp-pause
// route-inventory: POST /admin/events/:key/rsvp-reopen
// Moderator pause/reopen uses the member RSVP lock and the existing sync seam.
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import app from "../src/index";
import { setRsvpOpen } from "../src/admin/store";
import { newEventKey, ValidationError } from "../src/admin/validation";
import { activityLog, events, rsvps } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import type { SyncMessage } from "../src/events/sync";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const store = createMemorySessionStore();
const baseEnv = {
  APP_URL, SESSION_SECRET, SESSION_STORE: store,
  DISCORD_CLIENT_ID: "client-id", DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite", DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
} as Env;
const actor = { id: "toggle-mod", username: "mod" };

async function cookie(moderator = true) {
  const token = newSessionToken();
  const userId = moderator ? actor.id : "toggle-member";
  await store.create({ tokenHash: await hashToken(token), userId, username: userId,
    avatar: null, member: true, moderator, expiresAt: new Date(Date.now() + 3600_000) });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET,
    { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

const paths = ["/events/abc/rsvp-pause", "/events/abc/rsvp-reopen", "/admin/events/abc/rsvp-pause", "/admin/events/abc/rsvp-reopen"];

describe("RSVP toggle guards (no database)", () => {
  it("keeps guest, member and origin conventions on both route families", async () => {
    for (const path of paths) {
      const guest = await app.request(path, { method: "POST", headers: { origin: APP_URL } }, baseEnv);
      expect((await app.request(path, { method: "POST" }, baseEnv)).status, path).toBe(403);
      expect(guest.status, path).toBe(path.startsWith("/admin/") ? 302 : 401);
      if (path.startsWith("/admin/")) expect(guest.headers.get("location")).toBe("/auth/discord");
      expect((await app.request(path, { method: "POST", headers: { cookie: await cookie(false), origin: APP_URL } }, baseEnv)).status, path).toBe(403);
      expect((await app.request(path, { method: "POST", headers: { cookie: await cookie(), origin: "https://evil.test" } }, baseEnv)).status, path).toBe(403);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("RSVP pause/reopen (isolated agent-testdb schema)", () => {
  let fixture: MemberDataFixture;
  const sent: SyncMessage[] = [];
  const env = { ...baseEnv, get ADMIN_DB() { return fixture.db; },
    EVENT_SYNC_QUEUE: { send: async (m: SyncMessage) => void sent.push(m) } } as unknown as Env;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 10 }); });
  beforeEach(async () => {
    await fixture.reset();
    await fixture.client`delete from web_throttle_hits`;
    sent.length = 0;
  });
  afterAll(async () => { await fixture?.dispose(); });

  const seed = async (over: Partial<typeof events.$inferInsert> = {}) => {
    const [row] = await fixture.db.insert(events).values({ eventKey: newEventKey(), title: "Toggle night",
      startsAt: new Date("2099-01-01T20:00:00Z"), endsAt: new Date("2099-01-01T22:00:00Z"), status: "published", ...over }).returning();
    return row!;
  };
  const request = async (path: string, method = "POST", moderator = true, body?: unknown) => app.request(path,
    { method, headers: { cookie: await cookie(moderator), origin: APP_URL, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) }, env);
  const audits = () => fixture.db.select().from(activityLog);

  it("pauses idempotently, preserves answers, returns paused, and reopens member writes", async () => {
    const row = await seed();
    const path = `/events/${row.eventKey}`;
    expect((await request(`${path}/rsvp`, "PUT", false, { status: "going" })).status).toBe(201);
    sent.length = 0;
    const pause = await request(`${path}/rsvp-pause`);
    expect(pause.status).toBe(200);
    expect(await pause.json()).toMatchObject({ data: { event_key: row.eventKey, status: "published", rsvp_open: false, going_count: 1 } });
    const paused = await request(`${path}/rsvp`, "PUT", false, { status: "maybe" });
    expect(paused.status).toBe(403);
    expect(await paused.json()).toMatchObject({ reason: "event_not_open", why: "paused" });
    expect((await fixture.db.select().from(rsvps)).map((r) => r.status)).toEqual(["going"]);
    const [beforeRepeat] = await fixture.db.select().from(events);
    const repeatPause = await request(`${path}/rsvp-pause`);
    expect(repeatPause.status).toBe(200);
    expect(await repeatPause.json()).toMatchObject({ data: { rsvp_open: false, going_count: 1 } });
    const [afterRepeat] = await fixture.db.select().from(events);
    expect(afterRepeat!.updatedAt).toEqual(beforeRepeat!.updatedAt);
    expect(sent).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
    const reopen = await request(`${path}/rsvp-reopen`);
    expect(reopen.status).toBe(200);
    expect(await reopen.json()).toMatchObject({ data: { rsvp_open: true, status: "published", going_count: 1 } });
    const repeatReopen = await request(`${path}/rsvp-reopen`);
    expect(repeatReopen.status).toBe(200);
    expect(await repeatReopen.json()).toMatchObject({ data: { rsvp_open: true, going_count: 1 } });
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.eventKey === row.eventKey && m.action === "event.upsert")).toBe(true);
    expect(sent[0]!.idempotencyKey).not.toBe(sent[1]!.idempotencyKey);
    expect((await audits()).map((a) => a.properties)).toEqual([
      { rsvpOpen: { before: true, after: false } }, { rsvpOpen: { before: false, after: true } },
    ]);
    expect((await request(`${path}/rsvp`, "PUT", false, { status: "maybe" })).status).toBe(200);
  });

  it("counts only this event's going answers, including zero, on changed and no-op responses", async () => {
    const row = await seed();
    const other = await seed();
    await fixture.db.insert(rsvps).values([
      ...["maybe", "not_going", "waitlisted"].map((status) => ({ eventId: row.id, userId: status, status })),
      { eventId: other.id, userId: "other-going", status: "going" },
    ]);
    for (const action of ["rsvp-pause", "rsvp-pause", "rsvp-reopen", "rsvp-reopen"]) {
      const res = await request(`/events/${row.eventKey}/${action}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { going_count: 0 } });
    }
    await fixture.db.insert(rsvps).values([
      { eventId: row.id, userId: "going-1", status: "going" },
      { eventId: row.id, userId: "going-2", status: "going" },
    ]);
    for (const action of ["rsvp-pause", "rsvp-pause", "rsvp-reopen", "rsvp-reopen"]) {
      const res = await request(`/events/${row.eventKey}/${action}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ data: { going_count: 2 } });
    }
  });

  it("refuses draft, cancelled, past and clock-ended events, including already-satisfied targets", async () => {
    for (const over of [{ status: "draft" }, { status: "cancelled" }, { status: "past" },
      { endsAt: new Date("2020-01-01T22:00:00Z") }]) {
      const row = await seed(over);
      for (const action of ["rsvp-pause", "rsvp-reopen"]) {
        const json = await request(`/events/${row.eventKey}/${action}`);
        expect(json.status).toBe(422);
        expect(await json.json()).toMatchObject({ error: "invalid", fields: { rsvp_open: expect.any(String) } });
        const admin = await request(`/admin/events/${row.eventKey}/${action}`);
        expect(admin.status).toBe(422);
        expect(await admin.text()).toContain("Only published events that have not ended");
      }
    }
    const boundary = await seed();
    await expect(setRsvpOpen(fixture.db, actor, boundary.eventKey, false, () => boundary.endsAt)).rejects.toBeInstanceOf(ValidationError);
    expect(await audits()).toHaveLength(0);
    expect(sent).toHaveLength(0);
    for (const path of paths) expect((await request(path)).status).toBe(404);
  });

  it("serializes concurrent identical toggles into one audit and one dispatch", async () => {
    const row = await seed();
    const responses = await Promise.all(Array.from({ length: 6 }, () => request(`/events/${row.eventKey}/rsvp-pause`)));
    expect(responses.map((r) => r.status)).toEqual(Array(6).fill(200));
    expect(sent).toHaveLength(1);
    expect(await audits()).toHaveLength(1);
  });

  it("admin actions redirect and both pages show the current action only for eligible events", async () => {
    const row = await seed();
    const get = async (path: string) => (await request(path, "GET")).text();
    expect(await get(`/admin/events/${row.eventKey}`)).toContain(`action="/admin/events/${row.eventKey}/rsvp-pause"`);
    expect(await get("/admin/events")).toContain(`action="/admin/events/${row.eventKey}/rsvp-pause"`);
    const pause = await request(`/admin/events/${row.eventKey}/rsvp-pause`);
    expect(pause.status).toBe(303);
    expect(pause.headers.get("location")).toBe(`/admin/events/${row.eventKey}`);
    const edit = await get(`/admin/events/${row.eventKey}`);
    expect(edit).toContain("Reopen RSVPs");
    expect(edit).not.toContain("Pause RSVPs");
    expect(await get("/admin/events")).toContain(`action="/admin/events/${row.eventKey}/rsvp-reopen"`);
    expect((await request(`/admin/events/${row.eventKey}/rsvp-pause`)).status).toBe(303);
    expect(sent).toHaveLength(1);
    expect((await request(`/admin/events/${row.eventKey}/rsvp-reopen`)).status).toBe(303);
    expect(sent).toHaveLength(2);
    for (const over of [{ status: "draft" }, { status: "cancelled" }, { status: "past" },
      { endsAt: new Date("2020-01-01T22:00:00Z") }]) {
      const hidden = await seed(over);
      expect(await get(`/admin/events/${hidden.eventKey}`)).not.toMatch(/\/rsvp-(pause|reopen)/);
      expect(await get("/admin/events")).not.toMatch(new RegExp(`${hidden.eventKey}/rsvp-(pause|reopen)`));
    }
  });

  it("filters open, paused and all, composing RSVP state with search and status", async () => {
    await seed({ title: "Chess open" });
    await seed({ title: "Chess paused", rsvpOpen: false });
    await seed({ title: "Chess draft", status: "draft", rsvpOpen: false });
    await seed({ title: "Poker paused", rsvpOpen: false });
    const titles = async (query: string) => {
      const html = await (await request(`/admin/events${query}`, "GET")).text();
      return { html, values: [...html.matchAll(/<a href="\/admin\/events\/[^\"]+">([^<]+)<\/a>/g)].map((m) => m[1]) };
    };
    expect((await titles("?rsvp_open=1")).values).toEqual(["Chess open"]);
    expect((await titles("?rsvp_open=0")).values.sort()).toEqual(["Chess draft", "Chess paused", "Poker paused"]);
    const combined = await titles("?rsvp_open=0&status=published&q=Chess");
    expect(combined.values).toEqual(["Chess paused"]);
    expect(combined.html).toContain('value="0" selected');
    expect((await titles("?rsvp_open=")).values).toHaveLength(4);
    expect((await titles("?rsvp_open=bogus")).values).toHaveLength(4);
  });
});
