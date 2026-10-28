// route-inventory: GET /events.rss
// Real route, read admission and RSS builder; injected pg-proxy, no database/network.
import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import app from "./app";
import { APP_URL, KEY, OTHER_KEY, type CalendarRow, calendarRow } from "./helpers/ics-wire-fixture";

const columns = Object.keys(getTableColumns(events)) as (keyof CalendarRow)[];

function fixture(rows: CalendarRow[]) {
  const query = vi.fn(async (sql: string, params: unknown[]) => {
    if (!sql.includes('from "events"') || !sql.includes('"status" in'))
      throw new Error("Unexpected RSS fixture query");
    expect(params).toContain("published");
    expect(params).toContain("cancelled");
    const cutoff = params.find(
      (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value),
    );
    if (typeof cutoff !== "string") throw new Error("Expected feed cutoff");
    return {
      rows: rows
        .filter((row) => row.status === "published" && row.endsAt >= new Date(cutoff))
        .map((row) =>
          columns.map((key) => {
            const value = row[key];
            return value instanceof Date
              ? Number.isFinite(value.getTime())
                ? value.toISOString()
                : "infinity"
              : value;
          }),
        ),
    };
  });
  const env = { APP_URL, ADMIN_DB: drizzle(query) as unknown as Db } as unknown as Env;
  return {
    query,
    request: (etag?: string) =>
      app.request("/events.rss", etag ? { headers: { "if-none-match": etag } } : {}, env),
  };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-07-15T19:00:00Z"));
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("RSS wire timestamp responses", () => {
  it.each([
    ["invalid", new Date(NaN)],
    ["expanded", new Date("+010000-01-02T03:04:05Z")],
    ["negative", new Date("-000001-01-02T03:04:05Z")],
  ])(
    "keeps the item with %s updatedAt and serves a wire channel date",
    async (_label, updatedAt) => {
      const source = fixture([
        calendarRow({ updatedAt }),
        calendarRow({ id: 2, eventKey: OTHER_KEY }),
      ]);
      const first = await source.request();
      expect(first.status).toBe(200);
      expect(source.query).toHaveBeenCalledTimes(1);
      expect(first.headers.get("content-type")).toBe("application/rss+xml; charset=utf-8");
      expect(first.headers.get("cache-control")).toBe("max-age=300, public");
      expect(first.headers.get("set-cookie")).toBeNull();
      const body = await first.text();
      expect(body.match(/<item>/g)).toHaveLength(2);
      for (const key of [KEY, OTHER_KEY])
        expect(body).toContain(`<guid isPermaLink="true">${APP_URL}/e/${key}</guid>`);
      expect(body).toContain("<lastBuildDate>Wed, 01 Jul 2026 12:00:00 +0000</lastBuildDate>");
      expect(body).not.toMatch(/NaN|infinity|010000|-000001/);
      // DB-free env: the events-read throttle fails open with a null-store
      // line before the feed's own diagnostic.
      expect(console.warn).toHaveBeenCalledTimes(2);
      expect(console.warn).toHaveBeenNthCalledWith(
        1,
        "Throttle store unavailable; allowing the request.",
        { throttle: "events-read" },
      );
      expect(console.warn).toHaveBeenNthCalledWith(
        2,
        "eventsRss excluded non-wire updatedAt from lastBuildDate.",
        { skipped: 1 },
      );
      const etag = first.headers.get("etag");
      expect(etag).toMatch(/^"[a-f0-9]{64}"$/);
      const unchanged = await source.request(etag!);
      expect(unchanged.status).toBe(304);
      expect(unchanged.headers.get("etag")).toBe(etag);
      expect(await unchanged.text()).toBe("");
    },
  );

  it("uses the epoch only when every updatedAt is poison, without dropping items", async () => {
    const source = fixture([calendarRow({ updatedAt: new Date("+010000-01-01T00:00:00Z") })]);
    const response = await source.request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.match(/<item>/g)).toHaveLength(1);
    expect(body).toContain(`<link>${APP_URL}/e/${KEY}</link>`);
    expect(body).toContain("<lastBuildDate>Thu, 01 Jan 1970 00:00:00 +0000</lastBuildDate>");
  });

  it("uses a pre-epoch update and pads an eligible low-year item through the real route", async () => {
    const source = fixture([
      calendarRow({
        startsAt: new Date("0500-01-02T03:04:05Z"),
        updatedAt: new Date("0500-01-02T03:04:05Z"),
      }),
    ]);
    const response = await source.request();
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body.match(/<item>/g)).toHaveLength(1);
    expect(body).toContain("<pubDate>Sat, 02 Jan 0500 03:04:05 +0000</pubDate>");
    expect(body).toContain("<lastBuildDate>Sat, 02 Jan 0500 03:04:05 +0000</lastBuildDate>");
    // The feed itself stays quiet; the only line is the DB-free null-store
    // throttle allow.
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      "Throttle store unavailable; allowing the request.",
      { throttle: "events-read" },
    );
  });
});
