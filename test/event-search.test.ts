// Event search logging + TopZeroResultSearches (ports legacy EventSearchLogTest, TOG-8400).
// Unit parts need no DB; the round-trip runs on agent-testdb (skipped without DATABASE_URL).
import { serializeSigned } from "hono/utils/cookie";
import postgres from "postgres";
import { beforeEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { eventSearchLogs, events } from "../src/db/admin-schema";
import { createDb, type Db } from "../src/db/index";
import type { Env } from "../src/env";
import { matchQuery, normalizeQuery, recordSearch, topZeroResultSearches } from "../src/events/search-log";
import { searchCondition } from "../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken, type SessionStore } from "../src/sessions";

describe("normalizeQuery (legacy EventSearchLogger::normalize)", () => {
  it.each([
    ["HELLDIV", "helldiv"],
    ["  HELLDIV  ", "helldiv"],
    ["hell   divers", "hell divers"],
    ["hell\t\n divers", "hell divers"],
    ["ÉCHECS", "échecs"],
  ])("%j -> %j", (raw, want) => expect(normalizeQuery(raw)).toBe(want));

  it("strips NUL before matching or logging", () => {
    expect(normalizeQuery("\u0000")).toBeNull();
    expect(normalizeQuery("a\u0000b")).toBe("ab");
    expect(matchQuery("\u0000")).toBeNull();
    expect(matchQuery(" a\u0000b ")).toBe("ab");
  });

  it("matching keeps internal whitespace and case; only logging normalizes", () => {
    expect(matchQuery("  Chess  night ")).toBe("Chess  night");
  });

  it("blank input is not a search", () => {
    expect(normalizeQuery("   ")).toBeNull();
    expect(normalizeQuery("")).toBeNull();
    expect(normalizeQuery(undefined)).toBeNull();
  });

  it("truncates to 255 characters (by code point)", () => {
    expect([...normalizeQuery("a".repeat(300))!]).toHaveLength(255);
    expect([...normalizeQuery("😀".repeat(300))!]).toHaveLength(255);
  });

  it("escapes LIKE wildcards in the search condition", () => {
    expect(searchCondition(null)).toBeUndefined();
    expect(searchCondition("100%_x")).toBeDefined();
  });
});

describe("recordSearch is fail-open", () => {
  // Fake Db whose transaction runs the callback against a fake tx (execute is a no-op, insert is the given values fn).
  const fakeDb = (values: (v: unknown) => unknown) =>
    ({ transaction: async (fn: (tx: unknown) => Promise<void>) => fn({ execute: async () => {}, insert: () => ({ values }) }) }) as unknown as Db;
  const failingDb = fakeDb(async () => { throw new Error("postgres://user:secret@host/db down"); });

  it("never throws and never logs the driver message", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(recordSearch(failingDb, "helldiv", 1)).resolves.toBeUndefined();
    expect(JSON.stringify(warn.mock.calls)).not.toContain("secret");
    warn.mockRestore();
  });

  it("returns at the deadline when the write never settles", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const hung = fakeDb(() => new Promise<void>(() => {}));
    const t0 = Date.now();
    await expect(recordSearch(hung, "helldiv", 1, 30)).resolves.toBeUndefined();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(JSON.stringify(warn.mock.calls)).toContain("LogWriteDeadline");
    warn.mockRestore();
  });

  it("writes nothing for a blank query", async () => {
    const values = vi.fn();
    await recordSearch(fakeDb(values), "  ", 0);
    expect(values).not.toHaveBeenCalled();
  });

  it("clamps a negative count to zero", async () => {
    const values = vi.fn(async () => {});
    await recordSearch(fakeDb(values), "x", -3);
    expect(values).toHaveBeenCalledWith({ normalizedQuery: "x", resultCount: 0 });
  });
});

const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";
const APP_URL = "https://next.example.test";

