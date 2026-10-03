import { Hono } from "hono";
import { jsx } from "hono/jsx/jsx-runtime";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NotFoundPage } from "../src/errors";
import app from "./app";
import * as adminDb from "../src/admin/db";
import type { EnvWithAdminDb } from "../src/admin/db";
import type { Db } from "../src/db/index";
import { notFoundSuggestions, SUGGESTIONS_DEADLINE_MS } from "../src/events/suggestions";

const event = {
  key: "game-night",
  title: "Game night <friends>",
  startsAt: new Date("2026-10-01T18:00:00Z"),
  location: "Discord <lobby>",
};

describe("404 recovery markup", () => {
  it("renders escaped event links and machine-readable dates", async () => {
    const app = new Hono();
    app.get("/", (c) => c.html(jsx(NotFoundPage, { suggestions: [event] }).toString(), 404));
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('href="/e/game-night"');
    expect(html).toContain("Game night &lt;friends&gt;");
    expect(html).toContain("Discord &lt;lobby&gt;");
    expect(html).toContain('datetime="2026-10-01T18:00:00.000Z"');
    expect(html).not.toContain('data-testid="error-events-empty"');
  });

  it("offers a labelled GET search and browse link without any suggestions", async () => {
    const app = new Hono();
    app.get("/", (c) => c.html(jsx(NotFoundPage, {}).toString(), 404));
    const res = await app.request("/");
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('action="/events" method="get" role="search"');
    expect(html).toContain('<label for="error-events-search">Search events</label>');
    expect(html).toContain('name="q" type="search" placeholder="Search events…"');
    expect(html).toContain('href="/events" data-testid="error-all-events"');
    expect(html).toContain("Nothing is on the calendar right now — check back soon.");
    expect(html).not.toContain('data-testid="error-event-suggestion"');
  });
});

const baseEnv: EnvWithAdminDb = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "guild-id",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

type Fixture = typeof event & { id: number; status: string; endsAt: Date };
function fixture(id: number, status = "published", end = "2026-10-01T20:00:00Z"): Fixture {
  return {
    ...event,
    id,
    key: `game-${id}`,
    title: `Game ${id}`,
    status,
    startsAt: new Date(`2026-10-01T${String(10 + id).padStart(2, "0")}:00:00Z`),
    endsAt: new Date(end),
  };
}

function fixtureDb(rows: Fixture[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params });
    if (!sql.includes('from "events"')) return { rows: [] };
    const boundary = new Date(String(params[1]));
    const visible = rows
      .filter((r) => r.status === params[0] && r.endsAt >= boundary)
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id)
      .slice(0, Number(params[2]));
    return { rows: visible.map((r) => [r.key, r.title, r.startsAt.toISOString(), r.location]) };
  });
  Object.assign(db, {
    transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
  });
  return { db: db as unknown as Db, queries };
}

function sessionTrap() {
  const accessed = vi.fn(() => {
    throw new Error("404 must not touch sessions");
  });
  return { store: new Proxy({}, { get: accessed }), accessed };
}

