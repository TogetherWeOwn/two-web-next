// Clearing Set-Cookies must carry the same flags as the cookies they clear.
//
// ZAP 10010 (cookie without HttpOnly) and 10054 (cookie without SameSite)
// flag every Set-Cookie missing those attributes — including deletions. An
// unauthenticated spider trips deletions on the OAuth round trip
// (/auth/discord with no ?next=, every terminal /auth/discord/callback),
// on every admitted /join/callback, and on POST /logout, so the clearing
// responses must be flagged the same as the sets. Local fixtures only: no
// database, no Discord.
import { describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/fixture",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

// A clearing Set-Cookie is an empty value or Max-Age=0; ZAP flags it exactly
// like a set when HttpOnly or SameSite is missing.
function flaggedDeletions(res: Response): string[] {
  return res.headers
    .getSetCookie()
    .filter((c) => /(?:^|;\s*)(?:[^=;]+=\s*(?:;|$)|[^;]*max-age=0)/i.test(c))
    .filter((c) => !/httponly/i.test(c) || !/samesite=lax/i.test(c));
}

function assertAllFlagged(res: Response, where: string): void {
  const cookies = res.headers.getSetCookie();
  expect(cookies.length, `${where} sets no cookies`).toBeGreaterThan(0);
  for (const c of cookies) {
    expect(c, `${where}: ${c}`).toMatch(/httponly/i);
    expect(c, `${where}: ${c}`).toMatch(/samesite=lax/i);
  }
}

describe("clearing cookies carry HttpOnly + SameSite=Lax (ZAP 10010/10054)", () => {
  it("GET /auth/discord with no ?next= clears the explicit return cookie flagged", async () => {
    const res = await app.request("/auth/discord", {}, env);
    expect(res.status).toBe(302);
    expect(flaggedDeletions(res)).toEqual([]);
    assertAllFlagged(res, "GET /auth/discord");
  });

  it("an admitted /auth/discord/callback denial clears flagged", async () => {
    // Only admitted (terminal) callback hits clear: an unadmitted stray
    // sets no cookies at all, so flag hygiene is exercised through a denial
    // that presents the matching state.
    const storeEnv = { ...env, SESSION_STORE: createMemorySessionStore() } as unknown as Env;
    const start = await app.request("/auth/discord?next=%2Fevents", {}, storeEnv);
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect(state).toBeTruthy();
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const denied = await app.request(
      `/auth/discord/callback?error=access_denied&state=${state}`,
      { headers: { cookie } },
      storeEnv,
    );
    expect(denied.headers.get("location")).toBe("/?n=signin_denied");
    expect(flaggedDeletions(denied)).toEqual([]);
    assertAllFlagged(denied, "GET /auth/discord/callback denial");
  });

  it("an admitted /join/callback denial clears the join journey cookies flagged", async () => {
    // Only an admitted callback owns journey cleanup, so flag hygiene is
    // exercised through a genuine denial that presents the matching signed
    // state (mirroring the auth denial above), not a bare hit whose empty
    // Set-Cookie list would make the flag checks vacuous.
    const storeEnv = { ...env, SESSION_STORE: createMemorySessionStore() } as unknown as Env;
    const start = await app.request(
      "/join/discord?next=%2Fevents&source=web-homepage",
      {},
      storeEnv,
    );
    expect(start.status).toBe(302);
    const state = new URL(start.headers.get("location")!).searchParams.get("state");
    expect(state).toBeTruthy();
    const cookie = start.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    // An unadmitted hit carrying the live jar must not emit any journey
    // Set-Cookie at all: the pending journey survives byte-for-byte, which
    // the admitted denial below then proves by still being admissible.
    const joinCookies = ["__Host-two_join_state", "__Host-two_join_source", "__Host-two_join_next"];
    const stray = await app.request(
      "/join/callback?error=access_denied",
      { headers: { cookie } },
      storeEnv,
    );
    expect(stray.status).toBe(200);
    expect(
      stray.headers
        .getSetCookie()
        .filter((c) => joinCookies.some((name) => c.startsWith(`${name}=`))),
    ).toEqual([]);

    const denied = await app.request(
      `/join/callback?error=access_denied&state=${state}`,
      { headers: { cookie } },
      storeEnv,
    );
    expect(denied.status).toBe(200);
    expect(await denied.text()).toContain("Join cancelled");
    expect(flaggedDeletions(denied)).toEqual([]);
    assertAllFlagged(denied, "GET /join/callback denial");
    // Non-vacuous: an actual deletion header per journey cookie, each
    // mirroring the set attributes the scanner requires.
    for (const name of joinCookies) {
      const header = denied.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
      expect(header, `${name} deletion header`).toBeDefined();
      expect(header, name).toContain(`${name}=;`);
      expect(header, name).toMatch(/max-age=0/i);
      expect(header, name).toMatch(/httponly/i);
      expect(header, name).toMatch(/secure/i);
      expect(header, name).toMatch(/samesite=lax/i);
      expect(header, name).toMatch(/path=\/(?:;|$)/i);
    }
  });

  it("POST /logout clears session, probe and recovery cookies flagged", async () => {
    const res = await app.request(
      "/logout",
      { method: "POST", headers: { origin: env.APP_URL } },
      env,
    );
    expect(res.status).toBe(303);
    expect(flaggedDeletions(res)).toEqual([]);
    assertAllFlagged(res, "POST /logout");
  });
});