async function cookieFor(store: SessionStore, moderator: boolean): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: `search-${moderator ? "mod" : "member"}`,
    username: "searcher",
    avatar: null,
    member: true,
    moderator,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  return (await serializeSigned("__Host-two_session", token, SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
}

describe.skipIf(!process.env.DATABASE_URL)("event search (agent-testdb)", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const store = createMemorySessionStore();
  const env = {
    APP_URL,
    DISCORD_CLIENT_ID: "c",
    DISCORD_GUILD_ID: "326474832151838730",
    DISCORD_INVITE_URL: "https://discord.gg/invite",
    DISCORD_CLIENT_SECRET: "s",
    DISCORD_BOT_TOKEN: "b",
    SESSION_SECRET,
    ADMIN_DB: db,
    SESSION_STORE: store,
  } as unknown as Env;
  const req = (path: string, init: RequestInit = {}) => app.request(path, init, env);
  const hour = 3600_000;

  beforeEach(async () => {
    await db.delete(eventSearchLogs);
    await db.delete(events);
    await db.insert(events).values([
      { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA", title: "Friday night Helldivers", description: "Weekly co-op chaos.", startsAt: new Date(Date.now() + 72 * hour), endsAt: new Date(Date.now() + 74 * hour), status: "published" },
      { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAB", title: "Old chess night", startsAt: new Date(Date.now() - 74 * hour), endsAt: new Date(Date.now() - 72 * hour), status: "published" },
      { eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC", title: "Secret draft helldivers", startsAt: new Date(Date.now() + 72 * hour), endsAt: new Date(Date.now() + 74 * hour), status: "draft" },
    ]);
  });

  it("cancels a log INSERT blocked on a table lock (no blocked backend remains)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const locker = postgres(process.env.DATABASE_URL!, { max: 1 });
    try {
      await locker.begin(async (tx) => {
        await tx`lock table event_search_logs in access exclusive mode`;
        const t0 = Date.now();
        await recordSearch(createDb(process.env.DATABASE_URL!), "blocked", 0);
        expect(Date.now() - t0).toBeLessThan(1500);
        await new Promise((r) => setTimeout(r, 300));
        const active = await tx`select count(*)::int as n from pg_stat_activity where datname = current_database() and state = 'active' and wait_event_type = 'Lock' and query ilike '%event_search_logs%' and pid <> pg_backend_pid()`;
        expect(active[0]!.n).toBe(0);
      });
    } finally {
      await locker.end();
      warn.mockRestore();
    }
  });

  it("logs normalized query + count, shows past matches, never caches a search", async () => {
    const res = await req("/events?q=%20HELLDIV%20");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const html = await res.text();
    expect(html).toContain("Friday night Helldivers");
    expect(html).not.toContain("Secret draft");
    const past = await (await req("/events?q=chess")).text();
    expect(past).toContain("Old chess night");

    const rows = await db.select().from(eventSearchLogs).orderBy(eventSearchLogs.id);
    expect(rows.map((r) => [r.normalizedQuery, r.resultCount])).toEqual([["helldiv", 1], ["chess", 1]]);
    // Row shape carries no member identifier at all.
    expect(Object.keys(rows[0]!).sort()).toEqual(["id", "normalizedQuery", "occurredAt", "resultCount"]);
  });

  it("matches an exact title with doubled spaces, logs the collapsed form once; NUL does not 500", async () => {
    await db.insert(events).values({ eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAD", title: "Chess  night", startsAt: new Date(Date.now() + 72 * hour), endsAt: new Date(Date.now() + 74 * hour), status: "published" });
    const html = await (await req("/events?q=Chess%20%20night")).text();
    expect(html).toContain("Chess  night");
    expect((await req("/events?q=%00")).status).toBe(200);
    expect((await req("/events?q=a%00b")).status).toBe(200);
    const rows = await db.select().from(eventSearchLogs).orderBy(eventSearchLogs.id);
    expect(rows.map((r) => r.normalizedQuery)).toEqual(["chess night", "ab"]);
  });

  it("treats % and _ literally and writes no row for blank or absent q", async () => {
    await req("/events?q=%25");
    await req("/events?q=%20%20");
    await req("/events");
    const rows = await db.select().from(eventSearchLogs);
    expect(rows.map((r) => [r.normalizedQuery, r.resultCount])).toEqual([["%", 0]]);
  });

  it("counts zero-result searches, misses only, ties alphabetical", async () => {
    for (const q of ["valorant", "VALORANT", " valorant ", "chess-boxing", "helldivers"]) await req(`/events?q=${encodeURIComponent(q)}`);
    const top = await topZeroResultSearches(db);
    expect(top.map((r) => [r.query, r.searches])).toEqual([["valorant", 3], ["chess-boxing", 1]]);
  });

  it("serves results when the log table is down", async () => {
    await db.execute("alter table event_search_logs rename to event_search_logs_gone" as never).catch(() => {});
    try {
      const res = await req("/events?q=helldiv");
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("Friday night Helldivers");
    } finally {
      await db.execute("alter table if exists event_search_logs_gone rename to event_search_logs" as never).catch(() => {});
    }
  });

  it("widget is moderator-only and shows normalized queries, no identifiers", async () => {
    await req("/events?q=Valorant", { headers: { cookie: await cookieFor(store, false) } });
    const member = await req("/admin", { headers: { cookie: await cookieFor(store, false) }, redirect: "manual" });
    expect(member.status).toBe(403);
    const mod = await req("/admin", { headers: { cookie: await cookieFor(store, true) } });
    expect(mod.status).toBe(200);
    const html = await mod.text();
    const widget = html.slice(html.indexOf('data-testid="top-zero-searches"'));
    expect(widget).toContain("Top searches with no results");
    expect(widget).toContain("valorant");
    expect(widget).not.toContain("search-member");
    expect(widget).not.toContain("searcher");
  });
});
