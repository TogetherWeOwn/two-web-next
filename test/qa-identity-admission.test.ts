import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { QA_HEADER, STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore, hashToken } from "../src/sessions";

const TOKEN = "test-only-qa-identity-token";
const NOW = Date.UTC(2026, 9, 1);
const SESSION_COOKIE = "__Host-two_session";
const env: Env = {
  APP_URL: STAGING_APP_URL,
  DISCORD_CLIENT_ID: "test-client",
  DISCORD_CLIENT_SECRET: "test-client-secret",
  DISCORD_GUILD_ID: "test-guild",
  DISCORD_BOT_TOKEN: "test-bot-token",
  DISCORD_INVITE_URL: "https://discord.gg/test-invite",
  SESSION_SECRET: "test-session-signing-key-at-least-32-bytes",
  QA_AUTH_TOKEN: TOKEN,
};

// No DB bindings or live credentials: even persistence selection is observable.
function isolated(overrides: Partial<Env> = {}) {
  const store = createMemorySessionStore(() => NOW);
  const create = vi.spyOn(store, "create");
  const selectSessionStore = vi.fn(() => store);
  const selectRosterStore = vi.fn(() => null);
  const bindings = Object.defineProperties(
    { ...env, ...overrides },
    {
      SESSION_STORE: { get: selectSessionStore },
      ROSTER_STORE: { get: selectRosterStore },
    },
  );
  return { bindings, store, create, selectSessionStore, selectRosterStore };
}

const login = (bindings: Env, identity: string, token = TOKEN) =>
  app.request(
    `/auth/qa/${identity}`,
    {
      method: "POST",
      headers: { origin: new URL(bindings.APP_URL).origin, [QA_HEADER]: token },
    },
    bindings,
  );

beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(NOW);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("QA fixtures must not use the network");
    }),
  );
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function expectRefusal(fixture: ReturnType<typeof isolated>, response: Response) {
  const unknown = await login(fixture.bindings, "not-a-qa-identity");
  expect(unknown.status).toBe(404);
  expect(response.status).toBe(404);
  expect(await response.text()).toBe(await unknown.text());
  expect(response.headers.getSetCookie()).toHaveLength(0);
  expect(unknown.headers.getSetCookie()).toHaveLength(0);
  expect(fixture.selectSessionStore).not.toHaveBeenCalled();
  expect(fixture.selectRosterStore).not.toHaveBeenCalled();
  expect(fixture.create).not.toHaveBeenCalled();
}

describe("QA identity admission before session issuance", () => {
  it.each(["toString", "constructor", "__proto__", "hasOwnProperty", "unknown"])(
    "rejects %s like an unknown identity without selecting persistence",
    async (identity) => {
      const fixture = isolated();
      await expectRefusal(fixture, await login(fixture.bindings, identity));
    },
  );

  it.each(["", "wrong-test-token"])("rejects presented token %j", async (token) => {
    const fixture = isolated();
    await expectRefusal(fixture, await login(fixture.bindings, "qa-member", token));
  });

  it("rejects a missing token", async () => {
    const fixture = isolated();
    const response = await app.request(
      "/auth/qa/qa-member",
      {
        method: "POST",
        headers: { origin: STAGING_APP_URL },
      },
      fixture.bindings,
    );
    await expectRefusal(fixture, response);
  });

  it.each([undefined, ""])("fails closed for configured token %j", async (token) => {
    const fixture = isolated({ QA_AUTH_TOKEN: token });
    await expectRefusal(fixture, await login(fixture.bindings, "qa-member"));
  });

  it.each([
    "https://togetherweown.com",
    "https://next.togetherweown.com.attacker.test",
    "http://next.togetherweown.com",
    `${STAGING_APP_URL}/`,
  ])("fails closed for APP_URL %s", async (appUrl) => {
    const fixture = isolated({ APP_URL: appUrl });
    const response = await app.request(
      "/auth/qa/qa-member",
      {
        method: "POST",
        headers: { origin: new URL(appUrl).origin, [QA_HEADER]: TOKEN },
      },
      fixture.bindings,
    );
    await expectRefusal(fixture, response);
  });

  it.each([
    ["qa-member", "900000000000001396", "QA Member", false],
    ["qa-moderator", "900000000000001397", "QA Moderator", true],
  ] as const)(
    "issues the normal exact identity for %s",
    async (identity, userId, username, moderator) => {
      const fixture = isolated();
      const response = await login(fixture.bindings, identity);
      expect(response.status).toBe(204);
      expect(await response.text()).toBe("");
      expect(fixture.selectSessionStore).toHaveBeenCalledTimes(1);
      expect(fixture.selectRosterStore).toHaveBeenCalledTimes(1);
      expect(fixture.create).toHaveBeenCalledTimes(1);
      const cookies = response.headers.getSetCookie();
      expect(cookies).toHaveLength(2);
      const cookie = cookies.find((c) => c.startsWith(SESSION_COOKIE + "="))!;
      const status = cookies.find((c) => c.startsWith("__Host-two_session_status="))!;
      for (const flag of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax", "Max-Age=2592000"])
        expect(status).toContain(flag);
      expect(status).not.toMatch(/Domain=/i);
      for (const flag of [
        `${SESSION_COOKIE}=`,
        "Path=/",
        "Secure",
        "HttpOnly",
        "SameSite=Lax",
        "Max-Age=2592000",
      ]) {
        expect(cookie).toContain(flag);
      }
      expect(cookie).not.toMatch(/Domain=/i);
      const bearer = decodeURIComponent(
        cookie.split(";")[0]!.slice(SESSION_COOKIE.length + 1),
      ).split(".")[0]!;
      const tokenHash = await hashToken(bearer);
      const row = { userId, username, avatar: null, member: true, moderator };
      expect(await fixture.store.get(tokenHash)).toEqual(row);
      expect(fixture.create).toHaveBeenCalledWith({
        ...row,
        tokenHash,
        expiresAt: new Date(NOW + 30 * 24 * 60 * 60 * 1000),
      });
    },
  );
});
