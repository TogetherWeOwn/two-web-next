// A configured-but-unreachable DB is not the same as a missing binding.
// See docs/db-outage-matrix.md for the legacy bot/app-DB distinction.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import postgres, { type Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import testApp from "./app";
import type { Env } from "../src/env";
import { STAGING_APP_URL } from "../src/qa";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, EVENT_KEY, MEMBER, MODERATOR } from "./helpers/member-data";

const clients = vi.hoisted(() => [] as Sql[]);
const OUTAGE_URL = "postgres://outage_fixture@127.0.0.1:1/outage_fixture";

// Keep the real postgres driver/socket failure. Track its per-request clients
// so migration/read failures cannot leave reconnect timers behind after a test.
vi.mock("postgres", async (importOriginal) => {
  const original = await importOriginal<{ default: typeof import("postgres") }>();
  return {
    default: (url: string, options?: object) => {
      if (url !== "postgres://outage_fixture@127.0.0.1:1/outage_fixture") {
        throw new Error("The outage matrix may connect only to its refused loopback fixture");
      }
      const sql = original.default(url, { ...options, connect_timeout: 1 });
      clients.push(sql);
      return sql;
    },
  };
});

type Case = {
  method: string;
  route: string;
  path?: string;
  status: number;
  actor?: "member" | "moderator";
  format?: "json" | "html";
  body?: string;
  contentType?: string;
  location?: string;
};
const eventForm = JSON.stringify({
  title: "Outage fixture",
  timezone: "UTC",
  starts_at: "2030-01-01T12:00",
  ends_at: "2030-01-01T13:00",
});
const adminForm =
  "title=Outage+fixture&timezone=UTC&starts_at=2030-01-01T12%3A00&ends_at=2030-01-01T13%3A00";

