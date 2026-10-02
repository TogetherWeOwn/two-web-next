// route-inventory: GET /admin/events/create
// route-inventory: GET /admin/events/:key/edit
// route-inventory: GET /admin/featured-contents
// route-inventory: GET /admin/featured-contents/create
// route-inventory: GET /admin/featured-contents/:id/edit
// route-inventory: GET /auth/discord/redirect

import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import app from "../src/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const aliases = [
  ["/admin/events/create", "/admin/events/new"],
  ["/admin/events/game-night/edit", "/admin/events/game-night"],
  ["/admin/featured-contents", "/admin/featured"],
  ["/admin/featured-contents/create", "/admin/featured/new"],
  ["/admin/featured-contents/42/edit", "/admin/featured/42"],
] as const;

function fixture(db?: Db) {
  const store = createMemorySessionStore();
  const dbRead = vi.fn();
  const refuseDb = () => { dbRead(); throw new Error("redirect must not read a database binding"); };
  const env = {
    APP_URL,
    SESSION_SECRET,
    DISCORD_CLIENT_ID: "client-id",
    DISCORD_CLIENT_SECRET: "client-secret",
    DISCORD_BOT_TOKEN: "bot-token",
    DISCORD_GUILD_ID: "guild-id",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    SESSION_STORE: store,
    get DB() { return refuseDb(); },
    get DATABASE_URL() { return refuseDb(); },
    get ADMIN_DB() {
      if (!db) return refuseDb();
      dbRead();
      return db;
    },
  } satisfies Env & { SESSION_STORE: SessionStore; ADMIN_DB: Db };
  return { store, env, dbRead };
}

async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: "100000000000000111",
    username: "fixture-member",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/", secure: true, httpOnly: true, sameSite: "Lax",
  })).split(";")[0]!;
}

const request = (path: string, env: Env, init: RequestInit = {}) => app.request(`${APP_URL}${path}`, init, env);

