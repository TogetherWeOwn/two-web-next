// route-inventory: GET /admin/join-attempts
// Admin pt2 tests (W12): M6 roster, M8 join viewer + funnel stats, remaining
// M9 net (403 pins on the new routes, read-only guarantees, publish/cancel
// parity with the W8 status machine).
//
// Same layering as test/admin.test.ts: guard pins run on the memory session
// store; live suites need DATABASE_URL (agent-testdb) and skip without it.

import { eq } from "drizzle-orm";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { JOIN_RETENTION_DAYS, joinFunnelStats } from "../src/admin/reads";
import { activityLog, events, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { joinAttempts, users } from "../src/db/schema";
import type { Env } from "../src/env";
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

async function cookieFor(store: SessionStore, row: { userId: string; username: string; moderator: boolean }) {
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
  const s = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return s.split(";")[0]!;
}

describe("admin pt2 guard pins (memory store, no DB)", () => {
  it("guests redirect and non-moderators 403 on the join viewer", async () => {
    const store = createMemorySessionStore();
    const app = adminApp(store);
    expect((await app.request("/join-attempts", {}, env)).status).toBe(302);
    const cookie = await cookieFor(store, { userId: "10000000000000222", username: "pleb", moderator: false });
    for (const path of ["/join-attempts", "/join-attempts?q=1", "/events/abc"]) {
      expect((await app.request(path, { headers: { cookie } }, env)).status, path).toBe(403);
    }
  });

  it("offers no write verb on the join viewer, moderators included (JoinAttemptPolicy)", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, { userId: "10000000000000111", username: "mod", moderator: true });
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      const res = await adminApp(store).request(
        "/join-attempts",
        { method, headers: { cookie, origin: APP_URL } },
        env,
      );
      expect(res.status, method).toBe(404);
    }
  });
});

