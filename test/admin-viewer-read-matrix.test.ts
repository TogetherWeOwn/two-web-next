// route-inventory: GET /admin/events/:key
// route-inventory: GET /admin/join-attempts
// route-inventory: GET /admin/join-attempts/:id
// Viewer read matrix (W12 M6 RsvpsRelationManager roster, W12 M8 JoinAttempt
// viewer) through the production /admin mount. One table pins who may read,
// which verbs exist, and that the moderator decision is the server-side
// session row bit only (src/admin/guard.ts): nothing the client sends — a
// re-signed cookie, a role cookie, a role header — can grant or keep it.
//
// Guests are denied by a 302 into site Discord OAuth, not a 403: the panel has
// no login page (legacy parity, TOG-54). Every denial must release no member
// data, write no access-log row and leave the read tables untouched.

import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import { activityLog, memberDataAccessLogs, rsvps } from "../src/db/admin-schema";
import { joinAttempts } from "../src/db/schema";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";
import { env, EVENT_KEY, MEMBER, MODERATOR, OUTSIDER, PERSONAL_STRINGS, seed, SUBJECT } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

type Actor = typeof MEMBER;
type Expect = { status: 302 | 403 | 404 };
const GUEST: Expect = { status: 302 };
const FORBIDDEN: Expect = { status: 403 };
const NO_ROUTE: Expect = { status: 404 };
const WRITE_VERBS = ["POST", "PUT", "PATCH", "DELETE"] as const;
const LEAKS = [...PERSONAL_STRINGS, SUBJECT.userId, "w15-request"];

