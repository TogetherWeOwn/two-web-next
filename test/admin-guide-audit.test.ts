// Admin-guide audit (TOG-12108): pin docs/moderator-admin-guide.md §"Screens
// and route reference" against the mounted app inventory. The guide claims 19
// canonical routes (10 GET, 9 POST) in src/admin/routes.tsx plus 5 legacy GET
// bookmarks as 301 redirects, all 24 behind the moderator guard, pause/reopen
// toggles present, and 404s for unknown/missing resources with legacy-ID
// resolution from the imported ID (never a same-number native fallback).
//
// Keep this suite DB-free: sessions resolve from the memory store, canonical
// reads that need a database answer 503 ("Admin temporarily unavailable") —
// which still proves the route exists and the guard passed — while unknown
// paths, invalid IDs and unmapped legacy IDs 404 without any database read.
// Live round-trips stay in test/admin.test.ts and test/legacy-redirects.test.ts.

import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it, vi } from "vitest";
import app from "../src/index";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  createMemorySessionStore,
  hashToken,
  newSessionToken,
  type SessionStore,
} from "../src/sessions";
import { routeInventory } from "./helpers/route-inventory";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

// Guide §"Screens and route reference": the 19 canonical routes.
const CANONICAL_GET = [
  "/admin",
  "/admin/events",
  "/admin/events/new",
  "/admin/events/:key",
  "/admin/featured",
  "/admin/featured/new",
  "/admin/featured/:id",
  "/admin/join-attempts",
  "/admin/join-attempts/:id",
  "/admin/activity-log",
];
const CANONICAL_POST = [
  "/admin/events",
  "/admin/events/:key",
  "/admin/events/:key/publish",
  "/admin/events/:key/cancel",
  "/admin/events/:key/rsvp-pause",
  "/admin/events/:key/rsvp-reopen",
  "/admin/featured",
  "/admin/featured/:id",
  "/admin/featured/:id/delete",
];
// Guide: five additional GET routes retain legacy bookmarks as 301 redirects.
const LEGACY_GET: Record<string, string> = {
  "/admin/events/create": "/admin/events/new",
  "/admin/events/:key/edit": "/admin/events/:key",
  "/admin/featured-contents": "/admin/featured",
  "/admin/featured-contents/create": "/admin/featured/new",
  "/admin/featured-contents/:id/edit": "/admin/featured/:id",
};

// No DATABASE_URL/DB/ADMIN_DB keys at all: anything that needs a database
// must fail closed, never hang or decide open.
function envFor(store: SessionStore, db?: Db) {
  return {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
    ...(db ? { ADMIN_DB: db } : {}),
  } satisfies Env & { SESSION_STORE: SessionStore; ADMIN_DB?: Db };
}

async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "guide-audit-moderator",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (
    await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
      path: "/",
      secure: true,
      httpOnly: true,
      sameSite: "Lax",
    })
  ).split(";")[0]!;
}

const request = (path: string, env: Env, init: RequestInit = {}) =>
  app.request(`${APP_URL}${path}`, init, env);

/** pg-proxy stub: every query returns empty rows (missing resources, unmapped IDs). */
function emptyDb() {
  const query = vi.fn(async () => ({ rows: [] }));
  return { db: drizzle(query) as unknown as Db, query };
}

