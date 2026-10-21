// Review hardening for deceptive featured links (builder-owned; the
// acceptance files stay untouched). Pins two gaps Paperclip Review found:
// noncanonical scheme slashes smuggling userinfo past the raw "://" check,
// and the stored protocol-relative exclusion in the shared read mapper.
import { drizzle } from "drizzle-orm/pg-proxy";
import { describe, expect, it } from "vitest";
import { parseFeaturedForm, ValidationError } from "../src/admin/validation";
import type { Db } from "../src/db/index";
import { listPublishedFeatured, listVisibleFeatured } from "../src/featured";

const base = { title: "Draft evening", body: "Bring a friend", position: "7" };

function errors(url: string): Record<string, string> | null {
  try {
    parseFeaturedForm({ ...base, url });
    return null;
  } catch (error) {
    if (error instanceof ValidationError) return error.fields;
    throw error;
  }
}

// Real Drizzle projection and mapping with a local SQL transport, mirroring
// the acceptance seam: published-base reads select eight columns, visible
// reads select six. The raw stored URL always crosses this seam.
function readerDb(url: string | null): Db {
  const db = drizzle(async (sql) => {
    if (sql.includes("set_config")) return { rows: [] };
    if (sql.includes('from "featured_contents"')) {
      const row = [1, "Stored evening", "Stored body", url, null, null];
      const select = sql.slice(0, sql.indexOf('from "featured_contents"'));
      return { rows: [select.includes('"starts_at"') ? [...row, null, null] : row] };
    }
    return { rows: [] };
  }) as unknown as Db;
  Object.assign(db, { transaction: async (fn: (tx: Db) => Promise<unknown>) => fn(db) });
  return db;
}

describe("featured link review hardening: save refuses noncanonical userinfo", () => {
  it.each([
    "https:///trusted.example@evil.example/",
    "https:trusted.example@evil.example",
    "https:/trusted.example@evil.example",
    "HTTPS:trusted.example@evil.example",
    "https:///user:pass@evil.example/",
    "https:@evil.example",
  ])("refuses %s on url only", (url) => {
    const fields = errors(url);
    expect(fields, "noncanonical userinfo must be refused before storage").not.toBeNull();
    expect(Object.keys(fields!)).toEqual(["url"]);
  });
});

describe("featured link review hardening: readers null unsafe stored links", () => {
  it.each([
    "https:///trusted.example@evil.example/",
    "https:trusted.example@evil.example",
    "https:/trusted.example@evil.example",
    "//evil.example/x",
    "/\\evil.example",
  ])("nulls stored %s in both reader projections", async (raw) => {
    for (const read of [listVisibleFeatured, listPublishedFeatured]) {
      const rows = await read(readerDb(raw));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ title: "Stored evening", body: "Stored body", url: null });
    }
  });

  it("keeps the stored same-site path exception", async () => {
    for (const read of [listVisibleFeatured, listPublishedFeatured]) {
      const rows = await read(readerDb("/events"));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.url).toBe("/events");
    }
  });
});
