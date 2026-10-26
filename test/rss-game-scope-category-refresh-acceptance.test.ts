// route-inventory: GET /events.rss
// route-inventory: GET /events.ics
// Acceptance-owned: RSS game scope, per-item game category and feed refresh
// interval, driven as route -> real read -> emitted SQL -> injected driver ->
// wire bytes, plus the schedule-head RSS href through the real renderer.
// Catches an RSS route that drops/ignores `game`, LIKE or post-LIMIT scoping,
// reflected malformed scopes, unescaped XML/ICS category text, missing or
// duplicated refresh literals, and a schedule-head RSS link that stays
// hard-coded while the webcal/.ics links beside it carry the game filter.
import { createHash } from "node:crypto";
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { jsx } from "hono/jsx/jsx-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { CalendarHead } from "../src/events/pages-calendar-controls";
import { createMemorySessionStore } from "../src/sessions";
import app from "./app";
import { APP_URL, KEY, OTHER_KEY, type CalendarRow, calendarRow } from "./helpers/ics-wire-fixture";

const NOW = new Date("2026-07-15T19:00:00Z");
const THIRD_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const FOURTH_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAY";
const columns = Object.keys(getTableColumns(events)) as (keyof CalendarRow)[];
const rssPath = (game: string) => `/events.rss?${new URLSearchParams({ game })}`;

function fixture(rows: CalendarRow[]) {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql, params: [...params] });
    if (!sql.includes('from "events"')) throw new Error("Unexpected non-event read");
    const where = sql.split(/\bwhere\b/i)[1] ?? "";
    let result = rows.filter((row) => params.includes(row.status) && row.endsAt >= NOW);
    // This transport models the normalized exact SQL predicate, NOT the
    // incoming URL. If the route drops game, the driver returns all games.
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
    queries,
    getSession,
    request: (path: string, headers: HeadersInit = {}) => app.request(path, { headers }, env),
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
  expect(where).toMatch(/"ends_at" >= \$\d+/);
  expect(query.sql).toMatch(/order by "events"\."starts_at" asc, "events"\."id" asc limit \$\d+/);
  const limit = /\blimit\s+\$(\d+)/i.exec(query.sql);
  expect(query.params[Number(limit?.[1]) - 1]).toBe(1000);
}

const xmlDecode = (v: string) =>
  v
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const channelTitle = (body: string) => /<title>([^<]*)<\/title>/.exec(body)?.[1];

function selfLink(body: string): URL {
  const href = /<atom:link href="([^"]*)" rel="self"/.exec(body)?.[1];
  expect(href, "atom self-link exists").toBeTruthy();
  return new URL(xmlDecode(href!));
}

const items = (body: string) => [...body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]!);
const itemKeys = (body: string) =>
  items(body).map((item) => /\/e\/([A-Za-z0-9-]+)<\/guid>/.exec(item)?.[1]);

const unfold = (body: string) => body.replace(/\r\n[ \t]/g, "");
const icsLines = (body: string) => unfold(body).split("\r\n");
const property = (body: string, name: string) =>
  icsLines(body)
    .filter((line) => line.startsWith(`${name}:`))
    .map((line) => line.slice(name.length + 1));

function twoGameRows(): CalendarRow[] {
  return [
    calendarRow({ game: "Helldivers 2" }),
    calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Factorio", title: "Factory night" }),
    calendarRow({ id: 3, eventKey: THIRD_KEY, game: null, title: "Open social" }),
  ];
}

