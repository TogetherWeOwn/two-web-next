// route-inventory: GET /login
// route-inventory: GET /community
// route-inventory: GET /members
// route-inventory: GET /members/
// route-inventory: GET /auth/discord
// route-inventory: GET /auth/discord/callback
// route-inventory: POST /logout
// route-inventory: POST /mcp
// route-inventory: OPTIONS /mcp
// route-inventory: POST /api/agent-events
// route-inventory: GET /admin/queue/failed/:id/preview
// route-inventory: ALL /events/:key/rsvp
// route-inventory: GET /admin/events/create
// route-inventory: POST /admin/events
// route-inventory: GET /up
// route-inventory: GET /events.ics
// route-inventory: GET /events/past

// Frozen URLs, APIs, redirects and method ownership: the exhaustive fixture
// matrix over the mixed Kit/Hono Worker.
//
// Part A pins the ownership decision for EVERY shipped manifest entry in BOTH
// flag positions (enabled/disabled), every HTTP method, and the query,
// trailing-slash and __data.json variants. Hono is the default; a path
// renders in Kit only when its exact method/path entry is enabled.
//
// Part B pins that no API, feed, ops endpoint, redirect alias, retired URL or
// write sibling is swallowed by a Kit dynamic page ([key]/[signal]/[user] or
// the [...path] catch-all), even under a hostile manifest that enables every
// shipped entry.
//
// Part C pins the frozen Hono behavior DB-free: OAuth/vanity redirect
// aliases (the source-required 302s for /login and /community), the retired
// /members 404s, the branded 404 for unrecognized paths, the removed
// diagnostics, the RSVP 405 Allow header, the agent-ingress and queue-operator
// refusal shapes, and the same-origin exemption negatives.
//
// DB-backed bodies (event JSON show, queue preview content, agent admitted
// path, Kit-vs-Hono header parity per migrated page) stay with their owning
// suites: events-key-canonical-siblings, queue-preview-route,
// agent-events-route-refusal, kit-header-parity and the kit-*-dispatch
// family. This file proves routing and refusal shapes, never bodies.
import { describe, expect, it, vi } from "vitest";
import app from "./app";
import type { Env } from "../src/env";
import {
  ROUTE_MANIFEST,
  decideOwner,
  resolveRouteOwner,
  type OwnedRoute,
} from "../src/route-ownership";
import { createMemorySessionStore, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

function fixture(extraEnv: Record<string, string> = {}, dbGuard = true) {
  const store = createMemorySessionStore();
  const dbRead = vi.fn();
  const refuseDb = () => {
    dbRead();
    throw new Error("frozen-url matrix must not read a database binding");
  };
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
    ...extraEnv,
  } as unknown as Env & { SESSION_STORE: SessionStore };
  // The throwing getters prove a path is binding-free. defineProperty (never
  // spread: spread would invoke the getter at fixture-build time). Handlers
  // that degrade on an absent binding need dbGuard=false: absent undefined,
  // never a throw.
  if (dbGuard) {
    Object.defineProperties(env, {
      DB: { get: refuseDb, configurable: true },
      DATABASE_URL: { get: refuseDb, configurable: true },
    });
  }
  return { env, dbRead };
}

const request = (path: string, env: Env, init: RequestInit = {}) => app.request(path, init, env);

const METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

// A concrete example path for every manifest pattern: exact paths stay as-is,
// :param patterns get a representative segment.
function examplePath(pattern: string): string {
  return pattern
    .replace(":key", "spring-fete")
    .replace(":user", "some-member")
    .replace(":id", "7")
    .replace(":signal", "joins");
}

