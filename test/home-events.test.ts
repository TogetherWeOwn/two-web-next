// Homepage teaser parity. Local fixtures only: the proxy records real Drizzle SQL.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, describe, expect, it, vi } from "vitest";
import app from "../src/index";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { HOME_EVENTS_DB_TIMEOUT_MS, HOME_EVENTS_DEADLINE_MS, listHomeUpcoming, loadHomeUpcoming } from "../src/events/reads";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// Prove connection construction failure without opening any database socket.
const { makeSql } = vi.hoisted(() => ({ makeSql: vi.fn((_url: string) => { throw new Error("database unavailable"); }) }));
vi.mock("postgres", () => ({ default: makeSql }));

const NOW = new Date("2030-07-04T18:00:00Z");
const baseEnv: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

function event(id: number, overrides: Partial<typeof events.$inferSelect> = {}): typeof events.$inferSelect {
  const startsAt = new Date(NOW.getTime() + id * 3600_000);
  return {
    id, eventKey: `event-${id}`, title: `Game night ${id}`, game: null, description: "Private host notes",
    startsAt, endsAt: new Date(startsAt.getTime() + 7200_000), timezone: "Europe/London",
    location: "Voice lobby", capacity: null, status: "published", discordEventId: "discord-event-id",
    createdBy: "private-creator-id", rsvpOpen: true, recurrenceFrequency: null, recurrenceCount: null,
    recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function fixture(rows: (typeof events.$inferSelect)[] = [], failAt?: "events" | "rsvps", holdAt?: "events" | "rsvps", featured = false) {
  const queries: { sql: string; params: unknown[] }[] = [];
  let started!: () => void;
  let rejectRead!: (err: Error) => void;
  const waitForStall = new Promise<void>((resolve) => { started = resolve; });
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const db = drizzle(async (sql, params) => {
    // Keep this fixture's SQL assertions scoped to the event reader; featured has its own suite.
    if (sql.includes('from "featured_contents"')) {
      return { rows: featured ? [[1, "Community news", "Featured body", null, null, null]] : [] };
    }
    if (sql.includes("set_config") && params[0] !== `${HOME_EVENTS_DB_TIMEOUT_MS}ms`) return { rows: [] };
    queries.push({ sql, params });
    if (sql.includes("set_config")) return { rows: [] };
    if (failAt && sql.includes(`from "${failAt}"`)) throw new Error("postgres://user:secret@host/db private-member private-session");
    if (holdAt && sql.includes(`from "${holdAt}"`)) {
      started();
      await new Promise<void>((_, reject) => { rejectRead = reject; });
    }
    if (sql.includes('from "rsvps"')) {
      return { rows: [[1, 2], [2, 1]].filter(([id]) => params.includes(id)) };
    }
    // Honor the query's bound status, boundary and cap, not the reader's intent.
    let selected = [...rows];
    if (sql.includes('"status" =')) selected = selected.filter((r) => r.status === params[0]);
    if (sql.includes('"ends_at" >=')) selected = selected.filter((r) => r.endsAt >= new Date(String(params[1])));
    if (sql.includes('order by "events"."starts_at" asc')) {
      selected.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    }
    if (sql.includes("limit")) selected = selected.slice(0, Number(params.at(-1)));
    return { rows: selected.map((row) => columns.map((key) => {
      const value = row[key];
      return value instanceof Date ? value.toISOString() : value;
    })) };
  }) as unknown as Db;
  // pg-proxy has no transactions; run the callback on this SQL-recording fixture.
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  const env = { ...baseEnv, ADMIN_DB: db } as Env;
  return { db, env, queries, waitForStall, rejectRead: () => rejectRead(new Error("late private-session failure")), request: () => app.request("/", {}, env) };
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function freezeNow() {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
}

async function expectEmpty(response: Response, state: "empty" | "unavailable") {
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  const html = await response.text();
  expect(html).toContain('data-testid="home-events-empty"');
  expect(html).toContain(`data-state="${state}"`);
  expect(html).not.toContain('data-testid="home-events-list"');
  expect(html).toMatch(/href="\/join"[^>]*data-testid="home-events-join"/);
  return html;
}

describe("homepage upcoming events", () => {
  it("selects published, not-ended rows soonest first, caps SQL at three and batches going counts", async () => {
    const f = fixture([
      event(4), event(3), event(2), event(1),
      event(5, { status: "draft" }), event(6, { status: "cancelled" }), event(7, { status: "past" }),
      event(8, { endsAt: new Date(NOW.getTime() - 1) }),
    ]);
    const rows = await listHomeUpcoming(f.db, NOW);
    expect(rows.map((r) => r.eventKey)).toEqual(["event-1", "event-2", "event-3"]);
    expect(rows.map((r) => r.goingCount)).toEqual([2, 1, 0]);
    expect(f.queries).toHaveLength(3);
    expect(f.queries[0]!.sql).toContain("set_config('lock_timeout', $1, true)");
    expect(f.queries[0]!.sql).toContain("set_config('statement_timeout', $2, true)");
    expect(f.queries[0]!.params).toEqual([`${HOME_EVENTS_DB_TIMEOUT_MS}ms`, `${HOME_EVENTS_DB_TIMEOUT_MS}ms`]);
    expect(f.queries[1]!.sql).toContain('"events"."status" = $1');
    expect(f.queries[1]!.sql).toContain('"events"."ends_at" >= $2');
    expect(f.queries[1]!.sql).toContain('order by "events"."starts_at" asc, "events"."id" asc limit $3');
    expect(f.queries[1]!.params).toEqual(["published", expect.any(String), 3]);
    expect(f.queries[2]!.sql).toContain('"rsvps"."status" =');
    expect(f.queries[2]!.params).toEqual([1, 2, 3, "going"]);
    expect(f.queries[2]!.sql).not.toContain("user_id");
    expect(Object.keys(rows[0]!).sort()).toEqual(["eventKey", "goingCount", "location", "startsAt", "timezone", "title"]);
  });

  it("includes an in-progress event and one ending exactly now; excludes one ended a millisecond ago", async () => {
    const f = fixture([
      event(1, { startsAt: new Date(NOW.getTime() - 3600_000), endsAt: NOW }),
      event(2, { startsAt: new Date(NOW.getTime() - 1800_000) }),
      event(3, { endsAt: new Date(NOW.getTime() - 1) }),
    ]);
    expect((await listHomeUpcoming(f.db, NOW)).map((r) => r.eventKey)).toEqual(["event-1", "event-2"]);
  });

  it("renders three anonymous signposts with local time, page links, going aggregates and the guest join CTA", async () => {
    freezeNow();
    const f = fixture([event(4), event(2), event(3), event(1)]);
    const response = await f.request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).not.toContain('data-testid="home-events-empty"');
    expect(html.indexOf("Game night 1")).toBeLessThan(html.indexOf("Game night 2"));
    expect(html.indexOf("Game night 2")).toBeLessThan(html.indexOf("Game night 3"));
    expect(html).not.toContain("Game night 4");
    for (const id of [1, 2, 3]) expect(html).toContain(`href="/e/event-${id}"`);
    expect(html).toContain('datetime="2030-07-04T19:00:00.000Z"');
    expect(html).toContain("Thu 4 Jul, 20:00 (Europe/London)");
    expect(html).toContain("Voice lobby");
    expect(html).toContain("2 going");
    expect(html).toContain("0 going");
    expect(html).toContain('href="/events"');
    expect(html).toMatch(/href="\/join"[^>]*data-testid="home-events-join"/);
    for (const privateValue of ["private-creator-id", "discord-event-id", "Private host notes", "user_id", "data-island", "RSVP"]) {
      expect(html).not.toContain(privateValue);
    }
  });

  it.each([undefined, "events"] as const)("preserves featured content alongside the event list or outage fallback (%s)", async (failAt) => {
    freezeNow();
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await fixture([event(1)], failAt, undefined, true).request();
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="featured-content"');
    expect(html).toContain("Community news");
    expect(html).toContain("Featured body");
    expect(html).toContain(failAt ? 'data-state="unavailable"' : 'data-testid="home-events-list"');
    expect(html).toContain('data-testid="home-events-join"');
  });

  it.each(["draft", "cancelled", "past", "ended"])("shows the empty state when only %s events exist", async (status) => {
    freezeNow();
    const row = event(1, status === "ended" ? { endsAt: new Date(NOW.getTime() - 1) } : { status });
    const f = fixture([row]);
    const html = await expectEmpty(await f.request(), "empty");
    expect(html).toContain("Nothing scheduled yet.");
    expect(html).not.toContain(row.title);
    expect(f.queries).toHaveLength(2); // settings + events, no aggregate query for an empty list
  });

  it("shows a designed empty state without any rows", async () => {
    await expectEmpty(await fixture().request(), "empty");
  });

  it("escapes public titles and locations and URL-encodes the event key", async () => {
    freezeNow();
    const f = fixture([event(1, { title: '<script>alert("x")</script>', location: '<img src=x onerror="alert(1)">', eventKey: 'key/"?' })]);
    const html = await (await f.request()).text();
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain('href="/e/key%2F%22%3F"');
  });

  it.each(["events", "rsvps"] as const)("degrades to unavailable, still 200, when the %s read rejects", async (failAt) => {
    freezeNow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const html = await expectEmpty(await fixture([event(1)], failAt).request(), "unavailable");
    expect(html).toContain("Game nights are unavailable right now.");
    expect(html).not.toContain("Nothing scheduled yet.");
    expect(html).not.toContain("Game night 1");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", { exception: "ReadFailure" });
    for (const secret of ["postgres://", "secret", "private-member", "private-session", "select"]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    }
  });

  it.each(["events", "rsvps"] as const)("returns 200 at the deadline when the %s read stalls, and handles late rejection", async (holdAt) => {
    freezeNow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const f = fixture([event(1)], undefined, holdAt);
    const request = f.request();
    await f.waitForStall;
    await vi.advanceTimersByTimeAsync(HOME_EVENTS_DEADLINE_MS);
    await expectEmpty(await request, "unavailable");
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", { exception: "HomeEventsDeadline" });
    expect(vi.getTimerCount()).toBe(0);
    f.rejectRead();
    await vi.advanceTimersByTimeAsync(0);
    expect(warn).toHaveBeenCalledTimes(1); // no duplicate or unhandled late rejection
    expect(f.queries).toHaveLength(holdAt === "events" ? 2 : 3);
  });

  it("bounds DB setup too and clears the timer after a successful read", async () => {
    freezeNow();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const pending = loadHomeUpcoming(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(HOME_EVENTS_DEADLINE_MS);
    expect(await pending).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home events unavailable; serving the fallback.", { exception: "HomeEventsDeadline" });
    await fixture().request();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("labels each card's effective zone, including the UTC fallback for an invalid zone", async () => {
    freezeNow();
    const startsAt = new Date("2030-07-05T00:30:00Z");
    const html = await (await fixture([
      event(1, { startsAt, timezone: "Europe/London" }),
      event(2, { startsAt, timezone: "America/New_York" }),
      event(3, { startsAt, timezone: "Invalid/Zone" }),
    ]).request()).text();
    expect(html).toContain("Fri 5 Jul, 01:30 (Europe/London)");
    expect(html).toContain("Thu 4 Jul, 20:30 (America/New_York)");
    expect(html).toContain("Fri 5 Jul, 00:30 (UTC)");
    expect(html).not.toContain("Invalid/Zone");
  });

  it("degrades when DB configuration is missing", async () => {
    await expectEmpty(await app.request("/", {}, baseEnv), "unavailable");
  });

  it("degrades even when session and event DB construction fail, without substituting a connection", async () => {
    const env = { ...baseEnv, DATABASE_URL: "postgres://unavailable.invalid/test", DB: { connectionString: "postgres://unused.invalid/test" } } as Env;
    const html = await expectEmpty(await app.request("/", {}, env), "unavailable");
    expect(html).toContain("Sign in with Discord");
    expect(makeSql).toHaveBeenCalled();
    for (const call of makeSql.mock.calls) expect(call[0]).toBe(env.DATABASE_URL);
  });

  it("fails closed to guest if session lookup fails, without affecting the public event selection", async () => {
    freezeNow();
    const f = fixture([event(1)]);
    const store = createMemorySessionStore();
    const token = newSessionToken();
    await store.create({ tokenHash: await hashToken(token), userId: "private-member", username: "Private member name", avatar: null,
      member: true, moderator: true, expiresAt: new Date(NOW.getTime() + 3600_000) });
    const cookie = (await serializeSigned("__Host-two_session", token, baseEnv.SESSION_SECRET, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" })).split(";")[0]!;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(store, "get").mockRejectedValue(new Error("postgres://user:secret@host/db private-member private-session"));
    const response = await app.request("/", { headers: { cookie } }, { ...f.env, SESSION_STORE: store } as Env);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('data-testid="home-events-list"');
    expect(html).toContain('data-testid="home-events-join"');
    expect(html).not.toContain("Private member name");
    expect(html).not.toContain("Sign out");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(warn).toHaveBeenCalledExactlyOnceWith("Home session unavailable; serving as guest.", { exception: "SessionReadFailure" });
    for (const secret of ["postgres://", "secret", "private-member", "private-session"]) {
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    }
  });
});
