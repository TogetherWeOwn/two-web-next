// route-inventory: GET /profile
// route-inventory: GET /members/:user
// route-inventory: GET /e/:key
// route-inventory: PATCH /members/:user
// route-inventory: POST /members/:user
// Acceptance: a signed-in member who hits a store outage or a non-owner write
// refusal gets a branded page with a way forward, never bare text. Three legs:
//
// 1. Profile-read store outage (GET /profile, GET /members/:user with no
//    profile store and no DB) -> 503 branded outage envelope.
// 2. Event-detail no-DB (GET /e/:key with no DB) -> 503 branded outage envelope.
// 3. Non-owner profile write (PATCH or form-override POST /members/:other as a
//    member) -> 403 member-aware refusal: names that only the member's own
//    profile can be edited, with a link back to the viewer's own profile.
//    Neither bare "Forbidden" nor the "join to unlock" gate copy (re-signing
//    in cannot mint ownership, so that copy would mislead a signed-in member).
//
// Locked contract (the paired builder satisfies this without editing this file):
// - 503 legs, browser Accept: 503 + text/html MaintenancePage ("We will be
//   right back") with the error-invite recovery (invite href) and the
//   error-retry recovery (Try again). The planning note says "invite + home";
//   the shared outage envelope provides invite + retry, so these tests pin the
//   envelope with contains-assertions: an added home link still passes, while
//   bare text ("Profiles/Events temporarily unavailable") fails.
// - 403 leg, browser Accept: 403 + text/html page containing "only your own
//   profile" (case-insensitive) plus a link back to the viewer's own profile
//   (/profile or /members/<viewer id>); must not be bare "Forbidden", must not
//   carry "Join to unlock member pages" or error-join-unlock, and must not leak
//   the refused target's profile fields.
// - Invariance on all three legs: status, cache-control carrying exactly the
//   no-store and private tokens, zero access-log sink calls, and (403 leg) the
//   refused target's stored profile byte-identical afterwards.
// - JSON Accept pins are deliberately loose (status/headers/audit/no-leak only):
//   the legs do not negotiate today, and the build is not required to add
//   negotiation, so the representation is not dictated.
// - Controls that pass before and after: owner reads still 200, forged event
//   keys still branded 404, owner saves still 303.
//
// Hermetic: memory session/profile doubles, no DB binding, no DATABASE_URL in
// the request env (databaseUrl reads the request env only, so these 503s hold
// even when the runner exports DATABASE_URL). Feed-path refusals stay out of
// scope: the done negotiated-errors boundary pins bare feed 403s as machine
// contracts, guarded by the draft-ICS control in the branded-403 suite.

import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore, type MemberView } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
const INVITE = "https://discord.gg/invite";
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: INVITE,
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

const BOB_MARKER_BIO = "Bob private bio marker that must never leak into a refusal";

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

async function expectBranded503(res: Response, label: string, bareCopy: string): Promise<string> {
  expect(res.status, label).toBe(503);
  expectPrivateNoStore(res, label);
  expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
  const body = await res.text();
  expect(body.trim(), label).not.toBe(bareCopy);
  // The boundary released the buffered outage page; it did not refuse it.
  expect(body, label).not.toContain("Member data is temporarily unavailable.");
  expect(body, label).toContain("We will be right back");
  expect(body, label).toContain('data-testid="error-invite"');
  expect(body, label).toContain(`href="${INVITE}"`);
  expect(body, label).toContain('data-testid="error-retry"');
  return body;
}

const seedMembers = (): MemberView[] => [
  {
    id: ALICE.userId,
    username: "alice",
    avatar: null,
    bio: "Alice member bio",
    games: ["Chess"],
    timezone: "Europe/London",
  },
  {
    id: BOB.userId,
    username: "bob",
    avatar: null,
    bio: BOB_MARKER_BIO,
    games: [],
    timezone: null,
  },
];

