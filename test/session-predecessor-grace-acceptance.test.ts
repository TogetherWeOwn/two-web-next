// route-inventory: GET /
// route-inventory: GET /profile
// route-inventory: POST /logout
// route-inventory: GET /auth/discord/callback
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "../src/sessions";
import { fixtureDiscord, MEMBER, mergeCookies, recoveryFixture } from "./fixtures/session-recovery";

// The spec leaves the exact short TTL open: accept a one-second-old predecessor,
// refuse it by one minute. Neither token's normal 120-minute expiry has elapsed.
// These are black-box bounds, not a prescribed grace duration or storage shape.
const START = Date.parse("2030-01-01T12:00:00Z");
const INSIDE = 1000;
const OUTSIDE = 60_000;
const SESSION_COOKIE = "__Host-two_session";
type Fixture = ReturnType<typeof recoveryFixture>;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(START);
  vi.stubGlobal("fetch", fixtureDiscord);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function bearerHash(cookie: string) {
  const pair = cookie.split("; ").find((value) => value.startsWith(`${SESSION_COOKIE}=`));
  expect(pair, "a live session bearer must have been issued").toBeDefined();
  const signed = decodeURIComponent(pair!.slice(SESSION_COOKIE.length + 1));
  return hashToken(signed.slice(0, signed.lastIndexOf(".")));
}

/** Tab A receives the replacement; tab B still presents its original cookie jar. */
async function rotatedTabs() {
  const f = recoveryFixture();
  const login = await f.login(new Date(START + 120 * 60_000));
  const profile = await f.request("/profile", { headers: { cookie: login.cookie } });
  expect(profile.status).toBe(200);
  const predecessor = mergeCookies(login.cookie, profile);
  const page = await f.request("/", { headers: { cookie: predecessor } });
  expect(page.status).toBe(200);
  expect(await page.text()).toContain("Fixture member");
  const successor = mergeCookies(predecessor, page);
  const successorHash = await bearerHash(successor);
  expect(successorHash).not.toBe(login.tokenHash);
  expect(await f.sessions.get(successorHash)).toMatchObject({ userId: MEMBER, member: true });
  return { f, predecessor, successor, successorHash, lineage: login.tokenHash };
}

const readers = [
  {
    name: "rotating page read",
    async check(f: Fixture, cookie: string, authenticated: boolean) {
      const response = await f.request("/", { headers: { cookie } });
      expect(response.status).toBe(200);
      const html = await response.text();
      if (authenticated) expect(html).toContain("Fixture member");
      else {
        expect(html).toContain("Sign in with Discord");
        expect(html).not.toContain("Fixture member");
      }
      return response;
    },
  },
  {
    name: "member gate",
    async check(f: Fixture, cookie: string, authenticated: boolean) {
      const response = await f.request("/profile", { headers: { cookie } });
      expect(response.status).toBe(authenticated ? 200 : 302);
      if (authenticated) expect(await response.text()).toContain("Edit your profile");
      else expect(response.headers.get("location")).toBe("/auth/discord");
      return response;
    },
  },
];

async function logout(f: Fixture, cookie: string) {
  const response = await f.request("/logout", {
    method: "POST",
    headers: { cookie, origin: f.env.APP_URL },
  });
  expect(response.status).toBe(303);
  expect(response.headers.get("location")).toBe("/");
}