const MATRIX: Case[] = [
  ...["/", "/about", "/faq", "/rules", "/privacy", "/join"].map((route) => ({
    method: "GET",
    route,
    status: 200,
  })),
  { method: "GET", route: "/discord", status: 302, location: env.DISCORD_INVITE_URL },
  ...["/sitemap_index.xml", "/robots.txt"].map((route) => ({ method: "GET", route, status: 200 })),
  // Main #111: a failed DB ping is a readiness failure, so /up answers 503
  // with the sanitized readiness body instead of a false healthy 200.
  { method: "GET", route: "/up", status: 503, format: "json" },
  // One-use admission: the ordinary login start persists its journey, so with
  // the app DB down it fails closed to the sign-in failure notice instead of
  // sending the member through an OAuth round trip that could never be admitted.
  { method: "GET", route: "/auth/discord", status: 302, location: "/?n=signin_failed" },
  { method: "GET", route: "/auth/discord/redirect", status: 302, location: "/auth/discord" },
  { method: "GET", route: "/auth/discord/callback", status: 302, location: "/?n=signin_failed" },
  // Stale-tab liveness probe and expired-write recovery (main #239): neither
  // reads the DB without a session cookie, so both stay 200 during an outage.
  { method: "GET", route: "/auth/status", status: 200, format: "json" },
  { method: "GET", route: "/auth/recover", status: 200, format: "html" },
  // Bare /members is the retired frozen 404: answered before the member gate,
  // so no session/DB read and the same branded page with or without a binding.
  { method: "GET", route: "/members", status: 404, format: "html" },
  { method: "GET", route: "/members/", status: 404, format: "html" },
  { method: "GET", route: "/join/discord", status: 503, format: "html" },
  { method: "GET", route: "/join/callback", status: 503, format: "html" },
  { method: "POST", route: "/logout", status: 303, location: "/" },
  {
    method: "POST",
    route: "/auth/qa/:identity",
    path: "/auth/qa/member",
    status: 404,
    format: "html",
  },
  {
    method: "POST",
    route: "/csp-reports",
    status: 204,
    body: "{}",
    contentType: "application/csp-report",
  },
  { method: "POST", route: "/api/agent-events", status: 404, format: "json", body: "{}" },
  ...[
    "/events",
    "/events/past",
    "/events.rss",
    "/events.ics",
    "/e/:key",
    "/events/:file{.+\\.ics}",
  ].map((route) => ({
    method: "GET",
    route,
    status: 503,
    format: "html" as const,
    path: route === "/events/:file{.+\\.ics}" ? `/events/${EVENT_KEY}.ics` : undefined,
  })),
  { method: "GET", route: "/events.json", status: 503, actor: "member", format: "json" },
  // Main #109/#98: JSON event show. Anonymous browsers redirect to the join
  // funnel before any DB read. The member-session outage envelope is pinned
  // below, outside the inventory, so the route string stays unique.
  {
    method: "GET",
    route: "/events/:key",
    status: 302,
    location: `/join/discord?next=%2Fevents%2F${EVENT_KEY}`,
  },
  // Main #120: the alert probe gate (QA disabled here) 404s before any
  // throttle/queue/DB read, so it is outage-independent and branded.
  { method: "POST", route: "/__probe/alert", status: 404, format: "html", body: "{}" },
  {
    method: "POST",
    route: "/events",
    status: 503,
    actor: "moderator",
    format: "json",
    body: eventForm,
  },
  {
    method: "PATCH",
    route: "/events/:key",
    status: 503,
    actor: "moderator",
    format: "json",
    body: "{}",
  },
  ...["publish", "cancel", "rsvp-pause", "rsvp-reopen"].map((action) => ({
    method: "POST",
    route: `/events/:key/${action}`,
    status: 503,
    actor: "moderator" as const,
    format: "json" as const,
    body: "{}",
  })),
  {
    method: "PUT",
    route: "/events/:key/rsvp",
    status: 503,
    actor: "member",
    format: "json",
    body: '{"status":"going"}',
  },
  { method: "DELETE", route: "/events/:key/rsvp", status: 503, actor: "member", format: "json" },
  // Main #98: the HTML form adapter reuses the JSON RSVP paths, so a member
  // write during an outage renders the branded 503 instead of redirecting.
  {
    method: "POST",
    route: "/e/:key/rsvp",
    status: 503,
    actor: "member",
    format: "html",
    body: '{"status":"going"}',
  },
  { method: "ALL", route: "/events/:key/rsvp", status: 405 },
  ...["/profile", "/members/:user"].map((route) => ({
    method: "GET",
    route,
    status: 503,
    actor: "member" as const,
    format: "html" as const,
  })),
  {
    method: "PATCH",
    route: "/members/:user",
    status: 503,
    actor: "member",
    format: "json",
    body: '{"bio":"Fixture","games":[]}',
  },
  {
    method: "POST",
    route: "/members/:user",
    status: 503,
    actor: "member",
    format: "html",
    body: "_method=PATCH&bio=Fixture&games_text=",
    contentType: "application/x-www-form-urlencoded",
  },
  { method: "GET", route: "/admin", status: 503, actor: "moderator", format: "html" },
  // Operational admission is disabled before any session/source/audit lookup.
  { method: "GET", route: "/admin/queue/failed/:id/preview", status: 404, format: "json" },
  // Static aliases need a valid moderator session, but no resource lookup.
  {
    method: "GET",
    route: "/admin/events/create",
    status: 301,
    actor: "moderator",
    location: "/admin/events/new",
  },
  {
    method: "GET",
    route: "/admin/events/:key/edit",
    status: 301,
    actor: "moderator",
    location: `/admin/events/${EVENT_KEY}`,
  },
  {
    method: "GET",
    route: "/admin/featured-contents",
    status: 301,
    actor: "moderator",
    location: "/admin/featured",
  },
  {
    method: "GET",
    route: "/admin/featured-contents/create",
    status: 301,
    actor: "moderator",
    location: "/admin/featured/new",
  },
  // Imported featured IDs must be resolved in Postgres; never guess a target.
  {
    method: "GET",
    route: "/admin/featured-contents/:id/edit",
    status: 503,
    actor: "moderator",
    format: "html",
  },
  // Empty create forms expose no member subjects and need no data read.
  ...["/admin/events/new", "/admin/featured/new"].map((route) => ({
    method: "GET",
    route,
    status: 200,
    actor: "moderator" as const,
    format: "html" as const,
  })),
  ...[
    "/admin/activity-log",
    "/admin/join-attempts",
    "/admin/join-attempts/:id",
    "/admin/events",
    "/admin/events/:key",
    "/admin/featured",
    "/admin/featured/:id",
  ].map((route) => ({
    method: "GET",
    route,
    status: 503,
    actor: "moderator" as const,
    format: "html" as const,
  })),
  ...[
    "/admin/events",
    "/admin/events/:key",
    "/admin/events/:key/publish",
    "/admin/events/:key/cancel",
    "/admin/events/:key/rsvp-pause",
    "/admin/events/:key/rsvp-reopen",
    "/admin/featured",
    "/admin/featured/:id",
    "/admin/featured/:id/delete",
  ].map((route) => ({
    method: "POST",
    route,
    status: 503,
    actor: "moderator" as const,
    format: "html" as const,
    body: route.includes("featured") ? "title=Fixture&position=0" : adminForm,
    contentType: "application/x-www-form-urlencoded",
  })),
];

