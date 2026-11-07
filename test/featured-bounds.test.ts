import { drizzle } from "drizzle-orm/pg-proxy";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { FEATURED_ROW_CAP, listPublishedFeatured, listVisibleFeatured } from "../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../src/home-cache";

const now = new Date("2030-01-01T00:00:00Z");

function fixture(failVisible = false) {
  const queries: { statement: string; params: unknown[] }[] = [];
  const db = drizzle(async (statement, params) => {
    if (statement.includes("set_config")) return { rows: [] };
    queries.push({ statement, params });
    const base = statement.slice(0, statement.indexOf(" from ")).includes('"starts_at"');
    if (!base && failVisible) throw new Error("private driver detail");
    const rows = Array.from({ length: base ? 101 : 1 }, (_, index) => {
      const row = [index + 1, `News ${index}`, null, "/events", null, null];
      return base ? [...row, null, null] : row;
    });
    return { rows };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (read: (tx: Db) => Promise<unknown>) => read(db) });
  return { db, queries };
}

afterEach(() => {
  vi.restoreAllMocks();
  __resetHomeGuestCacheForTests();
});

describe("featured transfer bounds (local transport)", () => {
  it("pins text admission, ordered cap+1 SQL and request-time parameters in both readers", async () => {
    const { db, queries } = fixture();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await listVisibleFeatured(db, now)).toHaveLength(1);
    const status = { saturated: false };
    expect(await listPublishedFeatured(db, now, status)).toHaveLength(FEATURED_ROW_CAP);
    expect(status.saturated).toBe(true);
    expect(queries).toHaveLength(2);
    for (const { statement } of queries) {
      for (const [column, max] of [
        ["title", 255],
        ["body", 1000],
        ["url", 255],
        ["image_url", 255],
        ["image_alt", 255],
      ] as const) {
        expect(statement).toContain(
          `length(substring("featured_contents"."${column}" from 1 for ${max + 1})) <= ${max}`,
        );
      }
      expect(statement).toContain(
        'order by "featured_contents"."position" asc, "featured_contents"."id" asc limit $',
      );
      expect(statement).toContain('"featured_contents"."is_published" = $1');
    }
    expect(queries[0]!.params).toEqual([true, now.toISOString(), now.toISOString(), 101]);
    expect(queries[1]!.params).toEqual([true, now.toISOString(), 101]);
    expect(queries[1]!.statement).toContain('"featured_contents"."ends_at" > $2');
    expect(warn).toHaveBeenCalledExactlyOnceWith("Featured read reached the row cap.", {
      limit: 100,
      returned: 100,
    });
  });

  it("does not cache a saturated base, including when the fallback read fails", async () => {
    const { db, queries } = fixture(true);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const env = { ADMIN_DB: db } as Env;
    const open = vi.fn(async () => db);
    for (let attempt = 0; attempt < 2; attempt++) {
      expect(await cachedFeatured(env, open, now, undefined, "unsafe request id!")).toEqual([]);
    }
    expect(open).toHaveBeenCalledTimes(2);
    expect(queries).toHaveLength(4);
    const failures = warn.mock.calls.filter(
      ([message]) => message === "Home featured unavailable; serving the fallback.",
    );
    expect(failures).toEqual([
      ["Home featured unavailable; serving the fallback.", { request_id: undefined, exception: "ReadFailure" }],
      ["Home featured unavailable; serving the fallback.", { request_id: undefined, exception: "ReadFailure" }],
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("private driver detail");
  });

  it("preserves the legacy never-throw contract outside the cache fallback", async () => {
    const { db } = fixture(true);
    expect(await listVisibleFeatured(db, now)).toEqual([]);
    await expect(listVisibleFeatured(db, now, true)).rejects.toThrow("private driver detail");
  });
});
