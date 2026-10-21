// route-inventory: GET /join
// The join page renders the invite floor, not the raw env value: with a
// misconfigured or hostile DISCORD_INVITE_URL (evil host, javascript:,
// non-Discord scheme), the Hono join-invite href serves FALLBACK_INVITE and
// the configured value leaves no trace in the HTML — the same rule /discord
// already applies through inviteDestination. Valid configured
// invites pass through unchanged, so the existing join-invite href pins keep
// passing. The Kit load cannot run in the root test process
// (cloudflare:workers), so its boundary is pinned by reading it as text, the
// same way test/join-kit-page.test.ts pins the Kit markup contract.
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import { FALLBACK_INVITE } from "../src/invite";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: FALLBACK_INVITE,
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const hostileInvites = [
  "https://evil.test/invite",
  "javascript:alert(1)",
  "data:text/html,unsafe",
  "http://discord.gg/example",
  "ftp://discord.com/invite/example",
  "//discord.gg/example",
  "https://discord.gg.evil.test/Ab12",
];

const validInvites = [
  "https://discord.gg/Ab_12-cD",
  "https://discord.com/invite/Ab_12-cD",
  "https://discord.gg/Ab12?utm_source=web&utm_campaign=join#campaign",
];

beforeEach(() => vi.spyOn(console, "error").mockImplementation(() => {}));
afterEach(() => vi.restoreAllMocks());

describe("GET /join invite floor", () => {
  it.each(hostileInvites)(
    "serves the fallback href and never the configured value: %s",
    async (configured) => {
      const res = await app.request("/join", {}, { ...env, DISCORD_INVITE_URL: configured });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`href="${FALLBACK_INVITE}" data-testid="join-invite"`);
      expect(html).not.toContain(configured);
    },
  );

  it.each(validInvites)(
    "passes a usable configured invite through unchanged: %s",
    async (configured) => {
      const res = await app.request("/join", {}, { ...env, DISCORD_INVITE_URL: configured });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(
        `href="${configured.replaceAll("&", "&amp;")}" data-testid="join-invite"`,
      );
      expect(console.error).not.toHaveBeenCalled();
    },
  );
});

describe("Kit GET /join invite floor", () => {
  const load = readFileSync(
    new NodeURL("../web/src/routes/join/+page.server.ts", import.meta.url),
    "utf8",
  );

  it("resolves the raw env value through inviteDestination", () => {
    expect(load).toContain('inviteDestination } from "../../../../src/invite"');
    expect(load).toContain("inviteUrl: inviteDestination(env.DISCORD_INVITE_URL),");
    expect(load).not.toContain("inviteUrl: env.DISCORD_INVITE_URL,");
  });
});