describe("404 optional event lookup", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("renders only the first three published, not-ended events with SQL timeouts and no sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T12:00:00Z"));
    const { db, queries } = fixtureDb([
      fixture(5),
      fixture(4),
      fixture(3),
      fixture(2),
      fixture(1),
      fixture(0, "draft"),
      fixture(0, "cancelled"),
      fixture(0, "past"),
      fixture(0, "published", "2026-09-30T20:00:00Z"),
    ]);
    const acquire = vi.spyOn(adminDb, "dbFor");
    const sessions = sessionTrap();
    const res = await app.request(
      "/lost/link",
      { headers: { cookie: "__Host-two_session=existing-token" } },
      { ...baseEnv, ADMIN_DB: db, SESSION_STORE: sessions.store } as EnvWithAdminDb,
    );
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store, private");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('content="noindex, nofollow"');
    expect(html.match(/data-testid="error-event-suggestion"/g)).toHaveLength(3);
    expect(html).toContain('href="/e/game-1"');
    expect(html).toContain('href="/e/game-2"');
    expect(html).toContain('href="/e/game-3"');
    expect(html).not.toContain('href="/e/game-0"');
    expect(html).not.toContain('href="/e/game-4"');
    expect(sessions.accessed).not.toHaveBeenCalled();
    expect(acquire).toHaveBeenCalledOnce();
    expect(queries).toHaveLength(2);
    expect(queries[0]!.sql).toContain("set_config('lock_timeout', $1, true)");
    expect(queries[0]!.sql).toContain("set_config('statement_timeout', $2, true)");
    expect(queries[0]!.params).toEqual(["400ms", "400ms"]);
    expect(queries[1]!.sql).toContain(
      '"events" where ("events"."status" = $1 and "events"."ends_at" >= $2 and isfinite("events"."starts_at"))',
    );
    expect(queries[1]!.sql).toContain(
      'order by "events"."starts_at" asc, "events"."id" asc limit $3',
    );
    expect(queries[1]!.params).toEqual(["published", "2026-10-01T12:00:00.000Z", 3]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ["infinity", false],
    ["-infinity", false],
    ["infinity", true],
    ["-infinity", true],
  ] as const)(
    "discards %s start dates and preserves 404 recovery (finite sibling: %s)",
    async (start, includeValid) => {
      const db = drizzle(async (sql) => ({
        rows: sql.includes('from "events"')
          ? [
              ["nonfinite", "Nonfinite event", start, null],
              ...(includeValid
                ? [[event.key, event.title, event.startsAt.toISOString(), event.location]]
                : []),
            ]
          : [],
      }));
      Object.assign(db, {
        transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db as unknown as Db),
      });
      const sessions = sessionTrap();
      const res = await app.request(
        "/lost",
        { headers: { cookie: "__Host-two_session=existing-token" } },
        {
          ...baseEnv,
          ADMIN_DB: db as unknown as Db,
          SESSION_STORE: sessions.store,
        } as EnvWithAdminDb,
      );
      const html = await res.text();
      expect(res.status).toBe(404);
      expect(res.headers.get("cache-control")).toBe("no-store, private");
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(html).toContain('content="noindex, nofollow"');
      expect(html).toContain('action="/events" method="get" role="search"');
      expect(html).not.toContain("Nonfinite event");
      if (includeValid) {
        expect(html).toContain('href="/e/game-night"');
        expect(html).toContain('datetime="2026-10-01T18:00:00.000Z"');
        expect(html).not.toContain('data-testid="error-events-empty"');
      } else {
        expect(html).not.toContain('data-testid="error-event-suggestion"');
        expect(html).toContain('data-testid="error-events-empty"');
      }
      expect(sessions.accessed).not.toHaveBeenCalled();
    },
  );

  it("DB failure keeps a session-free 404 and the search form without leaking the error", async () => {
    const db = {
      transaction: vi.fn().mockRejectedValue(new Error("private database failure")),
    } as unknown as Db;
    const sessions = sessionTrap();
    const res = await app.request("/lost", {}, {
      ...baseEnv,
      ADMIN_DB: db,
      SESSION_STORE: sessions.store,
    } as EnvWithAdminDb);
    const html = await res.text();
    expect(res.status).toBe(404);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(html).toContain('content="noindex, nofollow"');
    expect(html).toContain('action="/events" method="get"');
    expect(html).not.toContain('data-testid="error-event-suggestion"');
    expect(html).not.toContain("private database failure");
    expect(sessions.accessed).not.toHaveBeenCalled();
  });

  it("fails open when the DB factory throws or no DB is configured", async () => {
    expect(await notFoundSuggestions(baseEnv)).toEqual([]);
    vi.spyOn(adminDb, "dbFor").mockRejectedValue(new Error("factory failed"));
    const res = await app.request("/lost", {}, baseEnv);
    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain('data-testid="error-event-suggestion"');
  });

  it.each(["acquisition", "query"])(
    "bounds stalled DB %s at 500 ms, with late rejection handled",
    async (stage) => {
      vi.useFakeTimers();
      let reject!: (error: Error) => void;
      const stalled = new Promise<Db>((_, fail) => {
        reject = fail;
      });
      if (stage === "acquisition") vi.spyOn(adminDb, "dbFor").mockReturnValue(stalled);
      const db = { transaction: () => stalled } as unknown as Db;
      const response = app.request("/lost", {}, { ...baseEnv, ADMIN_DB: db });
      await vi.advanceTimersByTimeAsync(SUGGESTIONS_DEADLINE_MS);
      const res = await response;
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('data-testid="error-event-suggestion"');
      expect(vi.getTimerCount()).toBe(0);
      reject(new Error("late database failure"));
      await vi.advanceTimersByTimeAsync(0);
    },
  );
});