/** Profile slice with no store and no DB: every read fails closed 503. */
function outageProfileHarness() {
  const sessions = createMemorySessionStore();
  const sinkCalls: unknown[] = [];
  const profileApp = profilesApp({
    sessionStore: sessions,
    accessLog: async (entry) => {
      sinkCalls.push(entry);
      return true;
    },
  });
  return { profileApp, sessions, sinkCalls };
}

function writeProfileHarness() {
  const sessions = createMemorySessionStore();
  const store = createMemoryProfileStore(seedMembers());
  const sinkCalls: unknown[] = [];
  const profileApp = profilesApp({
    sessionStore: sessions,
    store,
    accessLog: async (entry) => {
      sinkCalls.push(entry);
      return true;
    },
  });
  return { profileApp, sessions, store, sinkCalls };
}

describe("branded member refusals: profile-store outage 503", () => {
  it.each(["/profile", `/members/${ALICE.userId}`])(
    "member GET %s with a browser Accept gets the branded outage envelope",
    async (path) => {
      const { profileApp, sessions, sinkCalls } = outageProfileHarness();
      const res = await profileApp.request(
        path,
        { headers: { cookie: await cookieFor(sessions, ALICE), accept: BROWSER } },
        env,
      );
      await expectBranded503(res, `browser ${path}`, "Profiles temporarily unavailable");
      expect(sinkCalls, `audit ${path}`).toHaveLength(0);
    },
  );

  it("member GET with Accept: application/json keeps status/headers/audit, any representation", async () => {
    const { profileApp, sessions, sinkCalls } = outageProfileHarness();
    const res = await profileApp.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, ALICE), accept: JSON_ACCEPT } },
      env,
    );
    expect(res.status).toBe(503);
    expectPrivateNoStore(res, "json profile outage");
    const body = await res.text();
    expect(body).not.toContain("Member data is temporarily unavailable.");
    expect(body).not.toContain("Alice member bio");
    expect(sinkCalls).toHaveLength(0);
  });

  it("control: the same harness with a store still reads 200", async () => {
    const { profileApp, sessions } = writeProfileHarness();
    const res = await profileApp.request(
      `/members/${ALICE.userId}`,
      { headers: { cookie: await cookieFor(sessions, BOB), accept: BROWSER } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("alice");
  });
});

describe("branded member refusals: event-detail no-DB 503", () => {
  const EVENT_KEY = "01K0000000000000000000F101";

  async function detailAs(accept: string, path = `/e/${EVENT_KEY}`) {
    const store = createMemorySessionStore();
    return app.request(path, { headers: { cookie: await cookieFor(store, ALICE), accept } }, {
      ...env,
      SESSION_STORE: store,
    } as unknown as Env);
  }

  it("member GET /e/:key with a browser Accept gets the branded outage envelope", async () => {
    const body = await expectBranded503(
      await detailAs(BROWSER),
      "browser /e/:key",
      "Events temporarily unavailable",
    );
    expect(body).not.toContain(EVENT_KEY);
  });

  it("member GET /e/:key with Accept: application/json keeps status/headers, any representation", async () => {
    const res = await detailAs(JSON_ACCEPT);
    expect(res.status).toBe(503);
    expectPrivateNoStore(res, "json event outage");
    const body = await res.text();
    expect(body).not.toContain("Member data is temporarily unavailable.");
  });

  it("control: a forged key still gets the branded 404, never the outage page", async () => {
    const res = await detailAs(BROWSER, "/e/not-a-key");
    expect(res.status).toBe(404);
    expectPrivateNoStore(res, "forged key 404");
    const body = await res.text();
    expect(body).toContain("We cannot find that page");
    expect(body).not.toContain("We will be right back");
  });
});

