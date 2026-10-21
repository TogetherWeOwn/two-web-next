import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requestBodyLimit } from "../src/body-limit";
import {
  databaseUnavailable,
  internalErrorHandler,
  maintenanceHandler,
  notFoundHandler,
  notFoundResponse,
  payloadTooLarge,
  rateLimitExceeded,
} from "../src/errors";
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
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("error theme fixtures must remain offline");
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
  fixture.notFound(notFoundHandler);
  fixture.get("/suggestions", (c) =>
    notFoundResponse(c, [
      {
        key: "game night",
        title: "Co-op evening",
        startsAt: new Date("2030-07-04T19:00:00Z"),
        location: "Voice lobby",
      },
    ]),
  );
  fixture.get("/429", (c) => rateLimitExceeded(c));
  fixture.get("/500", (c) => internalErrorHandler(new Error("private fixture details"), c));
  fixture.get("/503", maintenanceHandler(env.DISCORD_INVITE_URL!));
  return fixture;
}

function assertTheme(html: string) {
  expect(html).toContain('<body class="base-theme homepage-theme"><a class="skip-link"');
  expect(html).toContain('href="/theme.css"');
  expect(html).toContain('href="/fonts/chakra-petch-latin-700-normal.woff2"');
  expect(html).toContain('<header class="bar site-header">');
  expect(html).toContain('class="brand-lockup"');
  expect(html).toContain('class="hero recovery-hero"');
  expect(html).toContain('<main id="main" tabindex="-1">');
  expect(html).toContain('<nav aria-label="Site">');
  expect(html).not.toContain('aria-current="page"');
  expect(html).not.toContain("<script");
  expect(html).not.toContain("<iframe");
}

