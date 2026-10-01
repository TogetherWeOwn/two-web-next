// route-inventory: GET /discord
// route-inventory: GET /join/callback
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { FALLBACK_INVITE, inviteDestination } from "../src/invite";
import type { EnvWithJoin } from "../src/join/route";

const validInvites = [
  "https://discord.gg/4GwEDNRTtx",
  "https://discord.gg/Ab_12-cD",
  "https://discord.com/invite/Ab_12-cD",
  "https://DISCORD.GG/Ab12",
  "https://DISCORD.COM/invite/Ab12",
  "https://discord.gg:443/Ab12",
  "https://discord.com:443/invite/Ab12",
  "https://discord.gg/Ab12?utm_source=web&utm_campaign=join%20now#campaign",
  "https://discord.com/invite/Ab12?utm_source=web&utm_campaign=join%20now#campaign",
];

const invalidInvites = [
  "",
  "not a URL",
  "https://",
  "https://discord.gg",
  "https://discord.gg/",
  "https://discord.com",
  "https://discord.com/",
  "https://discord.com/login",
  "https://discord.com/oauth2/authorize?client_id=synthetic",
  "https://discord.com/Ab12",
  "https://discord.com/invite",
  "https://discord.com/invite/",
  "https://discord.com/invite/Ab12/extra",
  "https://discord.gg/Ab12/extra",
  "https://discord.gg/Ab12/",
  "https://discord.gg/Ab%31",
  "https://discord.com/invite/Ab%2F12",
  "https://discord.gg/Ab.12",
  "https://synthetic-user:synthetic-password@discord.gg/Ab12",
  "https://synthetic-user@discord.com/invite/Ab12",
  "https://:synthetic-password@discord.com/invite/Ab12",
  "https://discord.gg:8443/Ab12",
  "https://discord.com:80/invite/Ab12",
  "https://discord.gg.evil.test/Ab12",
  "https://evil-discord.com/invite/Ab12",
  "https://discord.gg@evil.test/Ab12",
  "https://www.discord.gg/Ab12",
  "http://discord.gg/Ab12",
  "ftp://discord.com/invite/Ab12",
  "//discord.gg/Ab12",
  "javascript:alert(1)",
  "https://discord.gg/Ab\n12",
  "https://discord.gg/Ab12?campaign=web\r\nX-Synthetic: yes",
  "https://discord.com\\invite\\Ab12",
];

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: FALLBACK_INVITE,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("inviteDestination", () => {
  it.each(validInvites)("preserves an approved invite unchanged: %s", (configured) => {
    expect(inviteDestination(configured)).toBe(configured);
    expect(console.error).not.toHaveBeenCalled();
  });

  it.each(invalidInvites)("falls back without logging the configured value: %s", (configured) => {
    expect(inviteDestination(configured)).toBe(FALLBACK_INVITE);
    expect(console.error).toHaveBeenCalledExactlyOnceWith(
      "services.discord.invite_url is unusable; serving the hardcoded fallback invite.",
    );
  });

  it("keeps the hardcoded fallback usable", () => {
    expect(inviteDestination(FALLBACK_INVITE)).toBe(FALLBACK_INVITE);
    expect(console.error).not.toHaveBeenCalled();
  });
});

describe("GET /discord invite floor", () => {
  it.each([
    [validInvites[7], validInvites[7]],
    [validInvites[8], validInvites[8]],
    ["https://discord.com/login", FALLBACK_INVITE],
    ["https://discord.com/oauth2/authorize", FALLBACK_INVITE],
    ["https://synthetic-user:synthetic-password@discord.gg/Ab12", FALLBACK_INVITE],
    ["https://discord.gg:8443/Ab12", FALLBACK_INVITE],
    ["", FALLBACK_INVITE],
  ])("redirects safely without dependencies or cookies: %s", async (configured, destination) => {
    const dependency = vi.fn(() => { throw new Error("invite floor must not read dependencies"); });
    const e = { ...env, DISCORD_INVITE_URL: configured };
    for (const key of ["DATABASE_URL", "DB", "SESSION_STORE", "SESSION_SECRET", "COUNTS_SNAPSHOT_KV"]) {
      Object.defineProperty(e, key, { get: dependency });
    }
    vi.stubGlobal("fetch", dependency);
    vi.stubGlobal("caches", { open: dependency });

    const res = await app.request("/discord", { headers: { cookie: "__Host-two_session=synthetic" } }, e);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(destination);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.getSetCookie()).toEqual([]);
    expect(dependency).not.toHaveBeenCalled();
  });
});

describe("join recovery invite", () => {
  it.each([
    ["https://discord.com/invite/Ab_12-cD?utm_source=web#campaign", "https://discord.com/invite/Ab_12-cD?utm_source=web#campaign"],
    ["https://discord.com/login", FALLBACK_INVITE],
    ["https://discord.com/oauth2/authorize", FALLBACK_INVITE],
    ["https://synthetic-user:synthetic-password@discord.gg/Ab12", FALLBACK_INVITE],
    ["https://discord.gg:8443/Ab12", FALLBACK_INVITE],
  ])("uses the same validated destination: %s", async (configured, destination) => {
    const e: EnvWithJoin = {
      ...env,
      DISCORD_INVITE_URL: configured,
      JOIN_DEPS: { store: async () => null },
    };
    const network = vi.fn(() => { throw new Error("recovery must not call Discord"); });
    vi.stubGlobal("fetch", network);
    const res = await app.request("/join/callback?error=access_denied", {}, e);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`href="${destination}"`);
    if (configured !== destination) expect(html).not.toContain(configured);
    expect(network).not.toHaveBeenCalled();
  });
});