describe("branded member refusals: non-owner profile write 403", () => {
  async function expectMemberAware403(res: Response, label: string): Promise<string> {
    expect(res.status, label).toBe(403);
    expectPrivateNoStore(res, label);
    expect(res.headers.get("content-type") ?? "", label).toContain("text/html");
    const body = await res.text();
    expect(body.trim(), label).not.toBe("Forbidden");
    expect(body, label).toMatch(/only your own profile/i);
    expect(body, label).toMatch(new RegExp(`href="(/profile|/members/${ALICE.userId})"`));
    expect(body, label).not.toContain("Join to unlock member pages");
    expect(body, label).not.toContain('data-testid="error-join-unlock"');
    expect(body, label).not.toContain(BOB_MARKER_BIO);
    return body;
  }

  it("member PATCH of another profile with a browser Accept gets member-aware copy", async () => {
    const { profileApp, sessions, store, sinkCalls } = writeProfileHarness();
    const beforeBob = await store.find(BOB.userId);
    const beforeAlice = await store.find(ALICE.userId);
    const res = await profileApp.request(
      `/members/${BOB.userId}`,
      {
        method: "PATCH",
        headers: {
          cookie: await cookieFor(sessions, ALICE),
          origin: APP_URL,
          accept: BROWSER,
          "content-type": "application/json",
        },
        body: JSON.stringify({ bio: "hijack attempt", games: [] }),
      },
      env,
    );
    await expectMemberAware403(res, "browser PATCH non-owner");
    expect(sinkCalls, "audit PATCH non-owner").toHaveLength(0);
    expect(await store.find(BOB.userId), "bob unchanged").toEqual(beforeBob);
    expect(await store.find(ALICE.userId), "alice unchanged").toEqual(beforeAlice);
  });

  it("form-override POST of another profile refuses the same branded way", async () => {
    const { profileApp, sessions, store, sinkCalls } = writeProfileHarness();
    const beforeBob = await store.find(BOB.userId);
    const res = await profileApp.request(
      `/members/${BOB.userId}`,
      {
        method: "POST",
        headers: {
          cookie: await cookieFor(sessions, ALICE),
          origin: APP_URL,
          accept: BROWSER,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _method: "PATCH", bio: "hijack attempt", games_text: "" }),
      },
      env,
    );
    await expectMemberAware403(res, "browser POST-override non-owner");
    expect(sinkCalls, "audit POST-override non-owner").toHaveLength(0);
    expect(await store.find(BOB.userId), "bob unchanged").toEqual(beforeBob);
  });

  it("non-owner PATCH with Accept: application/json keeps status/headers/audit, any representation", async () => {
    const { profileApp, sessions, store, sinkCalls } = writeProfileHarness();
    const beforeBob = await store.find(BOB.userId);
    const res = await profileApp.request(
      `/members/${BOB.userId}`,
      {
        method: "PATCH",
        headers: {
          cookie: await cookieFor(sessions, ALICE),
          origin: APP_URL,
          accept: JSON_ACCEPT,
          "content-type": "application/json",
        },
        body: JSON.stringify({ bio: "hijack attempt", games: [] }),
      },
      env,
    );
    expect(res.status).toBe(403);
    expectPrivateNoStore(res, "json non-owner PATCH");
    expect(await res.text()).not.toContain(BOB_MARKER_BIO);
    expect(sinkCalls).toHaveLength(0);
    expect(await store.find(BOB.userId)).toEqual(beforeBob);
  });

  it("control: the owner still saves (303 back to the profile)", async () => {
    const { profileApp, sessions, store } = writeProfileHarness();
    const res = await profileApp.request(
      `/members/${ALICE.userId}`,
      {
        method: "PATCH",
        headers: {
          cookie: await cookieFor(sessions, ALICE),
          origin: APP_URL,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          bio: "owner edit still works",
          games_text: "Chess",
          timezone: "Europe/London",
        }),
      },
      env,
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`/members/${ALICE.userId}`);
    expect((await store.find(ALICE.userId))?.bio).toBe("owner edit still works");
  });
});
