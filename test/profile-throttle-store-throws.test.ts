// Pin: profile writes degrade to allow when the throttle store throws.
//
// `src/profiles/routes-admission.ts:28-30` catches any throttle-store throw and
// admits (`{ limited: false }`); a refactor flipping that catch to deny would
// lock members out of their own profiles on a throttle outage. This suite pins
// the fail-open through the real admission path: no injected `deps.throttle` —
// the request carries a `DATABASE_URL` so `admitWrite` builds its Postgres
// throttle client, and only the `postgres` driver boundary is doubled to a
// store whose transaction throws (hermetic; no live DB).
//
// What is pinned:
// - owner PATCH proceeds (JSON 200, row saved) with a throwing store;
// - a signed-in member targeting another member still 403s with no row change
//   (the owner check runs after the degrade, so throttle-first order holds);
// - the thrown store error's text never reaches console output (the degrade is
//   silent by design, like the join funnel's `throttled()` — no message leak;
//   no log-verbosity change here).
//
// Mutation check: flip the catch to deny (`{ limited: true }`) and both status
// assertions fail (429 instead of 200 / 403).
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { PROFILE_COPY } from "../src/islands/contracts";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";

const CANARY = "profile-throttle-store-down-canary-7f3a9c";

const state = vi.hoisted(() => ({ urls: [] as string[] }));

// Throwing throttle store at the driver boundary: every Postgres client built
// on the write path fails its throttle transaction with the canary. Only the
// driver is doubled; `admitWrite` and the real `checkJoinThrottle` run.
vi.mock("postgres", () => ({
  default: (url: string) => {
    state.urls.push(url);
    return {
      begin: async () => {
        throw new Error(CANARY);
      },
    };
  },
}));

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";
// DATABASE_URL present so admitWrite takes the real Postgres-throttle branch
// (absent URL admits without touching a store — a different path, not this pin).
const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
  DATABASE_URL: "postgres://throttle-store-down.invalid/db",
};

const ALICE = { userId: "326474832151838721", username: "alice", member: true, moderator: false };
const BOB = { userId: "326474832151838722", username: "bob", member: true, moderator: false };
type Who = typeof ALICE;

async function cookieFor(sessions: SessionStore, who: Who): Promise<string> {
  const token = newSessionToken();
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: who.userId,
    username: who.username,
    avatar: null,
    member: who.member,
    moderator: who.moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

async function setup() {
  state.urls = [];
  const store = createMemoryProfileStore([
    {
      id: ALICE.userId,
      username: "alice",
      avatar: null,
      bio: "alice original",
      games: ["Chess"],
      timezone: "Europe/London",
    },
    { id: BOB.userId, username: "bob", avatar: null, bio: null, games: [], timezone: null },
  ]);
  const sessions = createMemorySessionStore();
  // No `throttle` dep: the real admitWrite throttle branch runs.
  const app = profilesApp({ sessionStore: sessions, store });
  return { app, sessions, store };
}

const jsonPatch = (cookie: string, body: Record<string, unknown>) => ({
  method: "PATCH",
  headers: {
    cookie,
    origin: APP_URL,
    "content-type": "application/json",
    accept: "application/json",
  },
  body: JSON.stringify(body),
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("profile writes degrade to allow when the throttle store throws", () => {
  it("the owner write proceeds", async () => {
    const { app, sessions, store } = await setup();
    const cookie = await cookieFor(sessions, ALICE);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "rewritten", games: ["Doom"], timezone: "America/New_York" }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ saved: true, message: PROFILE_COPY.saved });
    expect(await store.find(ALICE.userId)).toMatchObject({ bio: "rewritten" });
    // The real throttle branch ran: a Postgres client was built, then threw.
    expect(state.urls).toHaveLength(1);
  });

  it("a non-owner still 403s and no row changes", async () => {
    const { app, sessions, store } = await setup();
    const before = await store.find(ALICE.userId);
    const cookie = await cookieFor(sessions, BOB);
    const res = await app.request(
      `/members/${ALICE.userId}`,
      jsonPatch(cookie, { bio: "hijacked", games: [], timezone: "UTC" }),
      env,
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("Forbidden");
    expect(await store.find(ALICE.userId)).toEqual(before);
  });

  it("the thrown store error text never reaches the console", async () => {
    const calls: unknown[][] = [];
    for (const level of ["error", "warn", "log"] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        calls.push(args);
      });
    }
    const { app, sessions } = await setup();
    const alice = await cookieFor(sessions, ALICE);
    const bob = await cookieFor(sessions, BOB);
    expect(
      (
        await app.request(
          `/members/${ALICE.userId}`,
          jsonPatch(alice, { bio: "x", games: [], timezone: "UTC" }),
          env,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await app.request(
          `/members/${ALICE.userId}`,
          jsonPatch(bob, { bio: "x", games: [], timezone: "UTC" }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(JSON.stringify(calls)).not.toContain(CANARY);
  });
});
