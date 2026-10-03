// Recovery CTAs stay usable during a store outage.
//
// During a DB/session-store outage the 500 page renders, but its old
// Join-with-Discord CTA needed the session store (OAuth start) and was dead.
// The 503 page states this explicitly and uses the invite URL instead. This
// pins the invariant: 500/429 carry the error-invite CTA (body and header)
// and no /auth/discord href; 503 unchanged. Hermetic: local fixtures only,
// no live services.
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internalErrorHandler, maintenanceHandler, rateLimitExceeded } from "../src/errors";
import type { Env } from "../src/env";
import { FALLBACK_INVITE } from "../src/invite";

const INVITE = "https://discord.gg/invite";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: INVITE,
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("recovery CTA fixtures must remain offline");
    }),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function errors() {
  const fixture = new Hono();
  fixture.get("/429", (c) => rateLimitExceeded(c));
  fixture.get("/500", (c) => internalErrorHandler(new Error("private fixture details"), c));
  fixture.get("/503", maintenanceHandler(INVITE));
  return fixture;
}

function assertInviteCta(html: string) {
  expect(html).toContain('data-testid="error-invite"');
  expect(html).toContain("Use the Discord invite instead");
  expect(html).toContain(`href="${INVITE}"`);
  expect(html).not.toContain('data-testid="error-join"');
  expect(html).not.toContain('href="/auth/discord"');
}

describe("500/429 recovery CTAs use the Discord invite URL like 503", () => {
  it("500 carries the error-invite CTA and no OAuth start", async () => {
    const response = await errors().request("/500", {}, env);
    expect(response.status).toBe(500);
    const html = await response.text();
    expect(html).toContain("Something broke on our side");
    assertInviteCta(html);
    expect(html).toContain('data-testid="error-home"');
  });

  it("429 carries the error-invite CTA and no OAuth start", async () => {
    const response = await errors().request("/429", {}, env);
    expect(response.status).toBe(429);
    const html = await response.text();
    expect(html).toContain("Slow down a little");
    assertInviteCta(html);
    expect(html).toContain('data-testid="error-home"');
  });

  it("503 unchanged: invite CTA, retry link, no OAuth start", async () => {
    const response = await errors().request("/503", {}, env);
    expect(response.status).toBe(503);
    const html = await response.text();
    expect(html).toContain("We will be right back");
    assertInviteCta(html);
    expect(html).toContain('data-testid="error-retry"');
  });

  it("500/429 fall back to the hardcoded invite when config is unusable", async () => {
    const bad = { ...env, DISCORD_INVITE_URL: "https://evil.test/steal" };
    for (const path of ["/500", "/429"]) {
      const html = await (await errors().request(path, {}, bad)).text();
      expect(html).toContain('data-testid="error-invite"');
      expect(html).toContain(`href="${FALLBACK_INVITE}"`);
      expect(html).not.toContain('data-testid="error-join"');
      expect(html).not.toContain('href="/auth/discord"');
    }
  });
});
