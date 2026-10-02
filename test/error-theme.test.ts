import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { internalErrorHandler, maintenanceHandler, notFoundHandler, notFoundResponse, rateLimitExceeded } from "../src/errors";
import type { Env } from "../src/env";
import app from "./app";

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "fixture",
  DISCORD_CLIENT_SECRET: "fixture",
  DISCORD_GUILD_ID: "123456789012345678",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_BOT_TOKEN: "fixture",
  SESSION_SECRET: "fixture-secret-longer-than-32-bytes",
};

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("error theme fixtures must remain offline"); }));
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  expect(fetch).not.toHaveBeenCalled();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function errors() {
  const fixture = new Hono();
  fixture.notFound(notFoundHandler);
  fixture.get("/suggestions", (c) => notFoundResponse(c, [{
    key: "game night", title: "Co-op evening", startsAt: new Date("2030-07-04T19:00:00Z"), location: "Voice lobby",
  }]));
  fixture.get("/429", (c) => rateLimitExceeded(c));
  fixture.get("/500", (c) => internalErrorHandler(new Error("private fixture details"), c));
  fixture.get("/503", maintenanceHandler(env.DISCORD_INVITE_URL!));
  return fixture;
}

function assertTheme(html: string) {
  expect(html).toContain('<body class="base-theme homepage-theme"><a class="skip-link"');
  expect(html).toContain('href="/theme.css"');
  expect(html).toContain('href="/fonts/display-latin-700.woff2"');
  expect(html).toContain('<header class="bar site-header">');
  expect(html).toContain('src="/logo.svg"');
  expect(html).toContain('class="hero recovery-hero"');
  expect(html).toContain('<main id="main" tabindex="-1">');
  expect(html).toContain('<nav aria-label="Site">');
  expect(html).not.toContain('aria-current="page"');
  expect(html).not.toContain('<script');
  expect(html).not.toContain('<iframe');
}

describe("base-theme error and recovery shells without a DB binding", () => {
  it.each([404, 429, 500, 503])("renders %i with shared chrome and unchanged refusal headers", async (status) => {
    const response = await errors().request(status === 404 ? "/missing" : `/${status}`, {}, env);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const html = await response.text();
    assertTheme(html);
    expect(html).toContain(`class="recovery-code" aria-hidden="true">${status}</p>`);
    expect(html).toContain('name="robots" content="noindex, nofollow"');
    expect(html).not.toContain("private fixture details");
    if (status === 503) {
      expect(html).not.toMatch(/href="\/auth\//);
      expect(html.match(/href="https:\/\/discord.gg\/invite"/g)).toHaveLength(2);
    }
  });

  it("keeps suggested events and labelled search outside the error hero", async () => {
    const response = await errors().request("/suggestions", {}, env);
    expect(response.status).toBe(404);
    const html = await response.text();
    assertTheme(html);
    expect(html).toContain('href="/e/game%20night"');
    expect(html).toContain("Co-op evening");
    expect(html).toMatch(/<\/section><section class="recovery-events"/);
    expect(html).toContain('<label for="error-events-search">Search events</label>');
    expect(html).toContain('action="/events" method="get" role="search"');
  });

  it("retains the empty event fallback when no binding is configured", async () => {
    const html = await (await errors().request("/missing", {}, env)).text();
    expect(html).toContain('data-testid="error-events-empty"');
    expect(html).toContain('href="/events" data-testid="error-all-events"');
    expect(html).toContain('name="q" type="search"');
  });

  it("renders the actual denied OAuth callback without session or DB access", async () => {
    const response = await app.request("/join/callback?error=access_denied", {}, env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, private");
    const html = await response.text();
    assertTheme(html);
    expect(html).toContain('id="recovery-heading"');
    expect(html).toContain('href="/join/discord" data-testid="recovery-retry"');
    expect(html).toContain('href="https://discord.gg/invite" data-testid="recovery-invite"');
  });
});