describe("frozen URL method ownership matrix", () => {
  it("covers every shipped manifest entry with a concrete example path", () => {
    expect(ROUTE_MANIFEST.length).toBeGreaterThan(0);
    for (const entry of ROUTE_MANIFEST) {
      expect(entry.method).toBe("GET");
      expect(examplePath(entry.path)).not.toContain(":");
    }
  });

  it.each(ROUTE_MANIFEST.map((entry) => [entry.path] as const))(
    "both flag positions own %s: enabled GET/HEAD go to Kit, everything else to Hono",
    (pattern) => {
      const path = examplePath(pattern);
      const enabled: OwnedRoute[] = [{ method: "GET", path: pattern, enabled: true }];
      const disabled: OwnedRoute[] = [{ method: "GET", path: pattern, enabled: false }];
      for (const method of METHODS) {
        const kitOwned = method === "GET" || method === "HEAD";
        expect(
          resolveRouteOwner({ method, path }, enabled),
          `${method} ${path} with the entry enabled`,
        ).toBe(kitOwned ? "kit" : "hono");
        expect(
          resolveRouteOwner({ method, path }, disabled),
          `${method} ${path} with the entry disabled`,
        ).toBe("hono");
      }
    },
  );

  it.each(ROUTE_MANIFEST.map((entry) => [entry.path] as const))(
    "query, trailing slash and data suffix follow the page for %s",
    (pattern) => {
      // The pure decision takes a bare path; the query half of this pin goes
      // through decideOwner with a real Request, exactly as the hook calls it,
      // so a path+search mutant cannot hide here.
      const path = examplePath(pattern);
      const enabled: OwnedRoute[] = [{ method: "GET", path: pattern, enabled: true }];
      const get = (url: string) => new Request(`http://localhost${url}`, { method: "GET" });
      expect(decideOwner(get(`${path}?page=2`), enabled)).toBe("kit");
      expect(resolveRouteOwner({ method: "GET", path: `${path}/` }, enabled)).toBe("kit");
      expect(resolveRouteOwner({ method: "GET", path: `${path}/__data.json` }, enabled)).toBe(
        "kit",
      );
      const disabled: OwnedRoute[] = [{ method: "GET", path: pattern, enabled: false }];
      expect(decideOwner(get(`${path}?page=2`), disabled)).toBe("hono");
      expect(resolveRouteOwner({ method: "GET", path: `${path}/__data.json` }, disabled)).toBe(
        "hono",
      );
    },
  );

  it("ships the enabled leaves on Kit with later routes on Hono", () => {
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/hotzones/joins" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/about" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/faq" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/leaderboards/members" })).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/events" })).toBe("kit");
    expect(resolveRouteOwner({ method: "POST", path: "/events" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events.json" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/e/spring-fete" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/privacy" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/rules" })).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/profile" })).toBe("hono");
  });

  it("keeps /events/past distinct from an /events/:key pattern in both positions", () => {
    const withKey = [
      { method: "GET", path: "/events/:key", enabled: true },
      { method: "GET", path: "/events/past", enabled: false },
    ];
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" }, withKey)).toBe("hono");
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, withKey)).toBe("kit");
    const flipped = withKey.map((entry) =>
      entry.path === "/events/past" ? { ...entry, enabled: true } : entry,
    );
    expect(resolveRouteOwner({ method: "GET", path: "/events/past" }, flipped)).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/events/spring-fete" }, flipped)).toBe("kit");
  });
});

