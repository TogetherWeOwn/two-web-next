import { getTableColumns } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import type { Db } from "../src/db/index";
import {
  listCalendarPast,
  listUpcoming,
  listUpcomingForMonth,
  rankUpcoming,
} from "../src/events/reads";

const NOW = new Date("2099-07-15T12:00:00Z");
const KEY = "01G00000000000000000000001";
const STORED_GAMES = ["Chess", " cHeSs ", "CHESS"];

type Query = { sql: string; params: unknown[] };
type Read = (db: Db, game: string | null | undefined) => Promise<unknown>;

// These rows deliberately retain mixed case and padding. The proxy never
// interprets the WHERE or normalizes a stored value/binding: it only records
// the SQL from the real read and supplies rows so later page/rank reads run.
function capture() {
  const rows: (typeof events.$inferSelect)[] = STORED_GAMES.map((game, index) => ({
    id: index + 1,
    eventKey: KEY,
    title: "Board night",
    game,
    description: null,
    accessibilityNotes: null,
    startsAt: new Date("2099-07-15T20:00:00Z"),
    endsAt: new Date("2099-07-15T22:00:00Z"),
    timezone: "UTC",
    location: null,
    organizer_name: null,
    join_url: null,
    join_instructions: null,
    capacity: null,
    status: "published",
    discordEventId: null,
    syncRevision: 1,
    syncedRevision: 0,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen: true,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: NOW,
    updatedAt: NOW,
    icsSequence: 1n,
  }));
  const columns = Object.keys(getTableColumns(events)) as (keyof typeof events.$inferSelect)[];
  const encoded = rows.map((row) =>
    columns.map((column) => {
      const value = row[column];
      return value instanceof Date ? value.toISOString() : value;
    }),
  );
  const queries: Query[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });
    if (sql.includes('from "rsvps"')) return { rows: [] };
    if (/^select count\(/i.test(sql)) return { rows: [[rows.length]] };
    return { rows: encoded };
  }) as unknown as Db;
  return { db, queries };
}

const reads: { name: string; run: Read; statements: number }[] = [
  {
    name: "upcoming count and page",
    run: (db, game) => listUpcoming(db, NOW, { game, search: "board" }),
    statements: 2,
  },
  {
    name: "month grid",
    run: (db, game) => listUpcomingForMonth(db, "2099-07", NOW, { game, search: "board" }),
    statements: 1,
  },
  {
    name: "past drawer",
    run: (db, game) => listCalendarPast(db, NOW, { game, search: "board" }),
    statements: 1,
  },
  {
    name: "day-jump anchor and rank",
    run: (db, game) => rankUpcoming(db, KEY, NOW, { game, search: "board" }),
    statements: 2,
  },
];

function eventStatements(queries: Query[], count: number): Query[] {
  const selected = queries.filter(({ sql }) => sql.includes('from "events"'));
  expect(selected).toHaveLength(count);
  for (const { sql } of selected) {
    // The distinct-options query cannot stand in for a filtering query.
    expect(sql).not.toMatch(/^select distinct\b/i);
    expect(sql).toContain(" where ");
  }
  return selected;
}

function where(sql: string): string {
  return sql.slice(sql.indexOf(" where ") + " where ".length);
}

describe.each(reads)("schedule game SQL: $name", ({ run, statements }) => {
  // Catches lower-removal and trim-removal in the *filter*, independently of
  // listPublishedGames and of the older fake's JS-side normalization.
  it("compares lower(trim(stored game)) by exact equality in every filtering WHERE", async () => {
    const { db, queries } = capture();
    await run(db, "Chess");
    for (const { sql } of eventStatements(queries, statements)) {
      expect(where(sql)).toMatch(/\blower\(trim\("events"\."game"\)\) = \$\d+\b/);
    }
  });

  // Inspect the placeholder belonging to game equality, not the first string
  // parameter: a keyed anchor has its event key first, and search adds strings.
  // This catches removal of toLowerCase even if the SQL functions stay intact.
  it("binds canonical Chess as exactly lowercase chess at the game equality placeholder", async () => {
    const { db, queries } = capture();
    await run(db, "Chess");
    for (const { sql, params } of eventStatements(queries, statements)) {
      const equality = /"events"\."game"\)* = \$(\d+)\b/.exec(where(sql));
      expect(equality, sql).not.toBeNull();
      expect(params[Number(equality![1]) - 1]).toBe("chess");
      expect(params).not.toContain("Chess");
    }
  });

  it.each([null, undefined, ""])("CONTROL: %s leaves the game facet absent", async (game) => {
    const { db, queries } = capture();
    await run(db, game);
    for (const { sql, params } of eventStatements(queries, statements)) {
      // The SELECT projects game even when no facet is applied; only inspect WHERE.
      expect(where(sql)).not.toContain('"game"');
      expect(params).not.toContain("chess");
      expect(params).toContain("%board%");
      expect(where(sql)).toContain('"events"."status" != \'draft\'');
    }
  });
});
