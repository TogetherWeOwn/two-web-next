// route-inventory: GET /profile
// route-inventory: GET /members/:user
// route-inventory: GET /leaderboards/members
// route-inventory: GET /e/:key
// route-inventory: GET /events/:file{.+\.ics}
// Acceptance: a signed-in viewer who lacks access gets the branded 403,
// never bare text. Three browser-facing gates must negotiate the same way:
// the member gate (profiles + member leaderboard), the admin guard for
// signed-in non-moderators, and a non-moderator draft event read.
//
// Locked contract (paired builder must satisfy without editing this file):
// - Browser Accept -> 403 branded page: "You do not have access to this"
//   heading plus the error-invite and error-home recovery actions.
// - Accept: application/json -> 403 with exactly
//   { error: "forbidden", message: <non-empty string> }.
// - Every refusal: cache-control carrying exactly the no-store and private
//   tokens (either order: the member-read boundary rewrites the header on
//   buffered reads), no member or draft data in the body, and zero new
//   member-data access-log rows.
// - Unchanged controls: guests still bounce to sign-in, members and
//   moderators still get 200, a session/DB outage still fails closed 503,
//   and feed/ICS refusals stay plain-text "Forbidden".
//
// Hermetic layers reuse the existing memory session/profile doubles; the
// draft-detail layer needs a disposable test DB (skipped without
// DATABASE_URL, like test/events.test.ts).

import { serializeSigned } from "hono/utils/cookie";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { AccessEntry } from "../src/access-log";
import { adminApp } from "../src/admin/routes";
import { events, memberDataAccessLogs } from "../src/db/admin-schema";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

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

const BROWSER = "text/html,application/xhtml+xml";
const JSON_ACCEPT = "application/json";

type Row = { userId: string; username: string; member: boolean; moderator: boolean };
const ALICE: Row = {
  userId: "100000000000000001",
  username: "alice",
  member: true,
  moderator: false,
};
const BOB: Row = { userId: "100000000000000002", username: "bob", member: true, moderator: false };
const MOD: Row = { userId: "100000000000000003", username: "mod", member: true, moderator: true };
const OUTSIDER: Row = {
  userId: "100000000000000004",
  username: "outsider",
  member: false,
  moderator: false,
};

/** Mint a fresh bearer cookie (sessions rotate, so one cookie per request). */
async function cookieFor(store: SessionStore, row: Row): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member,
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

function expectPrivateNoStore(res: Response, label: string) {
  const tokens = (res.headers.get("cache-control") ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .sort();
  expect(tokens, label).toEqual(["no-store", "private"]);
}

async function expectBranded403(res: Response, label: string): Promise<string> {
  expect(res.status, label).toBe(403);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
  expect(res.headers.get("location"), label).toBeNull();
  const body = await res.text();
  expect(body.trim(), label).not.toBe("Forbidden");
  expect(body, label).toContain("You do not have access to this");
  expect(body, label).toContain('data-testid="error-invite"');
  expect(body, label).toContain('data-testid="error-home"');
  return body;
}

async function expectJson403(res: Response, label: string): Promise<string> {
  expect(res.status, label).toBe(403);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("application/json");
  expect(res.headers.get("location"), label).toBeNull();
  const text = await res.text();
  const parsed = JSON.parse(text) as Record<string, unknown>;
  expect(Object.keys(parsed).sort(), label).toEqual(["error", "message"]);
  expect(parsed.error, label).toBe("forbidden");
  expect(typeof parsed.message, label).toBe("string");
  expect((parsed.message as string).length, label).toBeGreaterThan(0);
  return text;
}

// --- Member gate: profiles (memory doubles, same seams as profiles.test.ts) ---

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice private bio marker",
    games: ["Chess"],
    timezone: "Europe/London",
  },
  { id: BOB.userId, username: "bob", avatar: null, bio: null, games: [], timezone: null },
];

function profileHarness() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(seedMembers());
  const log: AccessEntry[] = [];
  const profileApp = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (e) => {
      const subjects = [...new Set(e.subjectUserIds.filter((s) => s !== e.viewerUserId))];
      if (subjects.length === 0) return false;
      log.push({ ...e, subjectUserIds: subjects });
      return true;
    },
  });
  return { profileApp, sessions, log };
}

