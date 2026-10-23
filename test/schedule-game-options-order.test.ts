import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { listPublishedGames } from "../src/events/reads";

// A JS sort after an unordered LIMIT cannot stabilize which 100 games survive.
// Capture the SQL actually emitted by the real read; do not sort/slice fixtures
// in the proxy (which would silently supply the missing database ORDER BY).
function capture() {
  const queries: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    queries.push({ sql: sql.replace(/\s+/g, " ").trim(), params: [...params] });
    return { rows: [] };
  }) as unknown as Db;
  return { db, queries };
}

function emittedValue(token: string, params: unknown[]) {
  const parameter = /^\$(\d+)$/.exec(token);
  return parameter ? params[Number(parameter[1]) - 1] : token.replace(/^'|'$/g, "");
}

describe("published game options have a deterministic capped SQL read", () => {
  it("orders by the selected trimmed game expression before applying LIMIT", async () => {
    const { db, queries } = capture();
    await listPublishedGames(db);
    expect(queries).toHaveLength(1);
    const { sql } = queries[0]!;
    const selected = /^select distinct (trim\((?:"events"\.)?"game"\))/i.exec(sql);
    expect(selected, sql).not.toBeNull();
    const order = /\border by (.+?)\s+limit\b/i.exec(sql);
    expect(order, `Missing deterministic ORDER BY before LIMIT: ${sql}`).not.toBeNull();
    // Order the same normalized value that DISTINCT selects, not the raw game
    // column (which differs when a stored label has surrounding whitespace).
    expect(order![1]!.replace(/\s+asc$/i, "").toLowerCase()).toBe(selected![1]!.toLowerCase());
  });

  it("CONTROL: keeps one DISTINCT read, published-only, nonblank and capped at 100", async () => {
    const { db, queries } = capture();
    expect(await listPublishedGames(db)).toEqual([]);
    expect(queries).toHaveLength(1);
    const { sql, params } = queries[0]!;
    expect(sql).toMatch(/^select distinct trim\((?:"events"\.)?"game"\).* from "events" where /i);
    const published = /(?:"events"\.)?"status"\s*=\s*(\$\d+|'published')/i.exec(sql);
    expect(published, sql).not.toBeNull();
    expect(emittedValue(published![1]!, params)).toBe("published");
    expect(sql).toMatch(/(?:"events"\.)?"game" is not null/i);
    expect(sql).toMatch(/trim\((?:"events"\.)?"game"\)\s*(?:<>|!=)\s*''/i);
    const limit = /\blimit (\$\d+|\d+)\s*$/i.exec(sql);
    expect(limit, sql).not.toBeNull();
    expect(Number(emittedValue(limit![1]!, params))).toBe(100);
  });
});
