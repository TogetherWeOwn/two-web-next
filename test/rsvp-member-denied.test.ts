// route-inventory: PUT /events/:key/rsvp
// route-inventory: DELETE /events/:key/rsvp
// TOG-20410: pin the member-denied matrix for RSVP write admission.
//
// The `member()` guard in src/events/routes-rsvp.tsx rejects non-member
// sessions with 403 before any throttle, event lookup, or writeRsvp call.
// A weakened check (e.g. `if (!session.member)` mutated to always pass) must
// be killed by this test asserting the 403.
//
// Hermetic and DB-free: memory session store only, no DATABASE_URL, stubbed
// fetch, no Discord, no real throttle hits. Matches the sessions-join nightly
// contract exactly.
//
// Scope guard: must not import or edit `src/events/routes-rsvp.tsx`,
// `src/events/rsvp.ts`, `src/events/routes.tsx` or `test/rsvp*.test.ts`
// (mutation hot files). Drives only through the mounted app (`test/app.ts`)
// with memory store and minimal env.

import { describe, expect, it, afterEach, vi } from "vitest";
import { serializeSigned } from "hono/utils/cookie";
import app from "./app";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";
import type { Env } from "../src/env";
import type { SessionStore } from "../src/sessions";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

async function cookieFor(
  store: SessionStore,
  row: { userId: string; username: string; member: boolean; moderator: boolean },
): Promise<string> {
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("RSVP member-denied matrix (TOG-20410)", () => {
  it("non-member session receives 403 forbidden on PUT /events/:key/rsvp", async () => {
    const store = createMemorySessionStore();
    const env = { ...baseEnv, SESSION_STORE: store } as Env;
    const cookie = await cookieFor(store, {
      userId: "nonmember-1",
      username: "nonmember",
      member: false,
      moderator: false,
    });

    const res = await app.request(
      "/events/some-key/rsvp",
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          cookie,
          origin: baseEnv.APP_URL,
        },
        body: JSON.stringify({ status: "going" }),
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "forbidden" });
  });

  it("non-member session receives 403 on DELETE /events/:key/rsvp", async () => {
    const store = createMemorySessionStore();
    const env = { ...baseEnv, SESSION_STORE: store } as Env;
    const cookie = await cookieFor(store, {
      userId: "nonmember-2",
      username: "nonmember2",
      member: false,
      moderator: false,
    });

    const res = await app.request(
      "/events/some-key/rsvp",
      {
        method: "DELETE",
        headers: { cookie, origin: baseEnv.APP_URL },
      },
      env,
    );

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toEqual({ error: "forbidden" });
  });
});