async function signed(value: string, secret = env.SESSION_SECRET, name = "__Host-two_session") {
  return (await serializeSigned(name, value, secret, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

async function session(store: SessionStore, actor: Actor, expiresAt = new Date(Date.now() + 3600_000)) {
  const token = newSessionToken();
  const row = {
    tokenHash: await hashToken(token), userId: actor.userId, username: actor.username,
    avatar: null, member: actor.member, moderator: actor.moderator, expiresAt,
  };
  await store.create(row);
  return { token, row, cookie: await signed(token) };
}

describe.skipIf(!process.env.DATABASE_URL)("admin viewer read matrix (mounted, isolated agent-testdb / CI fixture)", () => {
  let fixture: MemberDataFixture;
  let sessions: SessionStore;
  let attemptId: number;
  const paths = () => ({
    roster: `/admin/events/${EVENT_KEY}`,
    joinList: "/admin/join-attempts",
    joinDetail: `/admin/join-attempts/${attemptId}`,
  });
  const request = (path: string, init: RequestInit = {}) => app.request(path, init, {
    ...env, ADMIN_DB: fixture.db, SESSION_STORE: sessions,
  });
  const logs = () => fixture.db.select().from(memberDataAccessLogs);
  const snapshot = async () => ({
    rsvps: await fixture.db.select().from(rsvps),
    joinAttempts: await fixture.db.select().from(joinAttempts),
    activity: await fixture.db.select().from(activityLog),
  });

  async function denied(res: Response, expected: Expect, label: string) {
    expect(res.status, label).toBe(expected.status);
    if (expected.status === 302) expect(res.headers.get("location"), label).toBe("/auth/discord");
    const body = await res.text();
    for (const token of LEAKS) expect(body, `${label} leaks ${token}`).not.toContain(token);
  }

  beforeAll(async () => { fixture = await createMemberDataFixture(process.env.DATABASE_URL!); });
  beforeEach(async () => {
    await fixture.reset();
    await seed(fixture.db);
    sessions = createMemorySessionStore();
    attemptId = (await fixture.db.select({ id: joinAttempts.id }).from(joinAttempts))[0]!.id;
  });
  afterEach(async () => { vi.restoreAllMocks(); await fixture?.reset(); });
  afterAll(() => fixture?.dispose());

  it("moderator reads: 200, private no-store, one access-log row naming the subject", async () => {
    const { cookie } = await session(sessions, MODERATOR);
    const expected = [
      { path: paths().roster, route: "admin.events.edit", action: "view", shows: SUBJECT.username },
      { path: paths().joinList, route: "admin.join-attempts.index", action: "list", shows: "w15-request" },
      { path: paths().joinDetail, route: "admin.join-attempts.show", action: "view", shows: "w15-request" },
    ];
    for (const { path, route, action, shows } of expected) {
      const before = (await logs()).length;
      const res = await request(path, { headers: { cookie } });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("cache-control"), path).toBe("private, no-store");
      expect(await res.text(), path).toContain(shows);
      const entries = (await logs()).slice(before);
      expect(entries, path).toHaveLength(1);
      expect(entries[0], path).toMatchObject({
        viewerDiscordId: MODERATOR.userId, route, action, subjectUserIds: [SUBJECT.userId], subjectCount: 1,
      });
    }
  });

  it.each([
    ["guest", null, GUEST],
    ["signed-in member", MEMBER, FORBIDDEN],
    ["signed-in non-member", OUTSIDER, FORBIDDEN],
  ] as const)("%s cannot read the roster or join attempts", async (label, actor, expected) => {
    const headers: Record<string, string> = actor ? { cookie: (await session(sessions, actor)).cookie } : {};
    const before = await snapshot();
    for (const [name, path] of Object.entries(paths())) {
      for (const method of ["GET", "HEAD"]) {
        await denied(await request(path, { method, headers }), expected, `${label} ${method} ${name}`);
      }
    }
    expect(await logs()).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  // Read-only by construction: the join viewer has no write route at all, and
  // the roster has none either. POST /admin/events/:key is the event edit form
  // (W11 M2), not a roster write, so the moderator row skips only that cell.
  it.each([
    ["guest", null, GUEST, GUEST],
    ["signed-in member", MEMBER, FORBIDDEN, FORBIDDEN],
    ["signed-in non-member", OUTSIDER, FORBIDDEN, FORBIDDEN],
    ["moderator", MODERATOR, NO_ROUTE, null],
  ] as const)("%s write verbs are denied on the viewer endpoints and change nothing", async (label, actor, expected, rosterPost) => {
    const cookie = actor ? (await session(sessions, actor)).cookie : undefined;
    const headers: Record<string, string> = { origin: env.APP_URL, ...(cookie ? { cookie } : {}) };
    const before = await snapshot();
    for (const [name, path] of Object.entries(paths())) {
      for (const method of WRITE_VERBS) {
        const want = name === "roster" && method === "POST" ? rosterPost : expected;
        if (!want) continue;
        await denied(await request(path, { method, headers }), want, `${label} ${method} ${name}`);
      }
    }
    expect(await logs()).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });

  it("follows the session row bit, not the cookie: same cookie flips with the row", async () => {
    const mod = await session(sessions, MODERATOR);
    const member = await session(sessions, MEMBER);
    for (const path of Object.values(paths())) {
      expect((await request(path, { headers: { cookie: mod.cookie } })).status, path).toBe(200);
      expect((await request(path, { headers: { cookie: member.cookie } })).status, path).toBe(403);
    }
    // Login recomputes the bit onto the row; the unchanged cookie follows it.
    await sessions.create({ ...mod.row, moderator: false });
    await sessions.create({ ...member.row, moderator: true });
    for (const path of Object.values(paths())) {
      await denied(await request(path, { headers: { cookie: mod.cookie } }), FORBIDDEN, `demoted ${path}`);
      expect((await request(path, { headers: { cookie: member.cookie } })).status, `promoted ${path}`).toBe(200);
    }
  });

  it("no client-supplied credential shape grants moderator reads", async () => {
    const mod = await session(sessions, MODERATOR);
    const member = await session(sessions, MEMBER);
    const revoked = await session(sessions, MODERATOR);
    await sessions.revoke(revoked.row.tokenHash);
    const expired = await session(sessions, MODERATOR, new Date(Date.now() - 1000));
    const cases: [string, Record<string, string>, Expect][] = [
      ["moderator token signed with a foreign secret", { cookie: await signed(mod.token, "attacker-secret-at-least-32-bytes-long!!") }, GUEST],
      ["unsigned moderator token", { cookie: `__Host-two_session=${mod.token}` }, GUEST],
      ["moderator token under a non-__Host- name", { cookie: await signed(mod.token, env.SESSION_SECRET, "two_session") }, GUEST],
      ["signed row hash instead of the token", { cookie: await signed(mod.row.tokenHash) }, FORBIDDEN],
      ["revoked moderator session", { cookie: revoked.cookie }, FORBIDDEN],
      ["expired moderator session", { cookie: expired.cookie }, FORBIDDEN],
      ["member session plus role cookies", {
        cookie: `${member.cookie}; moderator=true; role=moderator; ${await signed("true", env.SESSION_SECRET, "__Host-two_moderator")}`,
      }, FORBIDDEN],
      ["member session plus role headers", {
        cookie: member.cookie, "x-moderator": "true", "x-two-role": "moderator", "x-forwarded-user": MODERATOR.userId,
      }, FORBIDDEN],
    ];
    const before = await snapshot();
    for (const [label, headers, expected] of cases) {
      for (const [name, path] of Object.entries(paths())) {
        await denied(await request(path, { headers }), expected, `${label} ${name}`);
      }
    }
    expect(await logs()).toHaveLength(0);
    expect(await snapshot()).toEqual(before);
  });
});