describe("admin guide audit: route table matches the mounted inventory", () => {
  const inventory = routeInventory(app);
  const byKey = new Map(inventory.map((route) => [`${route.method} ${route.path}`, route]));

  it("mounts the 19 canonical routes (10 GET, 9 POST), all moderator-guarded", () => {
    expect(CANONICAL_GET).toHaveLength(10);
    expect(CANONICAL_POST).toHaveLength(9);
    for (const path of [
      ...CANONICAL_GET.map((p) => `GET ${p}`),
      ...CANONICAL_POST.map((p) => `POST ${p}`),
    ]) {
      expect(byKey.get(path), path).toMatchObject({ auth: "moderator" });
    }
  });

  it("mounts the 5 legacy bookmarks as moderator-guarded GET routes", () => {
    expect(Object.keys(LEGACY_GET)).toHaveLength(5);
    for (const path of Object.keys(LEGACY_GET)) {
      expect(byKey.get(`GET ${path}`), path).toMatchObject({ auth: "moderator" });
    }
  });

  it("counts exactly 24 guide-claimed admin routes (15 GET, 9 POST)", () => {
    const claimed = [
      ...CANONICAL_GET.map((p) => `GET ${p}`),
      ...Object.keys(LEGACY_GET).map((p) => `GET ${p}`),
      ...CANONICAL_POST.map((p) => `POST ${p}`),
    ];
    expect(claimed).toHaveLength(24);
    expect(claimed.filter((name) => name.startsWith("GET"))).toHaveLength(15);
    for (const name of claimed) expect(byKey.has(name), name).toBe(true);
  });
});

describe("admin guide audit: moderator guard on every claimed route (no DB)", () => {
  it.each([...CANONICAL_GET, ...Object.keys(LEGACY_GET)])(
    "guests at GET %s go to Discord sign-in",
    async (path) => {
      const route = path.includes(":key")
        ? path.replace(":key", "some-key").replace(":id", "1")
        : path;
      const res = await request(route, envFor(createMemorySessionStore()));
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    },
  );

  // A guest write never re-submits: it recovers to the claimed GET screen
  // holding the form or button (TOG-12399). An edit form shares its path
  // with its update POST; the recovery reads it, it never re-posts.
  it.each(CANONICAL_POST)("guests at POST %s go to write recovery", async (path) => {
    const route = path.replace(":key", "some-key").replace(":id", "1");
    const res = await request(route, envFor(createMemorySessionStore()), {
      method: "POST",
      headers: { origin: APP_URL },
    });
    expect(res.status).toBe(303);
    const location = new URL(res.headers.get("location")!, APP_URL);
    expect(location.pathname).toBe("/auth/recover");
    const screens = CANONICAL_GET.map((p) => p.replace(":key", "some-key").replace(":id", "1"));
    expect(screens).toContain(location.searchParams.get("next"));
  });

  it.each([...CANONICAL_GET, ...Object.keys(LEGACY_GET)])(
    "non-moderators get 403 at GET %s",
    async (path) => {
      const store = createMemorySessionStore();
      const env = envFor(store);
      const cookie = await cookieFor(store, false);
      const route = path.includes(":")
        ? path.replace(":key", "some-key").replace(":id", "1")
        : path;
      const res = await request(route, env, { headers: { cookie } });
      expect(res.status, route).toBe(403);
      expect(await res.text()).toBe("Forbidden");
    },
  );

  it.each(CANONICAL_POST)("non-moderators get 403 at POST %s", async (path) => {
    const store = createMemorySessionStore();
    const env = envFor(store);
    const cookie = await cookieFor(store, false);
    const route = path.replace(":key", "some-key").replace(":id", "1");
    const res = await request(route, env, { method: "POST", headers: { cookie, origin: APP_URL } });
    expect(res.status, route).toBe(403);
  });

  it.each(["/", "/events/new", "/featured/new"])(
    "moderators reach DB-free GET /admin%s without a database",
    async (path) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, true);
      const res = await request(`/admin${path === "/" ? "" : path}`, envFor(store), {
        headers: { cookie },
      });
      expect(res.status, path).toBe(200);
    },
  );

  it.each([
    ...CANONICAL_GET.filter(
      (p) => !["/admin", "/admin/events/new", "/admin/featured/new"].includes(p),
    ),
    ...CANONICAL_POST,
  ])("moderator %s exists past the guard (503 without a database, never 404)", async (path) => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const route = path.replace(":key", "some-key").replace(":id", "1");
    const [method, routePath] = CANONICAL_POST.includes(path)
      ? (["POST", route] as const)
      : (["GET", route] as const);
    const res = await request(
      routePath,
      envFor(store),
      method === "POST"
        ? { method, headers: { cookie, origin: APP_URL } }
        : { headers: { cookie } },
    );
    // dbOr503 fails closed: the route matched and the guard passed; only the
    // database is missing.
    expect(res.status, `${method} ${routePath}`).toBe(503);
    expect(await res.text()).toBe("Admin temporarily unavailable");
  });
});