describe("branded 403 acceptance: member gate on profile routes", () => {
  it.each(["/profile", `/members/${ALICE.userId}`])(
    "signed-in non-member GET %s with a browser Accept gets the branded page",
    async (path) => {
      const { profileApp, sessions, log } = profileHarness();
      const res = await profileApp.request(
        path,
        { headers: { cookie: await cookieFor(sessions, OUTSIDER), accept: BROWSER } },
        env,
      );
      const body = await expectBranded403(res, `browser ${path}`);
      expect(body).not.toContain("alice");
      expect(body).not.toContain("Alice private bio marker");
      expect(body).not.toContain("Chess");
      expect(log).toHaveLength(0);
    },
  );

  it.each(["/profile", `/members/${ALICE.userId}`])(
    "signed-in non-member GET %s with Accept: application/json gets the JSON envelope",
    async (path) => {
      const { profileApp, sessions, log } = profileHarness();
      const res = await profileApp.request(
        path,
        { headers: { cookie: await cookieFor(sessions, OUTSIDER), accept: JSON_ACCEPT } },
        env,
      );
      const body = await expectJson403(res, `json ${path}`);
      expect(body).not.toContain("alice");
      expect(body).not.toContain("Alice private bio marker");
      expect(log).toHaveLength(0);
    },
  );

  it("controls: guest bounces, member gets 200, session outage fails closed 503", async () => {
    const { profileApp, sessions, log } = profileHarness();

    const guest = await profileApp.request("/profile", { headers: { accept: BROWSER } }, env);
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");

    const member = await profileApp.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB), accept: BROWSER } },
      env,
    );
    expect(member.status).toBe(200);
    expect(await member.text()).toContain("alice");

    const failing = profileHarness();
    const cookie = await cookieFor(failing.sessions, BOB);
    vi.spyOn(failing.sessions, "get").mockRejectedValue(new Error("session store down"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const outage = await failing.profileApp.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie, accept: BROWSER } },
      env,
    );
    expect(outage.status).toBe(503);
    expect(await outage.text()).not.toContain("Alice private bio marker");
    expect(failing.log).toHaveLength(0);
    expect(log).toHaveLength(1); // only the member 200 above is audited
  });
});

// --- Member gate: leaderboard on the full app ---

describe("branded 403 acceptance: member gate on the member leaderboard", () => {
  async function leaderboardAs(row: Row | null, accept: string) {
    const store = createMemorySessionStore();
    const headers: Record<string, string> = { accept };
    if (row) headers.cookie = await cookieFor(store, row);
    return app.request("/leaderboards/members", { headers }, {
      ...env,
      SESSION_STORE: store,
    } as unknown as Env);
  }

  it("signed-in non-member with a browser Accept gets the branded page", async () => {
    const body = await expectBranded403(
      await leaderboardAs(OUTSIDER, BROWSER),
      "browser /leaderboards/members",
    );
    expect(body).not.toContain("Member leaderboard");
  });

  it("signed-in non-member with Accept: application/json gets the JSON envelope", async () => {
    const body = await expectJson403(
      await leaderboardAs(OUTSIDER, JSON_ACCEPT),
      "json /leaderboards/members",
    );
    expect(body).not.toContain("Member leaderboard");
  });

  it("control: guest still bounces to sign-in, never the board", async () => {
    const res = await leaderboardAs(null, BROWSER);
    expect(res.status).toBe(302);
    expect(await res.text()).not.toContain("Member leaderboard");
  });
});

// --- Admin guard: signed-in non-moderator (memory store, no DB) ---

