// Signing-outage arm of the Kit member-board guest bounce
// (src/kit-members.ts guestIntendedCookie): when the cookie signer throws,
// the bounce clears stale intended state instead of crashing. Hermetic: the
// signer module is stubbed, no database, no network, no clock.
import { describe, expect, it, vi } from "vitest";

vi.mock("hono/utils/cookie", async (importOriginal) => ({
  ...(await importOriginal<typeof import("hono/utils/cookie")>()),
  serializeSigned: async () => {
    throw new Error("signer down");
  },
}));

import type { Env } from "../src/env";
import { loadMembersBoardData } from "../src/kit-members";
import { JOURNEY_TTL_SECONDS, LOGIN_INTENDED_COOKIE } from "../src/return-journey";

const APP = "https://next.example.test";
const env: Env = {
  APP_URL: APP,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "guest-signing-fallback-secret-at-least-32",
};

describe("Kit member-board guest signing fallback", () => {
  it("a throwing signer clears stale intended state, never crashes the bounce", async () => {
    let caught: (Error & { status?: number; intendedCookie?: string }) | undefined;
    try {
      await loadMembersBoardData({
        env,
        session: { status: "guest", userId: null, member: false },
        seasonParam: null,
        scopeParam: null,
        activityParam: null,
        setHeaders: () => {},
        dbForFn: async () => null,
        url: `${APP}/leaderboards/members?season=2026-Q3`,
      });
    } catch (error) {
      caught = error as Error & { status?: number; intendedCookie?: string };
    }
    expect(caught?.status).toBe(302);
    expect(caught?.intendedCookie).toContain(`${LOGIN_INTENDED_COOKIE}=`);
    expect(caught?.intendedCookie).toContain("Max-Age=0");
    expect(caught?.intendedCookie).not.toContain(`Max-Age=${JOURNEY_TTL_SECONDS}`);
  });
});
