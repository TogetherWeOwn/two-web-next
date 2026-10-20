// Acceptance-owned coverage additions: unchanged relative-board reads pass.
// Dropping either filter from either statement, silently accepting a missing
// viewer, or refusing a supported guard variant must fail these tests.
// Capture the real builder's SQL and bindings; only database results are faked.
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import { rawMemberOwner } from "../src/db/read-classification";
import { parseSeasonParam } from "../src/hotzones/season";
import { loadMemberRanking } from "../src/leaderboards/members";

const VIEWER = "100000000000000415";
const STATEMENTS = [
  { name: "rank lookup", index: 0 },
  { name: "window read", index: 1 },
];
type Query = { sql: string; params: unknown[] };

function capturingDb() {
  const dialect = new PgDialect();
  const queries: Query[] = [];
  const execute = vi.fn(async (statement: SQL) => {
    queries.push(dialect.sqlToQuery(statement));
    // A valid viewer rank ensures the real builder also issues its window read.
    return queries.length === 1
      ? [{ user_id: VIEWER, rank: 17 }]
      : [{ user_id: VIEWER, username: "viewer", count: 3, rank: 17 }];
  });
  return { db: { execute } as unknown as Db, queries, execute };
}

async function captureRelative(season: string, game: string | null) {
  const { db, queries, execute } = capturingDb();
  await loadMemberRanking(db, parseSeasonParam(season)!, game, "relative", VIEWER);
  expect(execute).toHaveBeenCalledTimes(2);
  expect(queries).toHaveLength(2);
  return queries;
}

function expectBinding(query: Query, predicate: RegExp, value: string) {
  const match = predicate.exec(query.sql);
  expect(match, `Missing ${predicate} in ${query.sql}`).not.toBeNull();
  expect(query.params[Number(match![1]) - 1]).toBe(value);
}

describe.each(STATEMENTS)("relative $name filters", ({ index }) => {
  it("keeps both season bounds and their bound values independently of the other statement", async () => {
    const queries = await captureRelative("2026-09", "go");
    expectBinding(
      queries[index]!,
      /events\.starts_at\s*>=\s*\$(\d+)\b/,
      "2026-09-01T00:00:00.000Z",
    );
    expectBinding(queries[index]!, /events\.starts_at\s*<\s*\$(\d+)\b/, "2026-10-01T00:00:00.000Z");
  });

  it("keeps the game predicate and its bound value independently of the other statement", async () => {
    const queries = await captureRelative("2026-09", "go");
    expectBinding(queries[index]!, /lower\(trim\(events\.game\)\)\s*=\s*\$(\d+)\b/, "go");
  });
});

describe("relative viewer contract", () => {
  it("rejects a missing viewer before executing any statement on a non-null database", async () => {
    const { db, execute } = capturingDb();
    await expect(
      loadMemberRanking(db, parseSeasonParam("2026-09")!, "go", "relative"),
    ).rejects.toThrow(new Error("loadMemberRanking: the relative scope needs a viewer id"));
    expect(execute).not.toHaveBeenCalled();
  });

  it("preserves the empty no-database result even without a viewer", async () => {
    await expect(
      loadMemberRanking(null, parseSeasonParam("2026-09")!, "go", "relative"),
    ).resolves.toEqual([]);
  });
});

describe.each([
  { name: "bare", season: "all", game: null },
  { name: "season-only", season: "2026-09", game: null },
  { name: "game-only", season: "all", game: "go" },
  { name: "full-filter", season: "2026-09", game: "go" },
])("relative raw-member guard: $name", ({ season, game }) => {
  it.each(STATEMENTS)("attributes the real $name statement to user_id", async ({ index }) => {
    const queries = await captureRelative(season, game);
    expect(rawMemberOwner(queries[index]!.sql)).toBe("user_id");
  });
});