describe.skipIf(!process.env.DATABASE_URL)("admin reads (agent-testdb)", () => {
  let fixture: MemberDataFixture;
  let db: Db;
  const store = createMemorySessionStore();
  const modId = "100000000000000111";
  const liveEnv = () => ({ ...env, ADMIN_DB: db }) as Env;
  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); db = fixture.db; });
  afterAll(() => fixture?.dispose());
  const app = () => adminApp({ sessionStore: store, db });
  let cookie = "";

  const clean = async () => {
    await db.delete(memberDataAccessLogs);
    await db.delete(activityLog);
    await db.delete(rsvps);
    await db.delete(events);
    await db.delete(joinAttempts);
    await db.delete(users);
  };

  beforeEach(async () => {
    await clean();
    cookie = await cookieFor(store, { userId: modId, username: "mod", moderator: true });
    vi.clearAllMocks();
  });
  afterEach(clean);

  async function seedEvent(status = "draft") {
    const [ev] = await db
      .insert(events)
      .values({
        eventKey: `01TESTEVENT${Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, "0")}`.slice(0, 26),
        title: "Roster night",
        startsAt: new Date("2026-11-04T20:00:00Z"),
        endsAt: new Date("2026-11-04T22:00:00Z"),
        status,
      })
      .returning();
    return ev!;
  }

  it("roster: read-only list of member/status/answered, subjects access-logged", async () => {
    const ev = await seedEvent("published");
    await db.insert(users).values({ id: "10000000000000900", username: "alice" });
    await db.insert(rsvps).values([
      { eventId: ev.id, userId: "10000000000000900", status: "going", updatedAt: new Date("2026-10-02T10:00:00Z") },
      { eventId: ev.id, userId: "10000000000000901", status: "maybe", updatedAt: new Date("2026-10-03T10:00:00Z") },
    ]);
    const res = await app().request(`/events/${ev.eventKey}`, { headers: { cookie } }, liveEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("RSVPs (2)");
    expect(html).toContain("alice");
    expect(html).toContain("Unknown member"); // no users row: do not expose an opaque id
    expect(html).not.toContain("10000000000000901");
    expect(html).toContain("2026-10-03T10:00:00.000Z");
    // Newest answer first.
    expect(html.indexOf("Unknown member")).toBeLessThan(html.indexOf("alice"));

    const logs = await db.select().from(memberDataAccessLogs);
    expect(logs).toHaveLength(1);
    expect(logs[0]?.route).toBe("admin.events.edit");
    expect(logs[0]?.subjectUserIds).toEqual(["10000000000000900", "10000000000000901"]);
    expect(logs[0]?.viewerDiscordId).toBe(modId);
  });

  it("roster is scoped to its event and empty state renders", async () => {
    const a = await seedEvent();
    const b = await seedEvent();
    await db.insert(rsvps).values({ eventId: b.id, userId: "10000000000000777", status: "going" });
    const html = await (await app().request(`/events/${a.eventKey}`, { headers: { cookie } }, liveEnv())).text();
    expect(html).toContain("No RSVPs yet.");
    expect(html).not.toContain("10000000000000777");
  });

  it("funnel stats: per-outcome counts inside the retention window only", async () => {
    const now = new Date("2026-09-29T12:00:00Z");
    const day = 86_400_000;
    const at = (d: number) => new Date(now.getTime() - d * day);
    await db.insert(joinAttempts).values([
      { outcome: "added", source: "site", discordId: "100000000000001", createdAt: at(1) },
      { outcome: "added", source: "site", discordId: "100000000000002", createdAt: at(30) },
      { outcome: "added", source: "site", discordId: "100000000000003", createdAt: at(JOIN_RETENTION_DAYS - 1) },
      { outcome: "added", source: "site", discordId: "100000000000004", createdAt: at(JOIN_RETENTION_DAYS + 1) }, // pruned
      { outcome: "already_member", discordId: "100000000000005", createdAt: at(2) },
      { outcome: "denied", discordId: "100000000000006", createdAt: at(3) },
      { outcome: "denied", discordId: "100000000000007", createdAt: at(200) }, // pruned
      { outcome: "degraded", createdAt: at(4) },
    ]);
    expect(await joinFunnelStats(db, now)).toEqual({ added: 3, already_member: 1, degraded: 1, denied: 1 });
  });

  it("dashboard shows the funnel and logs no member subjects for it", async () => {
    await db.insert(joinAttempts).values([{ outcome: "added", discordId: "100000000000001" }, { outcome: "added", discordId: "100000000000002" }]);
    const res = await app().request("/", { headers: { cookie } }, liveEnv());
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toMatch(/data-testid="funnel-added"[^>]*>2</);
    expect(await db.select().from(memberDataAccessLogs)).toHaveLength(0);
  });

  it("join viewer: newest first, outcome filter, exact id search, subjects logged", async () => {
    const t = (m: number) => new Date(Date.now() - m * 60_000);
    await db.insert(joinAttempts).values([
      { outcome: "added", source: "site", requestId: "req-a", discordId: "100000000000001001", createdAt: t(5) },
      { outcome: "denied", source: "site", requestId: "req-b", discordId: "100000000000001002", createdAt: t(4) },
      { outcome: "denied", source: "bot", requestId: "req-c", discordId: "1000000000000010020", createdAt: t(3) },
    ]);
    const all = await (await app().request("/join-attempts", { headers: { cookie } }, liveEnv())).text();
    expect(all.indexOf("req-c")).toBeLessThan(all.indexOf("req-a"));

    const denied = await (await app().request("/join-attempts?outcome=denied", { headers: { cookie } }, liveEnv())).text();
    expect(denied).toContain("req-b");
    expect(denied).not.toContain("req-a");

    // Exact: a member key must not match the same digits with an extra suffix.
    const exact = await (await app().request("/join-attempts?q=100000000000001002", { headers: { cookie } }, liveEnv())).text();
    expect(exact).toContain("req-b");
    expect(exact).not.toContain("req-c");
    const byReq = await (await app().request("/join-attempts?q=req-c", { headers: { cookie } }, liveEnv())).text();
    expect(byReq).toContain("1000000000000010020");
    expect(byReq).not.toContain("req-a");

    const logs = await db.select().from(memberDataAccessLogs);
    // SQL without ORDER BY has no first-row contract. Require exactly one
    // audit row per request and all four exact subject sets, in any row order.
    expect(logs).toHaveLength(4);
    expect(logs.every((l) => l.route === "admin.join-attempts.index")).toBe(true);
    expect(logs).toEqual(expect.arrayContaining([
      ["100000000000001001", "100000000000001002", "1000000000000010020"].sort(), // All attempts.
      ["100000000000001002", "1000000000000010020"].sort(), // Outcome filter.
      ["100000000000001002"], // Exact Discord id.
      ["1000000000000010020"], // Exact request id.
    ].map((subjectUserIds) => expect.objectContaining({ subjectUserIds }))));
  });

  it("join viewer hides rows past the retention window and never writes", async () => {
    await db.insert(joinAttempts).values([
      { outcome: "added", requestId: "req-old", discordId: "100000000000001", createdAt: new Date(Date.now() - 100 * 86_400_000) },
      { outcome: "added", requestId: "req-new", discordId: "100000000000002" },
    ]);
    const html = await (await app().request("/join-attempts", { headers: { cookie } }, liveEnv())).text();
    expect(html).toContain("req-new");
    expect(html).not.toContain("req-old");
    expect(await db.select().from(joinAttempts)).toHaveLength(2);
  });

  it("publish/cancel parity with the W8 status machine", async () => {
    const post = (path: string) =>
      app().request(path, { method: "POST", headers: { cookie, origin: APP_URL } }, liveEnv());
    const status = async (key: string) => (await db.select().from(events).where(eq(events.eventKey, key)))[0]!.status;

    // draft → cancelled directly is allowed and terminal.
    const d = await seedEvent("draft");
    expect((await post(`/events/${d.eventKey}/cancel`)).status).toBe(303);
    expect(await status(d.eventKey)).toBe("cancelled");
    expect((await post(`/events/${d.eventKey}/publish`)).status).toBe(422);
    expect((await post(`/events/${d.eventKey}/cancel`)).status).toBe(422);

    // published cannot be published again; can be cancelled once.
    const p = await seedEvent("published");
    expect((await post(`/events/${p.eventKey}/publish`)).status).toBe(422);
    expect((await post(`/events/${p.eventKey}/cancel`)).status).toBe(303);
    expect(await status(p.eventKey)).toBe("cancelled");

    // Unknown key → 404, no write.
    expect((await post("/events/NOPE/publish")).status).toBe(404);
  });
});
