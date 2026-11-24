import { generateSignedCookie } from "hono/cookie";
import { expect, vi } from "vitest";
import type { Env } from "../../src/env";
import { writeKitProfile } from "../../src/profiles/kit-write";
import type { Verdict } from "../../src/profiles/routes-shared";
import { createMemoryProfileStore } from "../../src/profiles/store";
import { SESSION_COOKIE } from "../../src/session-cookie";
import { createMemorySessionStore, hashToken, newSessionToken } from "../../src/sessions";

export const OWNER = "111111111111111111";
const OTHER = "222222222222222222";
export const APP_URL = "https://fixture.example.test";
export const REQUEST_ID = "0123456789abcdef";
const secret = "fixture-only-profile-session-signing";
export const PATH = `/members/${OWNER}`;
export const baseline = {
  id: OWNER,
  username: "Fixture Member",
  bio: "Saved baseline",
  avatar: null,
  games: ["Chess"],
  timezone: "UTC",
  leaderboardOptOut: false,
};

export async function fixture(role: "guest" | "owner" | "non-member" | "moderator" = "owner") {
  const sessions = createMemorySessionStore();
  const token = newSessionToken();
  const credentials = await generateSignedCookie(SESSION_COOKIE, token, secret, {
    path: "/",
    secure: true,
  });
  const cookie = role === "guest" ? "" : credentials.split(";")[0]!;
  const id = role === "moderator" ? OTHER : OWNER;
  await sessions.create({
    tokenHash: await hashToken(token),
    userId: id,
    username: "Fixture Viewer",
    avatar: null,
    member: role !== "non-member",
    moderator: role === "moderator",
    expiresAt: new Date(Date.now() + 60_000),
  });
  const sessionGet = vi.spyOn(sessions, "get");
  const rotate = vi.spyOn(sessions, "rotate");
  const env = {
    APP_URL,
    SESSION_SECRET: secret,
    SESSION_STORE: sessions,
    DISCORD_CLIENT_ID: "",
    DISCORD_CLIENT_SECRET: "",
    DISCORD_BOT_TOKEN: "",
    DISCORD_GUILD_ID: "",
    DISCORD_INVITE_URL: "",
  } satisfies Env & { SESSION_STORE: typeof sessions };
  const store = createMemoryProfileStore([baseline]);
  const find = vi.spyOn(store, "find");
  const save = vi.spyOn(store, "save");
  const throttle = vi.fn<(bucket: string) => Promise<Verdict>>(async () => ({ limited: false }));
  const write = (
    body: string | URLSearchParams,
    method = "PATCH",
    headers: Record<string, string> = {},
    path = PATH,
  ) =>
    writeKitProfile(
      new Request(APP_URL + path, {
        method,
        headers: {
          cookie,
          accept: "application/json",
          "content-type":
            typeof body === "string" ? "application/json" : "application/x-www-form-urlencoded",
          ...headers,
        },
        body,
      }),
      env,
      REQUEST_ID,
      { store, throttle, stats: async () => null },
    );
  return { id, write, store, find, save, throttle, sessionGet, rotate };
}

export function response(result: Awaited<ReturnType<typeof writeKitProfile>>): Response {
  expect(result).toBeInstanceOf(Response);
  if (!(result instanceof Response)) throw new Error("Expected an HTTP response");
  return result;
}
