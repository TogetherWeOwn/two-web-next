// route-inventory: GET /events.ics
// Acceptance-owned: route -> real read -> emitted SQL -> injected driver -> ICS.
// Catches lost/LIKE game predicates, post-LIMIT filtering, unsafe scope labels,
// all-games fallbacks and validators that are not bound to the response bytes.
import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { serializeSigned } from "hono/utils/cookie";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { createMemorySessionStore, newSessionToken } from "../src/sessions";
import app from "./app";
import {
  APP_URL,
  KEY,
  OTHER_KEY,
  type CalendarRow,
  calendarBytes,
  calendarRow,
  healthyVevent,
} from "./helpers/ics-wire-fixture";

const NOW = new Date("2026-07-15T19:00:00Z");
const columns = Object.keys(getTableColumns(events)) as (keyof CalendarRow)[];
const scopePath = (game: string) => `/events.ics?${new URLSearchParams({ game })}`;
const unfold = (body: string) => body.replace(/\r\n[ \t]/g, "");
const property = (body: string, name: string) =>
  unfold(body)
    .split("\r\n")
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1));

function fixture(rows = [calendarRow({ game: "Helldivers 2" })]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (!sql.includes('from "events"')) throw new Error("Unexpected non-event read");
    const where = sql.split(/\bwhere\b/i)[1] ?? "";
    let result = rows.filter((row) => params.includes(row.status) && row.endsAt >= NOW);
    // This transport models the existing normalized exact SQL predicate, NOT
    // the incoming URL. If the route drops game, the driver returns all games.
    const match = /lower\(trim\("events"\."game"\)\)\s*=\s*\$(\d+)/i.exec(where);
    if (match) {
      const game = params[Number(match[1]) - 1];
      result = result.filter((row) => row.game?.trim().toLowerCase() === game);
    }
    result = result
      .filter(
        (row) => Number.isFinite(row.startsAt.getTime()) && Number.isFinite(row.endsAt.getTime()),
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime() || a.id - b.id);
    const limit = /\blimit\s+\$(\d+)/i.exec(sql);
    if (limit) result = result.slice(0, Number(params[Number(limit[1]) - 1]));
    return {
      rows: result.map((row) =>
        columns.map((key) => {
          const value = row[key];
          return value instanceof Date ? value.toISOString() : value;
        }),
      ),
    };
  });
  const sessions = createMemorySessionStore();
  const getSession = vi.spyOn(sessions, "get");
  const env = {
    APP_URL,
    ADMIN_DB: db as unknown as Db,
    SESSION_SECRET: "fixture-session-secret-at-least-32-bytes",
    SESSION_STORE: sessions,
  } as unknown as Env;
  return {
    rows,
    queries,
    getSession,
    request: (path = "/events.ics", headers: HeadersInit = {}) =>
      app.request(path, { headers }, env),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function assertPublic(response: Response) {
  expect(response.headers.get("cache-control")).toBe("max-age=300, public");
  expect(response.headers.get("set-cookie")).toBeNull();
  expect(response.headers.get("vary") ?? "").not.toMatch(/cookie|authorization/i);
}

function assertExactSql(query: { sql: string; params: unknown[] }, game: string) {
  const where = query.sql.split(/\bwhere\b/i)[1] ?? "";
  expect(where).toMatch(/lower\(trim\("events"\."game"\)\)\s*=\s*\$\d+/i);
  expect(where).not.toMatch(/\bilike\b|\blike\b/i);
  expect(query.params).toContain(game.toLowerCase());
  expect(query.sql).not.toContain(game);
  expect(where).toMatch(/isfinite\("events"\."starts_at"\)/i);
  expect(where).toMatch(/isfinite\("events"\."ends_at"\)/i);
  expect(where).toMatch(/"ends_at" >= \$\d+/);
  expect(query.sql).toMatch(/order by "events"\."starts_at" asc, "events"\."id" asc limit \$\d+/);
  const limit = /\blimit\s+\$(\d+)/i.exec(query.sql);
  expect(query.params[Number(limit?.[1]) - 1]).toBe(1000);
}

describe("public game-scoped calendar collection", () => {
  it.each([undefined, "", "   "])(
    "CONTROL: %s keeps the exact unfiltered bytes and public validator",
    async (game) => {
      const source = fixture();
      const cookie = (
        await serializeSigned(
          "__Host-two_session",
          newSessionToken(),
          "fixture-session-secret-at-least-32-bytes",
          { path: "/", secure: true, httpOnly: true, sameSite: "Lax" },
        )
      ).split(";")[0]!;
      const response = await source.request(game === undefined ? "/events.ics" : scopePath(game), {
        cookie,
      });
      expect(response.status).toBe(200);
      assertPublic(response);
      const body = await response.text();
      expect(body).toBe(calendarBytes(healthyVevent(KEY, "Helldivers 2")));
      expect(response.headers.get("etag")).toBe(
        `"${createHash("sha256").update(body).digest("hex")}"`,
      );
      const unchanged = await source.request("/events.ics", {
        "if-none-match": response.headers.get("etag")!,
      });
      expect(unchanged.status).toBe(304);
      assertPublic(unchanged);
      expect(await unchanged.text()).toBe("");
      expect(source.getSession).not.toHaveBeenCalled();
    },
  );

  it.each(["Helldivers 2", "  hELLdIVERS 2  "])(
    "matches %s exactly after trim/case normalization",
    async (game) => {
      const source = fixture([
        calendarRow({ game: " Helldivers 2 " }),
        calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Helldivers 20", title: "Wrong game" }),
      ]);
      const response = await source.request(scopePath(game));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(property(body, "UID")).toEqual([`${KEY}@next.example.test`]);
      expect(property(body, "X-WR-CALNAME")[0]?.toLowerCase()).toContain("helldivers 2");
      expect(body).not.toContain("Wrong game");
      expect(source.queries).toHaveLength(1);
      assertExactSql(source.queries[0]!, "Helldivers 2");
      assertPublic(response);
      expect(source.getSession).not.toHaveBeenCalled();
    },
  );

  it.each(["Unknown Game", "Removed Game"])(
    "%s remains an empty scoped feed, never all games",
    async (game) => {
      const source = fixture();
      const response = await source.request(scopePath(game));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(body).toContain("BEGIN:VCALENDAR\r\n");
      expect(property(body, "UID")).toEqual([]);
      expect(property(body, "X-WR-CALNAME")[0]?.toLowerCase()).toContain(game.toLowerCase());
      expect(source.queries).toHaveLength(1);
      assertExactSql(source.queries[0]!, game);
    },
  );

  it("filters in the SQL WHERE before the 1000-row cap, not after the unfiltered cap", async () => {
    const source = fixture([
      ...Array.from({ length: 1000 }, (_, i) =>
        calendarRow({
          id: i + 1,
          eventKey: `${KEY.slice(0, 22)}${String(i).padStart(4, "0")}`,
          game: "Other",
          startsAt: new Date("2026-07-15T17:00:00Z"),
        }),
      ),
      calendarRow({ id: 1001, game: "Helldivers 2", eventKey: OTHER_KEY }),
    ]);
    const response = await source.request(scopePath("Helldivers 2"));
    expect(response.status).toBe(200);
    expect(property(await response.text(), "UID")).toEqual([`${OTHER_KEY}@next.example.test`]);
    expect(source.queries).toHaveLength(1);
    assertExactSql(source.queries[0]!, "Helldivers 2");
  });

  it("keeps cancelled revisions, excludes drafts/past/non-finite rows, and preserves UID/SEQUENCE", async () => {
    const source = fixture([
      calendarRow({ game: "Helldivers 2" }),
      calendarRow({
        id: 2,
        eventKey: OTHER_KEY,
        game: "Helldivers 2",
        status: "cancelled",
        icsSequence: 1782907201n,
      }),
      calendarRow({ id: 3, game: "Helldivers 2", status: "draft", title: "Secret draft" }),
      calendarRow({
        id: 4,
        game: "Helldivers 2",
        endsAt: new Date("2026-07-14T20:00:00Z"),
        title: "Past row",
      }),
      calendarRow({ id: 5, game: "Helldivers 2", startsAt: new Date(NaN), title: "Nonfinite row" }),
      calendarRow({ id: 6, game: "Other", title: "Other game" }),
    ]);
    const response = await source.request(scopePath("Helldivers 2"));
    const body = await response.text();
    expect(property(body, "UID")).toEqual([
      `${KEY}@next.example.test`,
      `${OTHER_KEY}@next.example.test`,
    ]);
    expect(property(body, "SEQUENCE")).toEqual(["82907200", "82907201"]);
    expect(property(body, "STATUS")).toEqual(["CONFIRMED", "CANCELLED"]);
    expect(body).not.toMatch(/Secret draft|Past row|Nonfinite row|Other game/);
    assertExactSql(source.queries[0]!, "Helldivers 2");
  });

  it.each(["%_", "x' OR 1=1 --", "東京 🎮;raid,back\\slash", 'A&B = #? <tag>"', "🎮".repeat(100)])(
    "binds and safely labels the literal game %s",
    async (game) => {
      const source = fixture([
        calendarRow({ game }),
        calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Other" }),
      ]);
      const response = await source.request(scopePath(game));
      expect(response.status).toBe(200);
      const body = await response.text();
      expect(property(body, "UID")).toEqual([`${KEY}@next.example.test`]);
      const labels = property(body, "X-WR-CALNAME");
      expect(labels).toHaveLength(1);
      const decoded = labels[0]!.replace(/\\([nN,;\\])/g, (_, char: string) =>
        char.toLowerCase() === "n" ? "\n" : char,
      );
      expect(decoded.toLowerCase()).toContain(game.toLowerCase());
      for (const line of body.split("\r\n"))
        expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
      expect(body.match(/BEGIN:VCALENDAR/g)).toHaveLength(1);
      expect(body.match(/END:VCALENDAR/g)).toHaveLength(1);
      assertExactSql(source.queries[0]!, game);
    },
  );

  it.each(["x".repeat(101), "nul\u0000game", "raid\r\nBEGIN:VEVENT", "bidi‮game", "bad\u0001game"])(
    "refuses malformed/overlong scope without unsafe reflection: %j",
    async (game) => {
      const source = fixture();
      const response = await source.request(scopePath(game), { "if-none-match": "*" });
      expect([400, 422]).toContain(response.status);
      const body = await response.text();
      expect(body).not.toContain(game);
      expect(body).not.toContain("BEGIN:VCALENDAR");
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(source.queries).toHaveLength(0);
    },
  );

  it("hashes scoped bytes; same scope 304s, other scopes cannot reuse the validator", async () => {
    const source = fixture([
      calendarRow({ game: "Helldivers 2" }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Factorio" }),
    ]);
    const first = await source.request(scopePath("Helldivers 2"));
    const body = await first.text();
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    const same = await source.request(scopePath("Helldivers 2"), { "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    assertPublic(same);
    for (const path of [scopePath("Factorio"), scopePath("Unknown"), "/events.ics"]) {
      const other = await source.request(path, { "if-none-match": etag });
      expect(other.status).toBe(200);
      expect(other.headers.get("etag")).not.toBe(etag);
      const bytes = await other.text();
      expect(other.headers.get("etag")).toBe(
        `"${createHash("sha256").update(bytes).digest("hex")}"`,
      );
    }
    expect(source.getSession).not.toHaveBeenCalled();
  });

  it("CONTROL: q/month/page do not filter ICS or RSS", async () => {
    const source = fixture();
    const feed = await source.request("/events.ics?q=not-found&month=2030-01&page=9");
    expect(await feed.text()).toBe(calendarBytes(healthyVevent(KEY, "Helldivers 2")));
    const rss = await source.request("/events.rss?q=not-found&month=2030-01&page=9");
    expect(rss.status).toBe(200);
    expect(await rss.text()).toContain("Friday night Helldivers");
    expect(source.queries).toHaveLength(2);
    expect(source.queries[1]!.sql.split(/\bwhere\b/i)[1]).not.toMatch(/"game"/);
  });
});
