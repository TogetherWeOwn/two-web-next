// Feed stored-text admission: the RSS, ICS and Markdown collection read
// fetches only the columns the builders render, and admits each text column
// in SQL up to its FEED_EGRESS_TEXT_MAX_BYTES UTF-8 budget. An oversized
// value never leaves the database; its row is refused whole, keeps its slot
// under the 1000-row cap and is counted in one text-free warning.
//
// Hermetic pins run over a local pg-proxy transport. The real octet_length
// admission proof lives in the live bounded-reads suite
// (test/events-bounded-reads.test.ts). Synthetic rows only.
import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from "vitest";
import type { Db } from "../src/db/index";
import { eventsIcsCollection, eventsRss } from "../src/events/feeds";
import {
  FEED_EGRESS_LIMIT,
  FEED_EGRESS_TEXT_MAX_BYTES,
  type FeedEventRow,
  listFeed,
} from "../src/events/reads";
import { projectEventRow } from "./helpers/pg-proxy-event-projection";

const APP_URL = "https://next.example.test";
const NOW = new Date("2026-07-01T12:00:00Z");
const REFUSAL = "Event egress read refused oversized stored text.";
const bytes = (text: string) => new TextEncoder().encode(text).length;
type TextField = keyof typeof FEED_EGRESS_TEXT_MAX_BYTES;
const FIELDS = Object.keys(FEED_EGRESS_TEXT_MAX_BYTES) as TextField[];

const stored = (i: number, over: Partial<FeedEventRow> = {}): FeedEventRow => ({
  id: i + 1,
  eventKey: `01J00000000000000000${String(i).padStart(6, "0")}`,
  title: "Game night",
  game: null,
  description: null,
  timezone: "UTC",
  location: null,
  organizer_name: null,
  status: "published",
  capacity: null,
  startsAt: new Date(NOW.getTime() + (i + 1) * 60_000),
  endsAt: new Date(NOW.getTime() + (i + 1) * 60_000 + 3_600_000),
  updatedAt: NOW,
  icsSequence: 0n,
  ...over,
});

// Answers only the feed read, capped by the emitted LIMIT and encoded in the
// emitted projection order.
function fixture(rows: FeedEventRow[]) {
  const seen: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    seen.push({ sql, params: [...params] });
    const limit = /\blimit \$(\d+)$/.exec(sql);
    const capped = limit ? rows.slice(0, Number(params[Number(limit[1]) - 1])) : rows;
    return {
      rows: capped.map((row) =>
        projectEventRow(sql, params, row, (v) =>
          v instanceof Date ? v.toISOString() : typeof v === "bigint" ? v.toString() : v,
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
const read = (db: Db) => listFeed(db, ["published", "cancelled"], NOW);

describe("feed text admission (hermetic)", () => {
  it("pins every budget to its write maximum at 4 UTF-8 bytes per code point", () => {
    expect(FEED_EGRESS_TEXT_MAX_BYTES).toEqual({
      eventKey: 256,
      title: 400,
      game: 400,
      description: 4000,
      timezone: 256,
      location: 1020,
      organizer_name: 2000,
    });
  });

  it("selects only rendered columns and binds each budget to its own column", async () => {
    const { db, seen } = fixture([]);
    await read(db);
    expect(seen).toHaveLength(1);
    const { sql, params } = seen[0]!;
    const admit = (column: string, n: number) =>
      `case when octet_length("${column}") <= $${n} then "${column}" end`;
    const columns = ["event_key", "title", "game", "description", "timezone", "location"];
    const over = [...columns, "organizer_name"]
      .map((column, i) => `octet_length("events"."${column}") > $${i + 8}`)
      .join(" or ");
    expect(sql.slice(0, sql.indexOf(' from "events"'))).toBe(
      `select "id", ${columns.map((c, i) => admit(c, i + 1)).join(", ")}, ${admit("organizer_name", 7)}, "status", "capacity", "starts_at", "ends_at", "updated_at", "ics_sequence", (${over}) is not true`,
    );
    const budgets = FIELDS.map((field) => FEED_EGRESS_TEXT_MAX_BYTES[field]);
    expect(params.slice(0, 14)).toEqual([...budgets, ...budgets]);
    expect(params.at(-1)).toBe(FEED_EGRESS_LIMIT);
  });

  it.each(FIELDS)(
    "admits %s at exactly its byte budget and refuses one byte over",
    async (field) => {
      const budget = FEED_EGRESS_TEXT_MAX_BYTES[field];
      // 4-byte code points: a character-count check would admit both values.
      const exact = "𝄞".repeat(budget / 4);
      const over = `${exact}k`;
      expect([bytes(exact), bytes(over)]).toEqual([budget, budget + 1]);
      const { db } = fixture([stored(0, { [field]: exact }), stored(1, { [field]: over })]);
      const output = await read(db);
      expect(output.map((row) => row.id)).toEqual([1]);
      expect(output[0]![field]).toBe(exact);
      expect(refusals()).toEqual([
        [REFUSAL, { surface: "feed", skipped: 1, code: "stored-text-oversized" }],
      ]);
    },
  );

  it("keeps a refused row's slot under the cap and logs no stored text", async () => {
    const rows = Array.from({ length: FEED_EGRESS_LIMIT + 1 }, (_, i) => stored(i));
    rows[3] = stored(3, { description: "x".repeat(1 << 20) });
    const { db } = fixture(rows);
    const output = await read(db);
    expect(output).toHaveLength(FEED_EGRESS_LIMIT - 1);
    expect(output.some((row) => row.id === FEED_EGRESS_LIMIT + 1)).toBe(false);
    expect(warn.mock.calls).toEqual([
      [
        "Event egress read reached capacity.",
        { surface: "feed", limit: FEED_EGRESS_LIMIT, returned: FEED_EGRESS_LIMIT },
      ],
      [REFUSAL, { surface: "feed", skipped: 1, code: "stored-text-oversized" }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("xxxx");
  });

  it("bounds RSS and ICS bytes when every row carries maximal text", async () => {
    // `"` escapes widest in XML (&quot;, 6 bytes); oversized siblings add nothing.
    const maximal = (i: number) =>
      stored(
        i,
        Object.fromEntries(
          FIELDS.filter((f) => f !== "eventKey" && f !== "timezone").map((f) => [
            f,
            '"'.repeat(FEED_EGRESS_TEXT_MAX_BYTES[f]),
          ]),
        ),
      );
    const rows = Array.from({ length: FEED_EGRESS_LIMIT }, (_, i) =>
      i % 2 ? maximal(i) : stored(i, { title: "x".repeat(1 << 20) }),
    );
    const { db } = fixture(rows);
    const output = await read(db);
    expect(output).toHaveLength(FEED_EGRESS_LIMIT / 2);
    const textPerRow = FIELDS.reduce((sum, f) => sum + FEED_EGRESS_TEXT_MAX_BYTES[f], 0);
    // Title renders twice in ICS (SUMMARY and the alarm); 6x covers any escape.
    const bound = (empty: number) => empty + FEED_EGRESS_LIMIT * (1024 + 2 * 6 * textPerRow);
    const rss = bytes(eventsRss(output, APP_URL, NOW));
    const ics = bytes(eventsIcsCollection(output, APP_URL));
    expect(rss).toBeLessThanOrEqual(bound(bytes(eventsRss([], APP_URL, NOW))));
    expect(ics).toBeLessThanOrEqual(bound(bytes(eventsIcsCollection([], APP_URL))));
  });
});
