import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { adminApp } from "../src/admin/routes";
import { JOIN_RETENTION_DAYS } from "../src/admin/reads";
import { memberDataAccessLogs } from "../src/db/admin-schema";
import { joinAttempts, users, type NewJoinAttempt } from "../src/db/schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MEMBER, MODERATOR, OUTSIDER, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

describe("join attempt detail guard (local fixtures)", () => {
  it("redirects guests and forbids members before any attempt read", async () => {
    const sessions = createMemorySessionStore();
    const app = adminApp(sessions);
    const guest = await app.request("/join-attempts/1", {}, env);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");
    const cookie = await cookieFor(sessions, MEMBER);
    for (const path of ["/join-attempts/1", "/join-attempts/999999", "/join-attempts/not-an-id"]) {
      expect((await app.request(path, { headers: { cookie } }, env)).status).toBe(403);
    }
  });

  it.each(["0", "-1", "1.0", "1e2", "01", "abc", "9007199254740993"])("returns 404 for invalid id %s without a database", async (id) => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request(`/join-attempts/${id}`, { headers: { cookie } }, env);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Join attempt not found");
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])("offers no %s detail route, even to moderators", async (method) => {
    const sessions = createMemorySessionStore();
    const cookie = await cookieFor(sessions, MODERATOR);
    const res = await adminApp(sessions).request("/join-attempts/1", { method, headers: { cookie, origin: env.APP_URL } }, env);
    expect(res.status).toBe(404);
  });
});

describe.skipIf(!process.env.DATABASE_URL)("join attempt detail (isolated agent-testdb / CI fixture)", () => {
  let fixture: MemberDataFixture;
  let sessions = createMemorySessionStore();
  let cookie: string;
  const app = () => adminApp({ sessionStore: sessions, db: fixture.db });
  const bindings = () => ({ ...env, ADMIN_DB: fixture.db });
  const read = (id: number) => app().request(`/join-attempts/${id}`, { headers: { cookie } }, bindings());
  const logs = () => fixture.db.select().from(memberDataAccessLogs);
  const attempt = async (values: NewJoinAttempt = { outcome: "added", discordId: SUBJECT.userId, source: "join", requestId: "detail-request" }) => {
    const [row] = await fixture.db.insert(joinAttempts).values(values).returning();
    return row!;
  };

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => {
    await fixture.reset();
    sessions = createMemorySessionStore();
    cookie = await cookieFor(sessions, MODERATOR);
    await fixture.db.insert(users).values([SUBJECT, MODERATOR, OUTSIDER].map((actor) => ({
      id: actor.userId, username: actor.username, member: actor.member,
    })));
  });
  afterEach(() => vi.restoreAllMocks());
  afterAll(() => fixture?.dispose());

  it("renders the moderator detail and writes one access-log row with the member's Discord id", async () => {
    const row = await attempt();
    const res = await read(row.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    for (const field of [row.outcome, row.source!, row.requestId!, row.discordId!, row.createdAt.toISOString()]) {
      expect(html).toContain(field);
    }
    expect(html).toContain(`Join attempt ${row.id}`);
    expect(html).toContain('href="/admin/join-attempts"');
    expect(html).toContain("Attempted at (UTC)");
    expect(html).not.toMatch(/<form|<input|<button/);
    const entries = await logs();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      viewerDiscordId: MODERATOR.userId, viewerUserId: MODERATOR.userId,
      resource: "join_attempts", action: "view", route: "admin.join-attempts.show",
      subjectUserIds: [SUBJECT.userId], subjectCount: 1,
    });
    expect(entries[0]!.occurredAt).toBeInstanceOf(Date);
    expect(await fixture.db.select().from(joinAttempts)).toEqual([row]);
  });

  it("links list rows directly to their detail pages", async () => {
    const row = await attempt();
    const res = await app().request("/join-attempts", { headers: { cookie } }, bindings());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain(`href="/admin/join-attempts/${row.id}"`);
  });

  it("returns 404 for unknown or expired attempts and writes no log", async () => {
    const old = await attempt({ outcome: "denied", discordId: SUBJECT.userId,
      createdAt: new Date(Date.now() - (JOIN_RETENTION_DAYS + 1) * 86_400_000) });
    for (const id of [999999, old.id]) {
      const res = await read(id);
      expect(res.status).toBe(404);
      expect(await res.text()).toContain("Join attempt not found");
    }
    expect(await logs()).toHaveLength(0);
  });

  it("looks up the primary key even when the attempt is beyond the list's 100-row cap", async () => {
    const row = await attempt({ outcome: "added", createdAt: new Date(Date.now() - 60_000) });
    await fixture.db.insert(joinAttempts).values(Array.from({ length: 101 }, () => ({ outcome: "error" })));
    expect((await read(row.id)).status).toBe(200);
  });

  it.each([null, "unmapped-discord-id", OUTSIDER.userId, MODERATOR.userId])("does not invent a member subject or log a self read for %s", async (discordId) => {
    const row = await attempt({ outcome: "degraded", discordId });
    const res = await read(row.id);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("degraded");
    expect(html).toContain("—");
    if (discordId) expect(html).toContain(discordId);
    expect(await logs()).toHaveLength(0);
  });

  it("escapes trace identifiers and sources rather than rendering markup", async () => {
    const row = await attempt({ outcome: "error", source: "<script>alert(1)</script>", requestId: '<img src=x onerror="alert(1)">' });
    const html = await (await read(row.id)).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
  });

  it("fails closed when the real access-log insert fails, without releasing trace fields", async () => {
    const row = await attempt();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await fixture.db.execute(sql`ALTER TABLE member_data_access_logs RENAME TO unavailable_access_logs`);
    try {
      const res = await read(row.id);
      expect(res.status).toBe(503);
      expect(res.headers.get("cache-control")).toBe("private, no-store");
      const html = await res.text();
      expect(html).not.toContain(row.requestId!);
      expect(html).not.toContain(row.discordId!);
    } finally {
      await fixture.db.execute(sql`ALTER TABLE unavailable_access_logs RENAME TO member_data_access_logs`);
    }
    expect(await logs()).toHaveLength(0);
  });
});
