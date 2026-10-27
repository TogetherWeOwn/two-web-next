// CONTROLs stay green on the execution base; preview must not broaden guest readers.
// This proves emitted SQL and parameters with pg-proxy, not Postgres execution.
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db";
import { listPublishedFeatured, listVisibleFeatured } from "../src/featured";
import { CHECKED_AT, savedFeatured } from "./helpers/featured-saved-content-cases";
import { renderSavedHono, renderSavedKit } from "./helpers/featured-saved-content-render";

function queryFixture() {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = drizzle(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  });
  const transaction = async <T>(run: (tx: Db) => Promise<T>) => run(db as unknown as Db);
  Object.assign(db, { transaction });
  return { db: db as unknown as Db, calls };
}

describe("saved preview: unchanged guest query and effect controls", () => {
  it("CONTROL-SQL01: visible reader retains publication and start-inclusive/end-exclusive predicates", async () => {
    const { db, calls } = queryFixture();
    expect(await listVisibleFeatured(db, CHECKED_AT)).toEqual([]);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain("set_config('lock_timeout'");
    expect(calls[0]!.params).toEqual(["250ms", "250ms"]);
    const read = calls[1]!;
    expect(read.sql).toContain('"featured_contents"."is_published" = $1');
    expect(read.sql).toContain('"featured_contents"."starts_at" is null');
    expect(read.sql).toContain('"featured_contents"."starts_at" <= $2');
    expect(read.sql).toContain('"featured_contents"."ends_at" is null');
    expect(read.sql).toContain('"featured_contents"."ends_at" > $3');
    expect(read.sql).toContain(
      'order by "featured_contents"."position" asc, "featured_contents"."id" asc',
    );
    expect(read.params).toEqual([true, CHECKED_AT.toISOString(), CHECKED_AT.toISOString()]);
  });

  it("CONTROL-SQL02: cached guest base selects published rows with bounds, never unpublished content", async () => {
    const { db, calls } = queryFixture();
    expect(await listPublishedFeatured(db)).toEqual([]);
    expect(calls).toHaveLength(2);
    const read = calls[1]!;
    expect(read.sql).toContain('where "featured_contents"."is_published" = $1');
    expect(read.sql).toContain('"starts_at", "ends_at" from "featured_contents"');
    expect(read.sql).toContain(
      'order by "featured_contents"."position" asc, "featured_contents"."id" asc',
    );
    expect(read.params).toEqual([true]);
  });

  it("CONTROL-effects: real renderers need no network or database write to inspect an admitted live row", async () => {
    let requests = 0;
    vi.stubGlobal("fetch", () => {
      requests++;
      throw new Error("Unexpected preview network request");
    });
    try {
      const row = savedFeatured();
      const before = structuredClone(row);
      const hono = await renderSavedHono(row);
      const kit = await renderSavedKit(row);
      expect(hono).toContain('data-status="live"');
      expect(kit).toContain('data-status="live"');
      expect(row).toEqual(before);
      expect(requests).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
