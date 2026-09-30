// A configured-but-unreachable DB is not the same as a missing binding.
// See docs/db-outage-matrix.md for the legacy bot/app-DB distinction.
import { Hono } from "hono";
import { serializeSigned } from "hono/utils/cookie";
import postgres, { type Sql } from "postgres";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Env } from "../src/env";
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
  title: "Outage fixture", timezone: "UTC", starts_at: "2030-01-01T12:00", ends_at: "2030-01-01T13:00",
});
const adminForm = "title=Outage+fixture&timezone=UTC&starts_at=2030-01-01T12%3A00&ends_at=2030-01-01T13%3A00";

const MATRIX: Case[] = [
  ...["/", "/about", "/faq", "/rules", "/privacy", "/join"].map((route) => ({ method: "GET", route, status: 200 })),
  { method: "GET", route: "/discord", status: 302, location: env.DISCORD_INVITE_URL },
  ...["/sitemap_index.xml", "/robots.txt", "/health", "/healthz", "/up"].map((route) => ({ method: "GET", route, status: 200 })),
  { method: "GET", route: "/db-ping", status: 503, format: "json" },
  { method: "GET", route: "/auth/discord", status: 302, location: "https://discord.com/oauth2/authorize" },
  { method: "GET", route: "/auth/discord/callback", status: 302, location: "/?n=signin_failed" },
  { method: "GET", route: "/join/discord", status: 503, format: "html" },
  { method: "GET", route: "/join/callback", status: 503, format: "html" },
  { method: "POST", route: "/logout", status: 303, location: "/" },
  { method: "POST", route: "/auth/qa/:identity", path: "/auth/qa/member", status: 404, format: "html" },
  { method: "POST", route: "/csp-reports", status: 204, body: "{}", contentType: "application/csp-report" },
  { method: "POST", route: "/api/agent-events", status: 404, format: "json", body: "{}" },
  ...["/events", "/events/past", "/events.rss", "/events.ics", "/e/:key", "/events/:file{.+\\.ics}"].map((route) => ({
    method: "GET", route, status: 503, format: "html" as const,
    path: route === "/events/:file{.+\\.ics}" ? `/events/${EVENT_KEY}.ics` : undefined,
  })),
  { method: "GET", route: "/events.json", status: 503, actor: "member", format: "json" },
  { method: "POST", route: "/events", status: 503, actor: "moderator", format: "json", body: eventForm },
  { method: "PATCH", route: "/events/:key", status: 503, actor: "moderator", format: "json", body: "{}" },
  ...["publish", "cancel"].map((action) => ({
    method: "POST", route: `/events/:key/${action}`, status: 503, actor: "moderator" as const, format: "json" as const, body: "{}",
  })),
  { method: "PUT", route: "/events/:key/rsvp", status: 503, actor: "member", format: "json", body: '{"status":"going"}' },
  { method: "DELETE", route: "/events/:key/rsvp", status: 503, actor: "member", format: "json" },
  { method: "ALL", route: "/events/:key/rsvp", status: 405 },
  ...["/profile", "/members/:user"].map((route) => ({ method: "GET", route, status: 503, actor: "member" as const, format: "html" as const })),
  { method: "PATCH", route: "/members/:user", status: 503, actor: "member", format: "json", body: '{"bio":"Fixture","games":[]}' },
  { method: "POST", route: "/members/:user", status: 503, actor: "member", format: "html", body: "_method=PATCH&bio=Fixture&games_text=", contentType: "application/x-www-form-urlencoded" },
  { method: "GET", route: "/admin", status: 503, actor: "moderator", format: "html" },
  // Empty create forms expose no member subjects and need no data read.
  ...["/admin/events/new", "/admin/featured/new"].map((route) => ({ method: "GET", route, status: 200, actor: "moderator" as const, format: "html" as const })),
  ...["/admin/join-attempts", "/admin/events", "/admin/events/:key", "/admin/featured", "/admin/featured/:id"].map((route) => ({
    method: "GET", route, status: 503, actor: "moderator" as const, format: "html" as const,
  })),
  ...["/admin/events", "/admin/events/:key", "/admin/events/:key/publish", "/admin/events/:key/cancel", "/admin/featured", "/admin/featured/:id", "/admin/featured/:id/delete"].map((route) => ({
    method: "POST", route, status: 503, actor: "moderator" as const, format: "html" as const,
    body: route.includes("featured") ? "title=Fixture&position=0" : adminForm, contentType: "application/x-www-form-urlencoded",
  })),
];

