// Sitemap stored-text admission: the sitemap read fetches only the event key
// and its guard dates, and admits the key in SQL up to
// EGRESS_EVENT_KEY_MAX_BYTES UTF-8 bytes. An oversized key never leaves the
// database; its row is refused whole, keeps its slot under the 1000-row cap
// and is counted in one text-free warning.
//
// Hermetic pins run over a local pg-proxy transport. The real octet_length
// admission proofs live in the live bounded-reads suite
// (test/events-bounded-reads.test.ts). Synthetic rows only.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Db } from "../src/db/index";
import { EGRESS_EVENT_KEY_MAX_BYTES, FEED_EGRESS_LIMIT, sitemapEvents } from "../src/events/reads";
import { buildSitemapUrls, crawlableEvents, renderSitemap } from "../src/seo";
import { projectEventRow } from "./helpers/pg-proxy-event-projection";

const APP_URL = "https://next.example.test";
const STAMP = new Date("2026-07-01T12:00:00Z");
const REFUSAL = "Event egress read refused oversized stored text.";
const bytes = (text: string) => new TextEncoder().encode(text).length;

type StoredRow = { eventKey: string; startsAt: Date; endsAt: Date; updatedAt: Date };
const stored = (eventKey: string, i = 0, over: Partial<StoredRow> = {}): StoredRow => ({
  eventKey,
  startsAt: new Date(STAMP.getTime() + i * 60_000),
  endsAt: new Date(STAMP.getTime() + i * 60_000 + 3_600_000),
  updatedAt: STAMP,
  ...over,
});

// Answers only the sitemap read: published rows in order, capped by the
// emitted LIMIT, encoded in the emitted projection order.
function fixture(rows: StoredRow[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    seen.push({ sql, params: [...params] });
    const limit = /\blimit \$(\d+)$/.exec(sql);
    const capped = limit ? rows.slice(0, Number(params[Number(limit[1]) - 1])) : rows;
    return {
      rows: capped.map((row) =>
        projectEventRow(sql, params, row, (v) =>
          // A finite PostgreSQL year that decodes to an invalid JS Date.
          v instanceof Date
            ? Number.isNaN(v.getTime())
              ? "280000-01-01 00:00:00+00"
              : v.toISOString()
            : v,
        ),
      ),
    };
  }) as unknown as Db;
  return { db, seen };
}

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

const refusals = () => warn.mock.calls.filter(([message]) => message === REFUSAL);

describe("sitemap key admission (hermetic)", () => {
  it("selects only the key and guard dates, admitting the key bytes in SQL", async () => {
    const { db, seen } = fixture([]);
    await sitemapEvents(db);
    expect(seen).toHaveLength(1);
    const projection = seen[0]!.sql.slice(0, seen[0]!.sql.indexOf(" from "));
    expect(projection).toBe(
      'select case when octet_length("event_key") <= $1 then "event_key" end, "starts_at", "ends_at", "updated_at"',
    );
    expect(seen[0]!.params[0]).toBe(EGRESS_EVENT_KEY_MAX_BYTES);
    expect(seen[0]!.params.at(-1)).toBe(FEED_EGRESS_LIMIT);
  });

  it.each([
    ["ASCII", "k", "k"],
    ["2-byte", "é", "k"],
    ["4-byte", "𝄞", "k"],
  ])("admits a %s key at exactly the budget and refuses one byte over", async (_, unit, pad) => {
    const exact = unit.repeat(EGRESS_EVENT_KEY_MAX_BYTES / bytes(unit));
    const under = exact.slice(0, -unit.length) + pad.repeat(bytes(unit) - 1);
    const over = exact + pad;
    expect([bytes(under), bytes(exact), bytes(over)]).toEqual([255, 256, 257]);
    const { db } = fixture([stored(under, 0), stored(exact, 1), stored(over, 2)]);
    expect((await sitemapEvents(db)).map((entry) => entry.key)).toEqual([under, exact]);
    expect(refusals()).toEqual([
      [REFUSAL, { surface: "sitemap", skipped: 1, code: "stored-text-oversized" }],
    ]);
  });

  it("keeps a refused row's slot under the cap and counts a poisoned refusal once", async () => {
    const rows = Array.from({ length: FEED_EGRESS_LIMIT }, (_, i) =>
      stored(`key-${String(i).padStart(4, "0")}`, i),
    );
    rows[3] = stored("x".repeat(EGRESS_EVENT_KEY_MAX_BYTES + 1), 3, {
      updatedAt: new Date(Number.NaN),
    });
    const { db } = fixture(rows);
    const output = await sitemapEvents(db);
    expect(output).toHaveLength(FEED_EGRESS_LIMIT - 1);
    expect(warn.mock.calls).toEqual([
      [
        "Event egress read reached capacity.",
        { surface: "sitemap", limit: FEED_EGRESS_LIMIT, returned: FEED_EGRESS_LIMIT },
      ],
      [REFUSAL, { surface: "sitemap", skipped: 1, code: "stored-text-oversized" }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("xxxx");
  });

  it("bounds the rendered sitemap with every row at the worst-escaping maximal key", async () => {
    // `"` is the widest escape (&quot;, 6 bytes), so this is the largest
    // admitted key once rendered. Oversized siblings add nothing.
    const worst = '"'.repeat(EGRESS_EVENT_KEY_MAX_BYTES);
    const rows = Array.from({ length: FEED_EGRESS_LIMIT }, (_, i) =>
      stored(i % 2 ? worst : "x".repeat(1 << 20), i),
    );
    const render = (keys: string[]) =>
      renderSitemap(
        buildSitemapUrls(
          APP_URL,
          crawlableEvents(
            keys.map((key) => ({ key, status: "published", updatedAt: STAMP.toISOString() })),
          ),
        ),
      );
    const staticOnly = bytes(render([]));
    const perEntry = bytes(render([""])) - staticOnly + 6 * EGRESS_EVENT_KEY_MAX_BYTES;
    const { db } = fixture(rows);
    const body = bytes(render((await sitemapEvents(db)).map((entry) => entry.key)));
    expect(body).toBeLessThanOrEqual(staticOnly + FEED_EGRESS_LIMIT * perEntry);
    expect(body).toBe(staticOnly + (FEED_EGRESS_LIMIT / 2) * perEntry);
  });
});