describe("game-scoped RSS feed", () => {
  it("scopes rows, channel title and self-link to the committed game, mirroring ICS naming", async () => {
    const source = fixture(twoGameRows());
    const response = await source.request(rssPath("Helldivers 2"));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
    assertPublic(response);
    const body = await response.text();
    expect(itemKeys(body)).toEqual([KEY]);
    expect(body).not.toContain("Factory night");
    expect(body).not.toContain("Open social");
    expect(channelTitle(body)).toBe("Together We Own Events — Helldivers 2");
    const self = selfLink(body);
    expect(`${self.origin}${self.pathname}`).toBe(`${APP_URL}/events.rss`);
    expect(self.searchParams.getAll("game")).toEqual(["Helldivers 2"]);
    expect([...self.searchParams.keys()]).toEqual(["game"]);
    expect(response.headers.get("etag")).toBe(
      `"${createHash("sha256").update(body).digest("hex")}"`,
    );
    expect(source.queries).toHaveLength(1);
    assertExactSql(source.queries[0]!, "Helldivers 2");
    expect(source.getSession).not.toHaveBeenCalled();
  });

  it("matches the scope after the same trim/case normalization as ICS", async () => {
    const source = fixture([
      calendarRow({ game: " Helldivers 2 " }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Helldivers 20", title: "Wrong game" }),
    ]);
    const response = await source.request(rssPath("  hELLdIVERS 2  "));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(itemKeys(body)).toEqual([KEY]);
    expect(body).not.toContain("Wrong game");
    expect(channelTitle(body)?.toLowerCase()).toContain("helldivers 2");
    expect(selfLink(body).searchParams.getAll("game")).toHaveLength(1);
    expect(source.queries).toHaveLength(1);
    assertExactSql(source.queries[0]!, "Helldivers 2");
  });

  it("escapes a metachar scope in the channel title and keeps it one bound value", async () => {
    const game = "A&B <Quest>";
    const source = fixture([
      calendarRow({ game }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Other", title: "Wrong game" }),
    ]);
    const response = await source.request(rssPath(game));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(itemKeys(body)).toEqual([KEY]);
    expect(channelTitle(body)).toBe("Together We Own Events — A&amp;B &lt;Quest&gt;");
    expect(body).not.toContain("<Quest>");
    expect(selfLink(body).searchParams.getAll("game")).toEqual([game]);
    assertExactSql(source.queries[0]!, game);
  });

  it("keeps an unknown game an empty scoped feed, never all games", async () => {
    const source = fixture(twoGameRows());
    const response = await source.request(rssPath("Removed Game"));
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(items(body)).toEqual([]);
    expect(channelTitle(body)).toBe("Together We Own Events — Removed Game");
    expect(selfLink(body).searchParams.getAll("game")).toEqual(["Removed Game"]);
    expect(source.queries).toHaveLength(1);
    assertExactSql(source.queries[0]!, "Removed Game");
  });

  it.each(["x".repeat(101), "nul\u0000game", "raid\r\nBEGIN:VEVENT", "bidi‮game", "bad\u0001game"])(
    "refuses malformed/overlong scope with 400, no reflection and no read: %j",
    async (game) => {
      const source = fixture(twoGameRows());
      const response = await source.request(rssPath(game), { "if-none-match": "*" });
      expect(response.status).toBe(400);
      const body = await response.text();
      expect(body).not.toContain(game);
      expect(body).not.toContain("<rss");
      expect(response.headers.get("etag")).toBeNull();
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(source.queries).toHaveLength(0);
    },
  );

  it.each([undefined, "", "   "])(
    "CONTROL: scope %s keeps every row, the unscoped title and a queryless self-link",
    async (game) => {
      const source = fixture(twoGameRows());
      const response = await source.request(game === undefined ? "/events.rss" : rssPath(game));
      expect(response.status).toBe(200);
      assertPublic(response);
      const body = await response.text();
      expect(itemKeys(body)).toEqual([KEY, OTHER_KEY, THIRD_KEY]);
      expect(channelTitle(body)).toBe("Together We Own Events");
      const self = selfLink(body);
      expect(`${self.origin}${self.pathname}`).toBe(`${APP_URL}/events.rss`);
      expect(self.search).toBe("");
      expect(source.queries).toHaveLength(1);
      expect(source.queries[0]!.sql.split(/\bwhere\b/i)[1]).not.toMatch(/"game"/);
    },
  );

  it("CONTROL: q/month/page do not scope RSS", async () => {
    const source = fixture(twoGameRows());
    const response = await source.request("/events.rss?q=not-found&month=2030-01&page=9");
    expect(response.status).toBe(200);
    expect(itemKeys(await response.text())).toEqual([KEY, OTHER_KEY, THIRD_KEY]);
    expect(source.queries[0]!.sql.split(/\bwhere\b/i)[1]).not.toMatch(/"game"/);
  });

  it("hashes scoped bytes; same scope 304s, other scopes cannot reuse the validator", async () => {
    const source = fixture(twoGameRows());
    const first = await source.request(rssPath("Helldivers 2"));
    const body = await first.text();
    const etag = first.headers.get("etag")!;
    expect(etag).toBe(`"${createHash("sha256").update(body).digest("hex")}"`);
    const same = await source.request(rssPath("Helldivers 2"), { "if-none-match": etag });
    expect(same.status).toBe(304);
    expect(await same.text()).toBe("");
    assertPublic(same);
    for (const path of [rssPath("Factorio"), rssPath("Removed Game"), "/events.rss"]) {
      const other = await source.request(path, { "if-none-match": etag });
      expect(other.status).toBe(200);
      expect(other.headers.get("etag")).not.toBe(etag);
    }
  });

  it("keeps the published+cancelled status scope under a game scope", async () => {
    const source = fixture([
      calendarRow({ game: "Helldivers 2" }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: "Helldivers 2", status: "cancelled" }),
      calendarRow({
        id: 3,
        eventKey: THIRD_KEY,
        game: "Helldivers 2",
        status: "draft",
        title: "Secret draft",
      }),
      calendarRow({
        id: 4,
        eventKey: FOURTH_KEY,
        game: "Factorio",
        status: "cancelled",
        title: "Other cancelled",
      }),
    ]);
    const response = await source.request(rssPath("Helldivers 2"));
    const body = await response.text();
    expect(itemKeys(body)).toEqual([KEY, OTHER_KEY]);
    expect(body).toContain("<title>Cancelled: Friday night Helldivers</title>");
    expect(body).not.toContain("Secret draft");
    expect(body).not.toContain("Other cancelled");
  });
});

describe("game category on feed items", () => {
  it("carries the stored game as an escaped RSS <category>; null/blank games emit none", async () => {
    const tricky = 'A&B <Quest> "Raid"; night, fall\\back';
    const source = fixture([
      calendarRow({ game: tricky }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: null, title: "No game" }),
      calendarRow({ id: 3, eventKey: THIRD_KEY, game: "   ", title: "Blank game" }),
    ]);
    const response = await source.request("/events.rss");
    expect(response.status).toBe(200);
    const body = await response.text();
    const found = items(body);
    expect(found).toHaveLength(3);
    expect(found[0]).toContain(
      "<category>A&amp;B &lt;Quest&gt; &quot;Raid&quot;; night, fall\\back</category>",
    );
    expect(found[0]!.match(/<category>/g) ?? []).toHaveLength(1);
    expect(body).not.toContain("<category>A&B");
    expect(found[1]).not.toContain("<category>");
    expect(found[2]).not.toContain("<category>");
  });

  it("carries the stored game as escaped ICS CATEGORIES; null/blank games emit none", async () => {
    const source = fixture([
      calendarRow({ game: "Raid, Night; Fall\\Back" }),
      calendarRow({ id: 2, eventKey: OTHER_KEY, game: null, title: "No game" }),
      calendarRow({ id: 3, eventKey: THIRD_KEY, game: "   ", title: "Blank game" }),
    ]);
    const response = await source.request("/events.ics");
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(property(body, "CATEGORIES")).toEqual(["Raid\\, Night\\; Fall\\\\Back"]);
    expect(property(body, "UID")).toHaveLength(3);
    for (const line of body.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
  });
});

describe("feed refresh interval", () => {
  it("publishes exactly one <ttl>5</ttl> in the RSS channel, aligned with max-age=300", async () => {
    const source = fixture(twoGameRows());
    const response = await source.request(rssPath("Helldivers 2"));
    expect(response.headers.get("cache-control")).toBe("max-age=300, public");
    const body = await response.text();
    expect(body.match(/<ttl>5<\/ttl>/g) ?? []).toHaveLength(1);
    expect(body.indexOf("<ttl>5</ttl>")).toBeLessThan(body.indexOf("<item>"));
  });

  it("publishes REFRESH-INTERVAL and X-PUBLISHED-TTL once each at calendar level in ICS", async () => {
    const source = fixture(twoGameRows());
    const response = await source.request("/events.ics");
    expect(response.headers.get("cache-control")).toBe("max-age=300, public");
    const body = await response.text();
    const lines = icsLines(body);
    expect(lines.filter((line) => line.startsWith("REFRESH-INTERVAL"))).toEqual([
      "REFRESH-INTERVAL;VALUE=DURATION:PT5M",
    ]);
    expect(property(body, "X-PUBLISHED-TTL")).toEqual(["PT5M"]);
    const firstEvent = lines.indexOf("BEGIN:VEVENT");
    expect(lines.findIndex((line) => line.startsWith("REFRESH-INTERVAL"))).toBeLessThan(firstEvent);
    expect(lines.findIndex((line) => line.startsWith("X-PUBLISHED-TTL:"))).toBeLessThan(firstEvent);
  });
});

describe("schedule-head RSS link", () => {
  const state = { view: "list", month: "2026-07", q: "", game: "", past: false, page: 1 } as const;

  async function headHref(gameFilter: string | null): Promise<URL> {
    const html = await jsx(CalendarHead, {
      state: { ...state },
      appUrl: APP_URL,
      gameFilter,
    }).toString();
    const href = /<a\b[^>]*href="([^"]*)"[^>]*>RSS feed<\/a>/.exec(html)?.[1];
    expect(href, "schedule head carries an RSS feed anchor").toBeTruthy();
    return new URL(xmlDecode(href!), APP_URL);
  }

  it("carries the committed game filter exactly like the webcal/.ics links beside it", async () => {
    const url = await headHref("Helldivers 2");
    expect(url.pathname).toBe("/events.rss");
    expect(url.searchParams.getAll("game")).toEqual(["Helldivers 2"]);
    expect([...url.searchParams.keys()]).toEqual(["game"]);
  });

  it("CONTROL: an unfiltered schedule keeps a queryless RSS href", async () => {
    const url = await headHref(null);
    expect(url.pathname).toBe("/events.rss");
    expect(url.search).toBe("");
  });

  it("encodes a reserved-character game as one query value", async () => {
    const game = 'A&B = #? "Raid"';
    const url = await headHref(game);
    expect(url.pathname).toBe("/events.rss");
    expect(url.searchParams.getAll("game")).toEqual([game]);
    expect([...url.searchParams.keys()]).toEqual(["game"]);
  });
});