describe("no API, feed, ops, alias or retired path is Kit-swallowed", () => {
  // Every shipped entry forced on: the all-flags-on position. The manifest
  // carries GET page entries only, so POST/PUT/PATCH/DELETE/OPTIONS on a
  // migrated page stay Hono-owned by construction, and the reserved machine
  // prefix/exact guard (test/route-ownership.test.ts) holds regardless.
  const hostile: OwnedRoute[] = ROUTE_MANIFEST.map((entry) => ({ ...entry, enabled: true }));

  const alwaysHono: Array<{ method: string; path: string }> = [
    { method: "POST", path: "/api/agent-events" },
    { method: "GET", path: "/api/public/community" },
    { method: "GET", path: "/api/public/events" },
    { method: "GET", path: "/api/public/events/spring-fete" },
    { method: "GET", path: "/api/public/join" },
    { method: "GET", path: "/up" },
    { method: "POST", path: "/csp-reports" },
    { method: "POST", path: "/mcp" },
    { method: "OPTIONS", path: "/mcp" },
    { method: "GET", path: "/events.ics" },
    { method: "GET", path: "/events.rss" },
    { method: "GET", path: "/events.json" },
    { method: "GET", path: "/events/spring-fete" },
    { method: "GET", path: "/events/spring-fete.ics" },
    { method: "POST", path: "/events" },
    { method: "PATCH", path: "/events/spring-fete" },
    { method: "GET", path: "/openapi.json" },
    { method: "GET", path: "/.well-known/security.txt" },
    { method: "GET", path: "/llms.txt" },
    { method: "GET", path: "/sitemap_index.xml" },
    { method: "GET", path: "/robots.txt" },
    { method: "POST", path: "/__probe/alert" },
    { method: "GET", path: "/login" },
    { method: "GET", path: "/community" },
    { method: "GET", path: "/members" },
    { method: "GET", path: "/members/" },
    { method: "GET", path: "/auth/discord" },
    { method: "GET", path: "/auth/discord/redirect" },
    { method: "GET", path: "/auth/discord/callback" },
    { method: "GET", path: "/join/discord" },
    { method: "GET", path: "/join/callback" },
    { method: "POST", path: "/logout" },
    { method: "POST", path: "/auth/qa/fixture" },
    { method: "GET", path: "/admin/queue/failed/7/preview" },
    { method: "POST", path: "/admin/queue/failed/7/redispatch" },
    { method: "GET", path: "/admin/queue/source-evidence/7" },
    { method: "POST", path: "/admin/events" },
    { method: "POST", path: "/admin/events/spring-fete" },
    { method: "POST", path: "/admin/featured" },
    { method: "POST", path: "/events/spring-fete/publish" },
    { method: "POST", path: "/members/some-member" },
    { method: "PATCH", path: "/members/some-member" },
    { method: "PUT", path: "/events/spring-fete/rsvp" },
    { method: "DELETE", path: "/events/spring-fete/rsvp" },
    { method: "POST", path: "/events/spring-fete/rsvp" },
    { method: "GET", path: "/_app/immutable/entry/start.js" },
    { method: "GET", path: "/this-url-never-existed-abc123xyz/" },
    { method: "GET", path: "/health" },
    { method: "GET", path: "/wp-login.php" },
  ];

  it.each(alwaysHono.map(({ method, path }) => [method, path] as const))(
    "%s %s stays Hono under the shipped manifest and under a hostile all-enabled manifest",
    (method, path) => {
      expect(resolveRouteOwner({ method, path }), "shipped").toBe("hono");
      expect(resolveRouteOwner({ method, path }, hostile), "hostile").toBe("hono");
    },
  );

  it("documents the :param capture caveat for a future /e/:key enablement", () => {
    // The manifest's /e/:key pattern matches same-segment-count siblings, so
    // enabling it would also capture the per-event Markdown alternate
    // (/e/:file{.+.md} on Hono). The enablement review must preserve that
    // alternate (test/ai-friendly-md.test.ts); ownership alone cannot.
    const enabledDetail: OwnedRoute[] = [{ method: "GET", path: "/e/:key", enabled: true }];
    expect(resolveRouteOwner({ method: "GET", path: "/e/spring-fete" }, enabledDetail)).toBe("kit");
    expect(resolveRouteOwner({ method: "GET", path: "/e/spring-fete.md" }, enabledDetail)).toBe(
      "kit",
    );
  });
});