describe("admin guide audit: legacy bookmarks 301 with queries dropped (no DB)", () => {
  const cases = Object.entries(LEGACY_GET)
    .filter(([alias]) => alias !== "/admin/featured-contents/:id/edit")
    .map(
      ([alias, target]) =>
        [alias.replace(":key", "game-night"), target.replace(":key", "game-night")] as const,
    );

  it.each(cases)("301s %s to %s and drops every query", async (alias, target) => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request(
      `${alias}?next=%2Fevents&filter=published&token=discard`,
      envFor(store),
      { headers: { cookie } },
    );
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(target);
  });

  it("resolves the legacy featured ID from the imported ID, never a same-number native row", async () => {
    const query = vi.fn(async (_sql: string, params: unknown[]) => ({
      rows: params[0] === "1" ? [[2]] : [],
    }));
    const db = drizzle(query) as unknown as Db;
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit?drop=1", envFor(store, db), {
      headers: { cookie },
    });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin/featured/2");
    expect(query.mock.calls[0]![1]).toEqual(["1"]);
  });

  it("404s an unmapped legacy featured ID instead of falling back to a native row", async () => {
    const { db, query } = emptyDb();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit", envFor(store, db), {
      headers: { cookie },
    });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["0", "01", "1.5", "no-id"])(
    "404s invalid legacy ID %s before reading a binding",
    async (id) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, true);
      // No ADMIN_DB key at all: any database read would throw, so a 404 proves
      // the shape check ran first.
      const res = await request(`/admin/featured-contents/${id}/edit`, envFor(store), {
        headers: { cookie },
      });
      expect(res.status).toBe(404);
    },
  );

  it("503s an unavailable legacy-ID lookup without redirecting", async () => {
    const query = vi.fn(async () => {
      throw new Error("fixture database unavailable");
    });
    const db = drizzle(query) as unknown as Db;
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit", envFor(store, db), {
      headers: { cookie },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("admin guide audit: pause/reopen toggles are mounted and guarded", () => {
  it.each(["rsvp-pause", "rsvp-reopen"])(
    "non-moderator POST /admin/events/:key/%s gets 403",
    async (action) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, false);
      const res = await request(`/admin/events/some-key/${action}`, envFor(store), {
        method: "POST",
        headers: { cookie, origin: APP_URL },
      });
      expect(res.status).toBe(403);
    },
  );

  it.each(["rsvp-pause", "rsvp-reopen"])(
    "moderator POST /admin/events/:key/%s reaches the handler (503 without a database)",
    async (action) => {
      const store = createMemorySessionStore();
      const cookie = await cookieFor(store, true);
      const res = await request(`/admin/events/some-key/${action}`, envFor(store), {
        method: "POST",
        headers: { cookie, origin: APP_URL },
      });
      expect(res.status).toBe(503);
      expect(await res.text()).toBe("Admin temporarily unavailable");
    },
  );

  it("unknown event actions stay 404", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/events/some-key/rsvp-freeze", envFor(store), {
      method: "POST",
      headers: { cookie, origin: APP_URL },
    });
    expect(res.status).toBe(404);
  });
});

describe("admin guide audit: unknown and missing resources 404", () => {
  it("unknown admin paths render the branded 404 without a database", async () => {
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/no-such-screen", envFor(store), { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("We cannot find that page");
  });

  it.each([
    "/admin/events/no-such-key",
    "/admin/featured/999",
    "/admin/join-attempts/999",
    "/admin/join-attempts/0",
    "/admin/featured/abc",
    "/admin/activity-log/999",
  ])("GET %s is 404, never a same-number fallback or a 500", async (path) => {
    const { db } = emptyDb();
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, true);
    const res = await request(path, envFor(store, db), { headers: { cookie } });
    expect(res.status, path).toBe(404);
  });
});