// ALL registrations are not all middleware: the RSVP 405 fallback is a real
// endpoint. Pin known middleware multiplicity instead of filtering wildcards.
const MIDDLEWARE = ["ALL /*", "ALL /admin/*", "ALL /profile", "ALL /profile", "ALL /members/*", "ALL /members/*"];
function assertInventory(router: { routes: { method: string; path: string }[] }): void {
  const endpoints = router.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
  const expected = MATRIX.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.route}`);
  expect(expected.length).toBeGreaterThan(0);
  expect(new Set(expected).size).toBe(expected.length);
  // Hono stores a separate registration for each method-specific middleware.
  expect([...new Set(endpoints)].sort()).toEqual(expected.sort());
  expect(router.routes.filter((r) => r.method === "ALL").map((r) => `${r.method} ${r.path}`).sort())
    .toEqual([...MIDDLEWARE, "ALL /events/:key/rsvp"].sort());
}

beforeEach(() => {
  // HTTP dependencies stay local too. No real Discord/OAuth/alert traffic.
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("External HTTP is disabled in the outage matrix"));
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(async () => {
  await Promise.all(clients.splice(0).map((sql) => sql.end({ timeout: 0 })));
  vi.restoreAllMocks();
});

const outageEnv = (): Env => ({ ...env, DB: { connectionString: OUTAGE_URL }, AGENT_DB: { connectionString: OUTAGE_URL } });
const concretePath = (row: Case) => row.path ?? row.route.replace(":key", EVENT_KEY).replace(":user", MEMBER.userId).replace(":id", "1");

async function request(row: Case, sessionDown = false): Promise<Response> {
  const bindings = outageEnv();
  const headers = new Headers({ origin: env.APP_URL, accept: row.format === "json" ? "application/json" : "text/html" });
  if (row.actor) {
    const store = createMemorySessionStore();
    headers.set("cookie", await cookieFor(store, row.actor === "member" ? MEMBER : MODERATOR));
    // Isolate data-handler failure from the session guard; never inject a DB,
    // profile store or audit sink. A second matrix below removes this seam.
    if (!sessionDown) Object.assign(bindings, { SESSION_STORE: store });
  }
  if (row.body !== undefined) headers.set("content-type", row.contentType ?? "application/json");
  return app.request(concretePath(row), { method: row.method === "ALL" ? "POST" : row.method, headers, body: row.body }, bindings);
}

async function assertResponse(res: Response, row: Case): Promise<void> {
  const body = await res.text();
  expect.soft(res.status).toBe(row.status);
  expect.soft(body).not.toMatch(/SQLSTATE|ECONNREFUSED|postgres:\/\/|outage_fixture|127\.0\.0\.1|\b(?:PostgresError|QueryException)\b|stack trace|node_modules|\bat\s+\S+\s*\([^\n]*:\d+:\d+\)/i);
  for (const secret of [env.SESSION_SECRET, env.DISCORD_CLIENT_SECRET, env.DISCORD_BOT_TOKEN]) {
    expect.soft(body).not.toContain(secret);
  }
  if (row.format) expect.soft(res.headers.get("content-type")).toContain(row.format === "json" ? "application/json" : "text/html");
  if (row.format === "html") {
    expect.soft(body).toContain("Together We Own");
    expect.soft(body).toContain('<a class="brand" href="/">TWO</a>');
  }
  if (row.location) {
    const location = res.headers.get("location");
    if (row.location.startsWith("https://discord.com/")) {
      expect.soft(location?.split("?")[0]).toBe(row.location);
    } else expect.soft(location).toBe(row.location);
  }
  if (row.route === "/discord") expect.soft(res.headers.get("cache-control")).toContain("no-store");
  if (row.route === "/up") {
    expect.soft(JSON.parse(body).queue).toMatchObject({ status: "unknown", pending: null, reserved: null, failed: null });
  }
  if (row.route === "/" && row.status === 200) {
    expect.soft(body).toContain("The lobby is open.");
    expect.soft(body).toContain('data-testid="discord-join"');
    expect.soft(body).not.toMatch(/>\s*0\s*</);
  }
}

it("uses a real refused Postgres socket, not a missing binding or throwing store double", async () => {
  const sql = postgres(OUTAGE_URL);
  await expect(sql`select 1`).rejects.toMatchObject({ code: "ECONNREFUSED", address: "127.0.0.1", port: 1 });
});

it("covers every registered endpoint, including ALL handlers", () => assertInventory(app));
it.each([["GET", "/new-route"], ["POST", "/new-write"], ["HEAD", "/new-head"], ["ALL", "/new-all"], ["ALL", "/*"]])(
  "rejects an unlisted %s %s registration", (method, path) => {
    const copy = new Hono().route("/", app);
    assertInventory(copy);
    copy.on(method, path, (c) => c.text("unlisted"));
    expect(() => assertInventory(copy)).toThrow();
  },
);

describe("configured Postgres outage: route matrix", () => {
  it.each(MATRIX)("$method $route → $status", async (row) => assertResponse(await request(row), row));
});

describe("configured Postgres outage: production session store", () => {
  it.each(MATRIX.filter((row) => row.actor))(
    "$method $route fails closed before member data when sessions are down", async (row) => {
      const expected = { ...row, status: 503 };
      await assertResponse(await request(row, true), expected);
    },
  );
});

it("enabled agent ingress fails closed when its separate binding is down", async () => {
  const pending: Promise<unknown>[] = [];
  const bindings = { ...outageEnv(), AGENT_EVENTS_ENABLED: "true" };
  const res = await app.request("/api/agent-events", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }, bindings, {
    waitUntil: (promise: Promise<unknown>) => { pending.push(promise); }, passThroughOnException: () => {}, props: {},
  });
  await assertResponse(res, { method: "POST", route: "/api/agent-events", status: 503, format: "json" });
  await Promise.allSettled(pending);
});

it("valid login callback fails closed at session persistence, not OAuth validation", async () => {
  const state = "local-outage-oauth-state";
  const cookie = (await serializeSigned("__Host-two_oauth_state", state, env.SESSION_SECRET, { path: "/", secure: true })).split(";")[0]!;
  vi.mocked(fetch).mockResolvedValueOnce(Response.json({ access_token: "local-fixture-token" }))
    .mockResolvedValueOnce(Response.json({ id: MEMBER.userId, username: MEMBER.username, avatar: null }))
    .mockResolvedValueOnce(new Response(null, { status: 201 }));
  const res = await app.request(`/auth/discord/callback?code=local-code&state=${state}`, { headers: { cookie } }, outageEnv());
  expect(fetch).toHaveBeenCalledTimes(3);
  await assertResponse(res, { method: "GET", route: "/auth/discord/callback", status: 503, format: "html" });
});
