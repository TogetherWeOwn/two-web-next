// Guest-bounce return destinations in the Kit member-board load
// (src/kit-members.ts guestIntendedCookie): a safe destination becomes the
// signed login_intended cookie, while hostile, oversized, unparseable or
// unsignable destinations clear stale intended state instead of crashing the
// bounce. Hermetic: no database, no network, no clock.
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { loadMembersBoardData } from "../src/kit-members";
import {
  consumeLoginReturn,
  JOURNEY_TTL_SECONDS,
  LOGIN_INTENDED_COOKIE,
} from "../src/return-journey";

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP = "https://next.example.test";
const DESTINATION = "/leaderboards/members?season=2026-Q3";
const env: Env = {
  APP_URL: APP,
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET,
};

const guestArgs = (overrides: Record<string, unknown> = {}) => ({
  env,
  session: { status: "guest", userId: null, member: false } as const,
  seasonParam: null,
  scopeParam: null,
  activityParam: null,
  setHeaders: () => {},
  dbForFn: async () => null,
  ...overrides,
});

async function bounceCookie(overrides: Record<string, unknown>): Promise<string | undefined> {
  let caught: (Error & { status?: number; intendedCookie?: string }) | undefined;
  try {
    await loadMembersBoardData(guestArgs(overrides));
  } catch (error) {
    caught = error as Error & { status?: number; intendedCookie?: string };
  }
  expect(caught?.status).toBe(302);
  return caught?.intendedCookie;
}

const consume = async (cookie: string) => {
  const app = new Hono<{ Bindings: Env }>();
  app.get("/", async (c) => c.text((await consumeLoginReturn(c)) ?? "default"));
  return app.request("/", { headers: { cookie } }, env);
};

describe("Kit member-board guest intended cookie", () => {
  it("signs a safe destination the login-return consumer verifies", async () => {
    const intendedCookie = await bounceCookie({ url: `${APP}${DESTINATION}` });
    expect(intendedCookie).toContain(`${LOGIN_INTENDED_COOKIE}=`);
    expect(intendedCookie).toContain(`Max-Age=${JOURNEY_TTL_SECONDS}`);
    expect(intendedCookie).toContain("HttpOnly");
    const pair = intendedCookie!.split(";")[0]!;
    expect(await (await consume(pair)).text()).toBe(DESTINATION);
  });

  it("clears stale intended state for hostile and oversized destinations", async () => {
    for (const url of [
      `${APP}//evil.test/phish`,
      `${APP}/leaderboards/members?x=${"a".repeat(600)}`,
    ]) {
      const intendedCookie = await bounceCookie({ url });
      expect(intendedCookie).toContain(`${LOGIN_INTENDED_COOKIE}=`);
      expect(intendedCookie).toContain("Max-Age=0");
      expect(intendedCookie).not.toContain(`Max-Age=${JOURNEY_TTL_SECONDS}`);
      expect(intendedCookie).not.toContain("evil.test");
    }
  });

  it("clears stale intended state for an unparseable destination", async () => {
    const intendedCookie = await bounceCookie({ url: "::::" });
    expect(intendedCookie).toContain(`${LOGIN_INTENDED_COOKIE}=`);
    expect(intendedCookie).toContain("Max-Age=0");
  });

  it("resolves no cookie instruction without a signer secret", async () => {
    const noSecret = { ...env, SESSION_SECRET: "" };
    const intendedCookie = await bounceCookie({ env: noSecret, url: `${APP}${DESTINATION}` });
    expect(intendedCookie).toBeUndefined();
  });
});