describe("branded 403 acceptance: admin guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["GET", "/events"],
    ["POST", "/events"],
  ] as const)(
    "signed-in non-moderator %s %s with a browser Accept gets the branded page",
    async (method, path) => {
      const store = createMemorySessionStore();
      const res = await adminApp(store).request(
        path,
        {
          method,
          headers: { cookie: await cookieFor(store, BOB), accept: BROWSER },
          ...(method === "POST" ? { body: "" } : {}),
        },
        env,
      );
      await expectBranded403(res, `browser admin ${method} ${path}`);
    },
  );

  it.each([
    ["GET", "/events"],
    ["POST", "/events"],
  ] as const)(
    "signed-in non-moderator %s %s with Accept: application/json gets the JSON envelope",
    async (method, path) => {
      const store = createMemorySessionStore();
      const res = await adminApp(store).request(
        path,
        {
          method,
          headers: { cookie: await cookieFor(store, BOB), accept: JSON_ACCEPT },
          ...(method === "POST" ? { body: "" } : {}),
        },
        env,
      );
      await expectJson403(res, `json admin ${method} ${path}`);
    },
  );

  it("controls: guest bounces, moderator gets 200, resolve failure fails closed 503", async () => {
    const guest = await adminApp(createMemorySessionStore()).request(
      "/events",
      { headers: { accept: BROWSER } },
      env,
    );
    expect(guest.status).toBe(302);
    expect(guest.headers.get("location")).toBe("/auth/discord");

    const modStore = createMemorySessionStore();
    const mod = await adminApp(modStore).request(
      "/",
      { headers: { cookie: await cookieFor(modStore, MOD), accept: BROWSER } },
      env,
    );
    expect(mod.status).toBe(200);

    vi.spyOn(console, "error").mockImplementation(() => {});
    const seed = createMemorySessionStore();
    const cookie = await cookieFor(seed, MOD);
    const failing: SessionStore = {
      ...createMemorySessionStore(),
      get: async () => {
        throw new Error("session store down");
      },
    };
    const outage = await adminApp({ sessionStore: failing }).request(
      "/events",
      { headers: { cookie, accept: BROWSER } },
      env,
    );
    expect(outage.status).toBe(503);
  });
});

// --- Draft event detail + feed control (disposable test DB) ---

const DRAFT_KEY = "01K0000000000000000000D403";
const DRAFT_TITLE = "Draft title that must stay hidden";
const DRAFT_DESCRIPTION = "Draft description that must stay hidden";

describe.skipIf(!process.env.DATABASE_URL)(
  "branded 403 acceptance: non-moderator draft event read (agent-testdb)",
  () => {
    let fixture: MemberDataFixture;
    let store: SessionStore;
    let dbEnv: Env;

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!, { max: 4 });
      store = createMemorySessionStore();
      dbEnv = {
        ...env,
        SESSION_STORE: store,
        ADMIN_DB: fixture.db,
        DISCORD_EVENTS: { upcoming: async () => [], lastReadFailed: () => false },
      } as unknown as Env;
      await fixture.reset();
      await fixture.db.insert(events).values({
        eventKey: DRAFT_KEY,
        title: DRAFT_TITLE,
        description: DRAFT_DESCRIPTION,
        startsAt: new Date("2099-01-10T20:00:00Z"),
        endsAt: new Date("2099-01-10T22:00:00Z"),
        timezone: "UTC",
        location: "Private voice channel",
        status: "draft",
      });
    });
    afterAll(() => fixture?.dispose());

    const logs = () => fixture.db.select().from(memberDataAccessLogs);

    it("non-moderator member GET /e/<draft> with a browser Accept gets the branded page", async () => {
      const before = (await logs()).length;
      const res = await app.request(
        `/e/${DRAFT_KEY}`,
        { headers: { cookie: await cookieFor(store, BOB), accept: BROWSER } },
        dbEnv,
      );
      const body = await expectBranded403(res, "browser draft /e/<key>");
      expect(body).not.toContain(DRAFT_TITLE);
      expect(body).not.toContain(DRAFT_DESCRIPTION);
      expect((await logs()).length).toBe(before);
    });

    it("non-moderator member GET /e/<draft> with Accept: application/json gets the JSON envelope", async () => {
      const before = (await logs()).length;
      const res = await app.request(
        `/e/${DRAFT_KEY}`,
        { headers: { cookie: await cookieFor(store, BOB), accept: JSON_ACCEPT } },
        dbEnv,
      );
      const body = await expectJson403(res, "json draft /e/<key>");
      expect(body).not.toContain(DRAFT_TITLE);
      expect(body).not.toContain(DRAFT_DESCRIPTION);
      expect((await logs()).length).toBe(before);
    });

    it("controls: moderator reads the draft, and the draft ICS refusal stays plain text", async () => {
      const mod = await app.request(
        `/e/${DRAFT_KEY}`,
        { headers: { cookie: await cookieFor(store, MOD), accept: BROWSER } },
        dbEnv,
      );
      expect(mod.status).toBe(200);
      expect(await mod.text()).toContain(DRAFT_TITLE);

      const ics = await app.request(
        `/events/${DRAFT_KEY}.ics`,
        { headers: { cookie: await cookieFor(store, BOB), accept: BROWSER } },
        dbEnv,
      );
      expect(ics.status).toBe(403);
      expect(await ics.text()).toBe("Forbidden");
    });
  },
);