// ALL registrations are not all middleware: the RSVP 405 fallback is a real
// endpoint. Pin known middleware multiplicity instead of filtering wildcards.
// Global `*` carries six: the pre-throttle guard, trust-hosts, same-origin,
// the stale-tab auth-status script, the expired-write banner (main #239
// added those two) and the flag-gated freeze banner. Profile paths carry
// three registrations each: the session gate, the join-result consumer, and
// the mandatory access log.
// Profiles: session gate + keyed read boundary per path (main #145).
const MIDDLEWARE = [
  "ALL /*",
  "ALL /*",
  "ALL /*",
  "ALL /*",
  "ALL /*",
  "ALL /*",
  "ALL /admin/*",
  "ALL /admin/queue/*",
  "ALL /profile",
  "ALL /profile",
  "ALL /members/*",
  "ALL /members/*",
];
function assertInventory(router: { routes: { method: string; path: string }[] }): void {
  const endpoints = router.routes
    .filter((r) => r.method !== "ALL")
    .map((r) => `${r.method} ${r.path}`);
  const expected = MATRIX.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.route}`);
  expect(expected.length).toBeGreaterThan(0);
  expect(new Set(expected).size).toBe(expected.length);
  // Hono stores a separate registration for each method-specific middleware.
  expect([...new Set(endpoints)].sort()).toEqual(expected.sort());
  expect(
    router.routes
      .filter((r) => r.method === "ALL")
      .map((r) => `${r.method} ${r.path}`)
      .sort(),
  ).toEqual([...MIDDLEWARE, "ALL /events/:key/rsvp"].sort());
}

it("an enabled dedicated operator preview refuses a real source socket outage", async () => {
  const store = createMemorySessionStore();
  const bindings = {
    ...outageEnv(),
    APP_URL: STAGING_APP_URL,
    QUEUE_RECONCILE_PREVIEW_ENABLED: "true",
    QUEUE_RECONCILE_OPERATOR_ID: MODERATOR.userId,
    SESSION_STORE: store,
  };
  const res = await testApp.request(
    "/admin/queue/failed/7/preview",
    {
      headers: { origin: STAGING_APP_URL, cookie: await cookieFor(store, MODERATOR) },
    },
    bindings,
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({ error: "preview_unavailable" });
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(clients).toHaveLength(1);
});

beforeEach(() => {
  // HTTP dependencies stay local too. No real Discord/OAuth/alert traffic.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(
    new Error("External HTTP is disabled in the outage matrix"),
  );
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((sql) => sql.end({ timeout: 0 })));
  vi.restoreAllMocks();
});

const outageEnv = (): Env => ({
  ...env,
  DB: { connectionString: OUTAGE_URL },
  AGENT_DB: { connectionString: OUTAGE_URL },
});
const concretePath = (row: Case) =>
  row.path ??
  row.route.replace(":key", EVENT_KEY).replace(":user", MEMBER.userId).replace(":id", "1");

async function request(row: Case, sessionDown = false): Promise<Response> {
  const bindings = outageEnv();
  const headers = new Headers({
    origin: env.APP_URL,
    accept: row.format === "json" ? "application/json" : "text/html",
  });
  if (row.actor) {
    const store = createMemorySessionStore();
    headers.set("cookie", await cookieFor(store, row.actor === "member" ? MEMBER : MODERATOR));
    // Isolate data-handler failure from the session guard; never inject a DB,
    // profile store or audit sink. A second matrix below removes this seam.
    if (!sessionDown) Object.assign(bindings, { SESSION_STORE: store });
  }
  if (row.body !== undefined) headers.set("content-type", row.contentType ?? "application/json");
  return testApp.request(
    concretePath(row),
    { method: row.method === "ALL" ? "POST" : row.method, headers, body: row.body },
    bindings,
  );
}

async function assertResponse(res: Response, row: Case): Promise<void> {
  const body = await res.text();
  expect.soft(res.status).toBe(row.status);
  expect
    .soft(body)
    .not.toMatch(
      /SQLSTATE|ECONNREFUSED|postgres:\/\/|outage_fixture|127\.0\.0\.1|\b(?:PostgresError|QueryException)\b|stack trace|node_modules|\bat\s+\S+\s*\([^\n]*:\d+:\d+\)/i,
    );
  for (const secret of [env.SESSION_SECRET, env.DISCORD_CLIENT_SECRET, env.DISCORD_BOT_TOKEN]) {
    expect.soft(body).not.toContain(secret);
  }
  if (row.status >= 400) expect.soft(res.headers.get("location")).toBeNull();
  if (row.format)
    expect
      .soft(res.headers.get("content-type"))
      .toContain(row.format === "json" ? "application/json" : "text/html");
  if (row.format === "html" && row.status >= 400) {
    expect.soft(body).toContain("Together We Own");
    // The home-theme header renders the brand as a logo image, not bare
    // text; pin the branded anchor, not its contents.
    expect.soft(body).toContain('<a class="brand" href="/"');
  }
  if (row.location) {
    const location = res.headers.get("location");
    if (row.location.startsWith("https://discord.com/")) {
      expect.soft(location?.split("?")[0]).toBe(row.location);
    } else expect.soft(location).toBe(row.location);
  }
  if (row.route === "/discord") expect.soft(res.headers.get("cache-control")).toContain("no-store");
  if (row.route === "/up") {
    expect.soft(JSON.parse(body)).toMatchObject({ db: "error", pending_migrations: null });
    expect
      .soft(JSON.parse(body).queue)
      .toMatchObject({ status: "unknown", pending: null, reserved: null, failed: null });
  }
  if (row.route === "/" && row.status === 200) {
    expect.soft(body).toContain("The lobby is open.");
    expect.soft(body).toContain('data-testid="discord-join"');
    expect.soft(body).not.toMatch(/>\s*0\s*</);
  }
}

it("uses a real refused Postgres socket, not a missing binding or throwing store double", async () => {
  const sql = postgres(OUTAGE_URL);
  await expect(sql`select 1`).rejects.toMatchObject({
    code: "ECONNREFUSED",
    address: "127.0.0.1",
    port: 1,
  });
});

it("covers every registered endpoint, including ALL handlers", () => assertInventory(app));
it.each([
  ["GET", "/new-route"],
  ["POST", "/new-write"],
  ["HEAD", "/new-head"],
  ["ALL", "/new-all"],
  ["ALL", "/*"],
])("rejects an unlisted %s %s registration", (method, path) => {
  const copy = new Hono().route("/", app);
  assertInventory(copy);
  copy.on(method, path, (c) => c.text("unlisted"));
  expect(() => assertInventory(copy)).toThrow();
});

describe("configured Postgres outage: route matrix", () => {
  it.each(MATRIX)("$method $route → $status", async (row) =>
    assertResponse(await request(row), row),
  );
});

describe("configured Postgres outage: production session store", () => {
  it.each(MATRIX.filter((row) => row.actor))(
    "$method $route fails closed before member data when sessions are down",
    async (row) => {
      const expected = {
        ...row,
        status: 503,
        location: undefined,
        format: row.format ?? ("html" as const),
      };
      await assertResponse(await request(row, true), expected);
    },
  );
});

it.each([
  undefined,
  "*/*",
  "text/html",
  "application/json",
  "text/html, application/json;q=0",
  "text/html;q=1, application/json;q=0.1",
])(
  "enabled agent ingress keeps its reason envelope when its binding is down, Accept %s",
  async (accept) => {
    const pending: Promise<unknown>[] = [];
    const bindings = { ...outageEnv(), AGENT_EVENTS_ENABLED: "true" };
    const res = await testApp.request(
      "/api/agent-events",
      {
        method: "POST",
        headers: { "content-type": "application/json", ...(accept ? { accept } : {}) },
        body: "{}",
      },
      bindings,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pending.push(promise);
        },
        passThroughOnException: () => {},
        props: {},
      },
    );
    try {
      await assertResponse(res.clone(), {
        method: "POST",
        route: "/api/agent-events",
        status: 503,
        format: "json",
      });
      expect(res.headers.get("cache-control")).toContain("private");
      expect(res.headers.get("cache-control")).toContain("no-store");
      expect(res.headers.getSetCookie()).toEqual([]);
      expect(await res.json()).toEqual({
        reason: "ingress_unavailable",
        message: "The agent event store is temporarily unavailable. Try again shortly.",
      });
    } finally {
      await Promise.allSettled(pending);
    }
  },
);

it("enabled agent ingress retains its reason envelope without a configured binding", async () => {
  const res = await testApp.request(
    "/api/agent-events",
    { method: "POST", body: "{}" },
    {
      ...env,
      AGENT_EVENTS_ENABLED: "true",
    },
  );
  expect(res.status).toBe(503);
  expect(await res.json()).toEqual({
    reason: "ingress_unavailable",
    message: "The agent event store is not configured.",
  });
  expect(clients).toHaveLength(0);
});

// Main #109: a member session on the JSON event show reaches the outage
// envelope, not login and not a 500. Also holds when the session store itself
// is down: the JSON refusal precedes session resolution.
it("member event show fails closed to the outage envelope during an outage", async () => {
  for (const sessionDown of [false, true]) {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MEMBER);
    const bindings = outageEnv();
    if (!sessionDown) Object.assign(bindings, { SESSION_STORE: store });
    const res = await testApp.request(
      `/events/${EVENT_KEY}`,
      {
        method: "GET",
        headers: { origin: env.APP_URL, accept: "application/json", cookie },
      },
      bindings,
    );
    await assertResponse(res.clone(), {
      method: "GET",
      route: "/events/:key",
      status: 503,
      format: "json",
    });
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(await res.json()).toEqual({
      error: "db_unavailable",
      message: "The service is temporarily unavailable. Try again shortly.",
    });
  }
});

it("valid login callback fails closed at admission, before any Discord call", async () => {
  const state = "local-outage-oauth-state";
  const cookie = (
    await serializeSigned("__Host-two_oauth_state", state, env.SESSION_SECRET, {
      path: "/",
      secure: true,
    })
  ).split(";")[0]!;
  const res = await testApp.request(
    `/auth/discord/callback?code=local-code&state=${state}`,
    { headers: { cookie } },
    outageEnv(),
  );
  // The journey cannot be consumed with the app DB down, so the code is never
  // exchanged and no session is minted: zero upstream calls.
  expect(fetch).not.toHaveBeenCalled();
  await assertResponse(res, {
    method: "GET",
    route: "/auth/discord/callback",
    status: 302,
    location: "/?n=signin_failed",
  });
});