describe("base-theme error and recovery shells without a DB binding", () => {
  it.each([404, 429, 500, 503])(
    "renders %i with shared chrome and unchanged refusal headers",
    async (status) => {
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
    },
  );

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

// Table-driven coverage for 429/413 Accept negotiation (quality, specificity,
// q=0, case, machine-only, missing/wildcard). A substring match or early
// cache-header return would fail these.
describe("refusal response Accept negotiation and cache headers", () => {
  function rateFixture() {
    const f = new Hono();
    f.get("/rate", (c) => rateLimitExceeded(c, 45));
    f.post("/events/evt-123/publish", (c) => rateLimitExceeded(c, 30)); // machine-only
    return f;
  }
  function bodyFixture() {
    const f = new Hono();
    f.post("/api/upload", (c) => payloadTooLarge(c));
    f.post("/form", (c) => payloadTooLarge(c));
    f.post("/events", (c) => payloadTooLarge(c)); // machine-only JSON event write
    f.patch("/events/:key", (c) => payloadTooLarge(c)); // machine-only JSON event write
    f.post("/events/:key/publish", (c) => payloadTooLarge(c)); // machine-only JSON event action
    return f;
  }

  it.each([
    // [path, accept, expectedStatus, isJson, hasRetry, cache, vary]
    ["/rate", "application/json", 429, true, true, "no-store, private", "Accept"],
    ["/rate", "text/html", 429, false, true, "no-store, private", "Accept"],
    ["/rate", "*/*", 429, false, true, "no-store, private", "Accept"],
    ["/rate", "", 429, false, true, "no-store, private", "Accept"],
    ["/rate", "APPLICATION/JSON", 429, true, true, "no-store, private", "Accept"],
    ["/rate", "application/json;q=0, text/html", 429, false, true, "no-store, private", "Accept"],
    ["/rate", "text/*, application/json", 429, true, true, "no-store, private", "Accept"],
    ["/events/evt-123/publish", "text/html", 429, true, true, "no-store, private", "Accept"], // machine wins
    ["/rate", "text/html, application/json;q=0.5", 429, false, true, "no-store, private", "Accept"],
  ])(
    "rateLimitExceeded %s Accept:%s -> %i json=%s retry=%s cache=%s vary=%s",
    async (path, accept, status, isJson, hasRetry, cache, vary) => {
      const init: RequestInit = accept ? { headers: { accept } } : {};
      if (path.includes("publish")) init.method = "POST";
      const res = await rateFixture().request(path, init, env);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe(cache);
      expect(res.headers.get("vary")).toBe(vary);
      const expectedRetry = path.includes("publish") ? 30 : 45;
      if (hasRetry) expect(res.headers.get("retry-after")).toBe(String(expectedRetry));
      if (isJson) {
        const body = await res.json();
        expect(body).toMatchObject({ reason: "rate_limited", retry_after: expectedRetry });
      } else {
        const html = await res.text();
        expect(html).toContain("Slow down a little");
      }
    },
  );

  it.each([
    ["/api/upload", "text/html", 413, true, "no-store, private", "Accept"],
    ["/form", "application/json", 413, true, "no-store, private", "Accept"],
    ["/form", "", 413, false, "no-store, private", "Accept"],
    ["/api/upload", "*/*", 413, true, "no-store, private", "Accept"], // /api/ forces json
    ["/events", "", 413, true, "no-store, private", "Accept"], // machine wins, no Accept
    ["/events", "text/html", 413, true, "no-store, private", "Accept"], // machine wins over HTML
    ["/events/abc", "text/html", 413, true, "no-store, private", "Accept"], // PATCH machine wins
    ["/events/abc/publish", "*/*", 413, true, "no-store, private", "Accept"], // action machine wins
  ])(
    "payloadTooLarge %s Accept:%s -> %i json=%s cache=%s vary=%s",
    async (path, accept, status, isJson, cache, vary) => {
      const method = path === "/events/abc" ? "PATCH" : "POST";
      const init: RequestInit = accept ? { method, headers: { accept } } : { method };
      const res = await bodyFixture().request(path, init, env);
      expect(res.status).toBe(status);
      expect(res.headers.get("cache-control")).toBe(cache);
      expect(res.headers.get("vary")).toBe(vary);
      if (isJson) {
        const body = await res.json();
        expect(body).toMatchObject({ reason: "payload_too_large" });
      } else {
        const html = await res.text();
        expect(html).toContain("That request is too large");
      }
    },
  );

  // The real requestBodyLimit("json") path on event writes must refuse
  // oversized bodies with the JSON envelope even when Accept prefers HTML,
  // is a wildcard, or is missing (moderator scripts often omit Accept).
  it.each([
    ["/events", "POST"],
    ["/events/abc", "PATCH"],
    ["/events/abc/publish", "POST"],
  ])("requestBodyLimit(json) %s %s refuses 40 KiB as JSON", async (path, method) => {
    const big = "x".repeat(40 * 1024);
    for (const accept of ["", "text/html", "*/*"]) {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        "content-length": String(big.length),
      };
      if (accept) headers.accept = accept;
      const f = new Hono();
      f.post("/events", requestBodyLimit("json"), (c) => c.json({ ok: true }));
      f.patch("/events/:key", requestBodyLimit("json"), (c) => c.json({ ok: true }));
      f.post("/events/:key/publish", requestBodyLimit("action"), (c) => c.json({ ok: true }));
      const res = await f.request(path, { method, headers, body: big }, env);
      expect(res.status).toBe(413);
      expect(res.headers.get("content-type")).toMatch(/application\/json/);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(await res.json()).toMatchObject({ reason: "payload_too_large" });
    }
  });

  // Vary must merge Accept with earlier dimensions (e.g. Cookie set by the
  // route before refusing) rather than overwrite them; a pre-existing Accept
  // must not be duplicated. Overwriting with a bare "Accept" fails these.
  it.each([
    ["/rate-cookie", "GET", 429],
    ["/body-cookie", "POST", 413],
    ["/outage-cookie", "GET", 503],
  ])("refusal %s keeps the earlier Vary dimension", async (path, method, status) => {
    const f = new Hono();
    f.get("/rate-cookie", (c) => {
      c.header("Vary", "Cookie");
      return rateLimitExceeded(c, 45);
    });
    f.post("/body-cookie", (c) => {
      c.header("Vary", "Cookie");
      return payloadTooLarge(c);
    });
    f.get("/outage-cookie", (c) => {
      c.header("Vary", "Cookie");
      return databaseUnavailable(c);
    });
    const res = await f.request(path, { method }, env);
    expect(res.status).toBe(status);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("vary")).toBe("Cookie, Accept");
  });

  it.each([
    ["/rate-accept", "Accept"],
    ["/rate-accept-lower", "accept"],
  ])("refusal %s does not duplicate a prior Accept dimension", async (path, prior) => {
    const f = new Hono();
    f.get("/rate-accept", (c) => {
      c.header("Vary", "Accept");
      return rateLimitExceeded(c, 45);
    });
    f.get("/rate-accept-lower", (c) => {
      c.header("Vary", "accept");
      return rateLimitExceeded(c, 45);
    });
    const res = await f.request(path, {}, env);
    expect(res.status).toBe(429);
    expect(res.headers.get("vary")).toBe(prior);
  });
});