describe.each(readers)("short predecessor grace: $name", (reader) => {
  it("authenticates tab B's immediate predecessor while tab A's successor is live", async () => {
    const { f, predecessor, successorHash } = await rotatedTabs();
    vi.setSystemTime(START + INSIDE);
    expect(await f.sessions.get(successorHash)).toMatchObject({ userId: MEMBER });

    await reader.check(f, predecessor, true);
  });

  it("refuses the predecessor after grace while the successor is still live", async () => {
    const { f, predecessor, successorHash } = await rotatedTabs();
    vi.setSystemTime(START + OUTSIDE);
    expect(await f.sessions.get(successorHash)).toMatchObject({ userId: MEMBER });

    await reader.check(f, predecessor, false);
    expect(await f.sessions.get(successorHash)).toMatchObject({ userId: MEMBER });
  });

  it.each([
    "successor revoke",
    "lineage revoke",
    "user revoke",
    "successor logout",
    "predecessor logout",
  ] as const)("%s kills predecessor authentication inside grace", async (action) => {
    const { f, predecessor, successor, successorHash, lineage } = await rotatedTabs();
    // An unrelated login lineage must survive lineage-scoped invalidation, but
    // not the fresh-login/user-wide sweep. This also detects a global kill switch.
    const independent = await f.login();
    vi.setSystemTime(START + INSIDE);
    switch (action) {
      case "successor revoke":
        await f.sessions.revoke(successorHash);
        break;
      case "lineage revoke":
        await f.sessions.revokeLineage(lineage);
        break;
      case "user revoke": {
        const fresh = await f.login();
        await f.sessions.revokeUserSessions(MEMBER, fresh.tokenHash);
        expect(await f.sessions.get(fresh.tokenHash)).toMatchObject({ userId: MEMBER });
        break;
      }
      case "successor logout":
        await logout(f, successor);
        break;
      case "predecessor logout":
        await logout(f, predecessor);
        break;
    }

    await reader.check(f, predecessor, false);
    await reader.check(f, successor, false);
    expect(await f.sessions.get(successorHash)).toBeNull();
    if (action === "user revoke") expect(await f.sessions.get(independent.tokenHash)).toBeNull();
    else expect(await f.sessions.get(independent.tokenHash)).toMatchObject({ userId: MEMBER });
  });
});

it("an authenticated predecessor read cannot fork a lineage that survives logout", async () => {
  const { f, predecessor, successor } = await rotatedTabs();
  vi.setSystemTime(START + INSIDE);
  const page = await readers[0]!.check(f, predecessor, true);
  const tabB = mergeCookies(predecessor, page);
  const tabBHash = await bearerHash(tabB);
  expect(await f.sessions.get(tabBHash)).toMatchObject({ userId: MEMBER });

  await logout(f, successor);

  // Exercise the nonrotating gate first so the proof cannot accidentally revoke
  // or replace a surviving fork by rotating it during the assertions.
  for (const cookie of [predecessor, successor, tabB]) {
    await readers[1]!.check(f, cookie, false);
    await readers[0]!.check(f, cookie, false);
  }
  expect(await f.sessions.get(tabBHash)).toBeNull();
});

it("fresh Discord login still sweeps both rotated tabs and another live row", async () => {
  const { f, predecessor, successor, successorHash, lineage } = await rotatedTabs();
  const independent = await f.login();
  vi.setSystemTime(START + INSIDE);
  const start = await f.request("/auth/discord");
  expect(start.status).toBe(302);
  const state = new URL(start.headers.get("location")!).searchParams.get("state");
  expect(state).toBeTruthy();
  const admittedJar = mergeCookies(predecessor, start);
  const callback = await f.request(`/auth/discord/callback?code=fixture&state=${state}`, {
    headers: { cookie: admittedJar },
  });
  expect(callback.status).toBe(302);
  const fresh = mergeCookies(admittedJar, callback);
  const freshHash = await bearerHash(fresh);
  expect([lineage, successorHash, independent.tokenHash]).not.toContain(freshHash);
  expect(await f.sessions.get(freshHash)).toMatchObject({ userId: MEMBER });

  for (const cookie of [predecessor, successor, independent.cookie]) {
    await readers[1]!.check(f, cookie, false);
    await readers[0]!.check(f, cookie, false);
  }
  for (const hash of [lineage, successorHash, independent.tokenHash]) {
    expect(await f.sessions.get(hash)).toBeNull();
  }
  await readers[1]!.check(f, fresh, true);
});