describe("legacy admin redirects (local fixtures, no DB)", () => {
  it.each(aliases.slice(0, -1))("301s %s after the moderator guard and drops every query", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const res = await request(`${alias}?next=%2Fevents&filter=published&token=discard`, env, { headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(target);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases.slice(0, -1))("keeps HEAD %s guarded with the same redirect", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const res = await request(alias, env, { method: "HEAD", headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(target);
    expect(await res.text()).toBe("");
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases)("sends guests at %s to the same OAuth target as the canonical URL", async (alias, target) => {
    const { env, dbRead } = fixture();
    for (const path of [alias, target]) {
      const res = await request(`${path}?next=%2F%2Fevil`, env);
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe("/auth/discord");
    }
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(aliases)("403s a non-moderator at %s and at its canonical URL", async (alias, target) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, false);
    for (const path of [alias, target]) {
      const res = await request(path, env, { headers: { cookie } });
      expect(res.status).toBe(403);
      expect(await res.text()).toBe("Forbidden");
      expect(res.headers.get("location")).toBeNull();
    }
    expect(dbRead).not.toHaveBeenCalled();
  });

  it("keeps encoded event keys in one target segment", async () => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const segment = "odd%2Fkey%3Fquery%23fragment%25";
    const res = await request(`/admin/events/${segment}/edit?drop=1`, env, { headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/admin/events/${segment}`);
    expect(dbRead).not.toHaveBeenCalled();
  });
});

function featuredFixture(rows: { id: number; legacyId: string | null }[]) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    expect(sql).toBe('select "id" from "featured_contents" where "featured_contents"."legacy_id" = $1');
    return { rows: rows.filter((row) => row.legacyId === params[0]).map((row) => [row.id]) };
  });
  const db = drizzle(query) as unknown as Db;
  return { ...fixture(db), query };
}

describe("legacy featured edit identity (local SQL fixtures)", () => {
  it.each(["GET", "HEAD"])("%s resolves a legacy ID despite a same-number native collision", async (method) => {
    const { store, env, query } = featuredFixture([{ id: 1, legacyId: null }, { id: 2, legacyId: "1" }]);
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit?next=%2Fevents&filter=drop", env, { method, headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin/featured/2");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    if (method === "HEAD") expect(await res.text()).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0]![1]).toEqual(["1"]);
  });

  it.each(["42", "9007199254740993"])("preserves legacy ID %s as text, without rounding", async (legacyId) => {
    const { store, env, query } = featuredFixture([{ id: 7, legacyId }]);
    const cookie = await cookieFor(store, true);
    const res = await request(`/admin/featured-contents/${legacyId}/edit`, env, { headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/admin/featured/7");
    expect(query.mock.calls[0]![1]).toEqual([legacyId]);
  });

  it.each(["GET", "HEAD"])("%s 404s missing mappings rather than using a same-number native row", async (method) => {
    const { store, env, query } = featuredFixture([{ id: 1, legacyId: null }]);
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit", env, { method, headers: { cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    if (method === "HEAD") expect(await res.text()).toBe("");
    expect(query).toHaveBeenCalledTimes(1);
  });

  it.each(["guest", "member"])("denies a %s before identity lookup for GET and HEAD", async (role) => {
    const { store, env, dbRead, query } = featuredFixture([{ id: 2, legacyId: "1" }]);
    const headers: Record<string, string> = role === "member" ? { cookie: await cookieFor(store, false) } : {};
    for (const method of ["GET", "HEAD"]) {
      for (const path of ["/admin/featured-contents/1/edit", "/admin/featured/2"]) {
        const res = await request(path, env, { method, headers });
        expect(res.status).toBe(role === "guest" ? 302 : 403);
        expect(res.headers.get("location")).toBe(role === "guest" ? "/auth/discord" : null);
      }
    }
    expect(dbRead).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });

  it.each(["0", "-1", "01", "1.5", "no-id", "odd%2Fkey%3Fquery%23fragment%25"])("404s invalid legacy ID %s before reading a binding", async (id) => {
    const { store, env, dbRead } = fixture();
    const cookie = await cookieFor(store, true);
    const res = await request(`/admin/featured-contents/${id}/edit`, env, { headers: { cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["GET", "HEAD"])("%s refuses an unavailable identity lookup without redirecting", async (method) => {
    const { store, env, query } = featuredFixture([]);
    query.mockRejectedValueOnce(new Error("fixture database unavailable"));
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit", env, { method, headers: { cookie } });
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });

  it("503s when no database binding is configured", async () => {
    const store = createMemorySessionStore();
    const env: Env & { SESSION_STORE: SessionStore } = {
      APP_URL, SESSION_SECRET, SESSION_STORE: store,
      DISCORD_CLIENT_ID: "client-id", DISCORD_CLIENT_SECRET: "client-secret",
      DISCORD_BOT_TOKEN: "bot-token", DISCORD_GUILD_ID: "guild-id", DISCORD_INVITE_URL: "https://discord.gg/invite",
    };
    const cookie = await cookieFor(store, true);
    const res = await request("/admin/featured-contents/1/edit", env, { headers: { cookie } });
    expect(res.status).toBe(503);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe.skipIf(!process.env.DATABASE_URL)("legacy featured identity on disposable test schemas", () => {
  let data: MemberDataFixture | undefined;
  beforeAll(async () => { data = await createMemberDataFixture(process.env.DATABASE_URL!); });
  afterAll(async () => { await data?.dispose(); });
  beforeEach(async () => { await data!.db.delete(featuredContents); });

  it.each(["GET", "HEAD"])("%s maps the source ID to the imported row, never the colliding native row", async (method) => {
    const [native] = await data!.db.insert(featuredContents).values({ title: "Unrelated native entry" }).returning();
    const [imported] = await data!.db.insert(featuredContents).values({ title: "Imported entry", legacyId: String(native!.id) }).returning();
    const { store, env } = fixture(data!.db);
    const cookie = await cookieFor(store, true);
    const res = await request(`/admin/featured-contents/${native!.id}/edit?drop=1`, env, { method, headers: { cookie } });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe(`/admin/featured/${imported!.id}`);
    expect(imported!.id).not.toBe(native!.id);
    if (method === "HEAD") expect(await res.text()).toBe("");
  });

  it.each(["GET", "HEAD"])("%s returns 404 if only the same-number native row exists", async (method) => {
    const [native] = await data!.db.insert(featuredContents).values({ title: "Unrelated native entry" }).returning();
    const { store, env } = fixture(data!.db);
    const cookie = await cookieFor(store, true);
    const res = await request(`/admin/featured-contents/${native!.id}/edit`, env, { method, headers: { cookie } });
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("legacy login redirect (local fixtures, no DB)", () => {
  it.each(["GET", "HEAD"])("%s defaults to /auth/discord, dropping arbitrary OAuth/query input", async (method) => {
    const { env, dbRead } = fixture();
    const res = await request("/auth/discord/redirect?state=untrusted&code=discard&redirect_uri=https%3A%2F%2Fevil", env, { method });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["/", "/events", "/e/game-night?source=discord&tab=details#rsvp"])("preserves only the guarded next %s", async (next) => {
    const { env, dbRead } = fixture();
    const query = new URLSearchParams({ next, state: "discard", source: "discard" });
    const res = await request(`/auth/discord/redirect?${query}`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/discord?${new URLSearchParams({ next })}`);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });

  it.each(["//evil", "https://evil.test", "javascript:alert(1)", "/\\evil", "relative", "/events\r\nLocation:https://evil.test", "/ events", ""])("drops invalid next %j and lands on the default target", async (next) => {
    const { env, dbRead } = fixture();
    const res = await request(`/auth/discord/redirect?${new URLSearchParams({ next })}`, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/auth/discord");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(dbRead).not.toHaveBeenCalled();
  });
});