describe("frozen Hono behavior without a database", () => {
  it.each(["GET", "HEAD"])(
    "%s /login 302s to the OAuth start without cookies or DB",
    async (method) => {
      const { env, dbRead } = fixture();
      const res = await request("/login", env, { method });
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("set-cookie")).toBeNull();
      if (method === "HEAD") expect(await res.text()).toBe("");
      expect(dbRead).not.toHaveBeenCalled();
    },
  );

  it("keeps only a safe next on /login and drops everything else", async () => {
    const { env, dbRead } = fixture();
    const safe = await request("/login?next=%2Fevents", env);
    expect(safe.status).toBe(302);
    expect(safe.headers.get("location")).toBe("/auth/discord?next=%2Fevents");
    const hostile = await request("/login?next=%2F%2Fevil&token=discard", env);
    expect(hostile.status).toBe(302);
    expect(hostile.headers.get("location")).toBe("/auth/discord");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("%s /community 302s to the lobby and drops queries", async (method) => {
    const { env, dbRead } = fixture();
    const res = await request("/community?utm_source=old-site", env, { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    if (method === "HEAD") expect(await res.text()).toBe("");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("302s the legacy OAuth alias to the OAuth start without cookies or DB", async () => {
    const { env, dbRead } = fixture();
    const res = await request("/auth/discord/redirect", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("starts OAuth at /auth/discord with a Discord authorize redirect", async () => {
    // Fresh OAuth state lives in the session store, so no binding-free pin:
    // status, Discord host, scopes and callback are the contract.
    const { env } = fixture();
    const res = await request("/auth/discord", env);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toMatch(/^https:\/\/discord\.com\/oauth2\/authorize/);
    expect(location).toContain("scope=identify+guilds.join");
    expect(location).toContain(encodeURIComponent(`${APP_URL}/auth/discord/callback`));
  });

  it("bounces a bare OAuth callback to the sign-in failure lobby", async () => {
    // The login throttle touches the session store and degrades, so no
    // binding-free pin here: status and Location are the contract.
    const { env } = fixture();
    const res = await request("/auth/discord/callback", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?n=signin_failed");
  });

  it.each(["/members", "/members/"])("keeps retired %s a 404 for guests", async (path) => {
    // The branded-404 suggestion lookup touches the store and degrades
    // without it; the frozen contract is the 404 with no session cookie.
    const { env } = fixture();
    const res = await request(path, env);
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("answers an unrecognized path with the branded 404 and private no-store", async () => {
    const { env } = fixture();
    const res = await request("/this-url-never-existed-abc123xyz/", env);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("We cannot find that page");
  });

  it.each(["/health", "/healthz", "/db-ping"])(
    "matches removed diagnostic %s to the unknown-path 404",
    async (path) => {
      const { env } = fixture();
      const res = await request(path, env);
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(await res.text()).toContain("We cannot find that page");
    },
  );

  it("holds the legacy create alias behind the moderator guard for guests", async () => {
    // Guests bounce to OAuth before the alias redirect; the 301 to
    // /admin/events/new with a moderator session is owned by
    // test/legacy-redirects.test.ts.
    const { env, dbRead } = fixture();
    const res = await request("/admin/events/create", env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("holds the moderator JSON create behind the guard for guests", async () => {
    // Same-origin headers pass the transport guard so the moderator guard
    // below is what answers: every guest gets the JSON 401, machine or
    // browser alike. (The browser-guest OAuth 302 divergence lives on JSON
    // reads via jsonSession, not on writes.) The guard reads the binding
    // config and refuses, so no binding-free pin here — never a write.
    const { env } = fixture();
    for (const accept of ["application/json", "text/html"]) {
      const res = await request("/events", env, {
        method: "POST",
        headers: { "content-type": "application/json", origin: APP_URL, accept },
        body: JSON.stringify({ title: "Seed swap" }),
      });
      expect(res.status, `accept ${accept}`).toBe(401);
      expect(await res.json(), `accept ${accept}`).toEqual({
        error: "unauthenticated",
        request_id: expect.any(String),
      });
    }
  });

  it("answers a wrong-method RSVP write with 405 and the Allow header", async () => {
    // Same-origin headers pass the transport guard so the method fallback
    // below is what answers: 405 with Allow, without a DB read.
    const { env, dbRead } = fixture();
    const res = await request("/events/spring-fete/rsvp", env, {
      method: "POST",
      headers: { origin: APP_URL },
    });
    expect(res.status).toBe(405);
    expect(res.headers.get("Allow")).toBe("PUT, DELETE");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("refuses the disabled agent ingress with 404 before any store read", async () => {
    const { env, dbRead } = fixture();
    const res = await request("/api/agent-events", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "ping" }),
    });
    expect(res.status).toBe(404);
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("fails the enabled agent ingress closed with 503 when no store is configured", async () => {
    // Absent (not throwing) bindings: the ingress degrades to 503 only when
    // the URL lookup itself degrades instead of throwing.
    const { env, dbRead } = fixture(
      {
        AGENT_EVENTS_ENABLED: "true",
        AGENT_EVENTS_CALLER_AGENT_ID: "agent-under-test",
      },
      false,
    );
    const res = await request("/api/agent-events", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ op: "ping" }),
    });
    expect(res.status).toBe(503);
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("refuses the disabled queue preview with 404 before any operator read", async () => {
    const { env, dbRead } = fixture();
    const res = await request("/admin/queue/failed/7/preview", env);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "preview_disabled" });
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("refuses a cross-origin cookie-authenticated mutation with 403 and no-store", async () => {
    const { env, dbRead } = fixture();
    const res = await request("/logout", env, {
      method: "POST",
      headers: { origin: "https://evil.test" },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "cross_origin", request_id: expect.any(String) });
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("exempts only the documented machine endpoints from the same-origin guard", async () => {
    // POST /mcp is exempt: a cross-origin POST reaches the MCP handler's own
    // Origin policy, never the guard's 403. PUT /mcp is not exempt and fails
    // closed. POST /logout non-exemption is pinned above. GET/OPTIONS never
    // reach the guard.
    const { env } = fixture();
    const exempt = await request("/mcp", env, {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(await exempt.json()).not.toEqual({ error: "cross_origin" });
    const neighbour = await request("/mcp", env, {
      method: "PUT",
      headers: { origin: "https://evil.test" },
    });
    expect(neighbour.status).toBe(403);
    expect(await neighbour.json()).toEqual({
      error: "cross_origin",
      request_id: expect.any(String),
    });
    const preflight = await request("/mcp", env, { method: "OPTIONS" });
    expect(preflight.status).not.toBe(403);
    const getter = await request("/events.ics", env);
    expect(getter.status).not.toBe(403);
  });

  // GET /up behavior (200 healthy, 503 degraded/unavailable) stays with its
  // owning suite test/up-db.test.ts: it needs configured bindings to answer
  // anything but onError 500. Ownership (never Kit, both flag positions) is
  // pinned in the matrix above.
});
