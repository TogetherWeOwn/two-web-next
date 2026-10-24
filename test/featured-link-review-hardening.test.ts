// Review hardening for deceptive featured links (builder-owned; the
// acceptance files stay untouched). Pins two gaps Paperclip Review found:
// noncanonical scheme slashes smuggling userinfo past the raw "://" check,
// and the stored protocol-relative exclusion in the shared read mapper.
import { drizzle } from "drizzle-orm/pg-proxy";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { resolveKitFeaturedEdit } from "../src/admin/kit-featured-edit";
import { FeaturedFormPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
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

// Admin Homepage previews judge their preview copy with the same stored-link
// policy as the public readers: a row stored before the policy keeps its
// title and body but loses its anchor in both previews, while form values
// stay raw so the moderator can correct the link.
const PREVIEW_NOW = new Date("2026-09-30T20:00:00Z");
const PREVIEW_APP_URL = "https://next.example.test";

function previewRow(url: string | null): FeaturedRow {
  const before = new Date(PREVIEW_NOW.getTime() - 1);
  return {
    id: 1,
    legacyId: null,
    title: "Stored evening",
    body: "Stored body",
    url,
    imageUrl: null,
    imageAlt: null,
    isPublished: true,
    position: 0,
    startsAt: before,
    endsAt: new Date(PREVIEW_NOW.getTime() + 1),
    createdBy: "moderator",
    createdAt: before,
    updatedAt: before,
  };
}

function previewArticle(url: string | null): string {
  const html = String(
    jsx(FeaturedFormPage, {
      mode: "edit",
      row: previewRow(url),
      values: {},
      errors: {},
      now: PREVIEW_NOW,
      appUrl: PREVIEW_APP_URL,
    }),
  );
  const articles = html.match(/<article\b[\s\S]*?<\/article>/g);
  expect(articles, "live slot keeps its preview article").toHaveLength(1);
  return articles![0]!;
}

async function kitPreview(url: string | null) {
  const outcome = await resolveKitFeaturedEdit("7", {
    db: {} as never,
    get: async () => ({ ...previewRow(url), id: 7, startsAtText: null, endsAtText: null }),
    now: PREVIEW_NOW,
  });
  if (outcome.kind !== "ok") throw new Error("expected ok");
  return outcome.view;
}

const UNSAFE_STORED = [
  "https://trusted.example@evil.example/",
  "//evil.example/x",
  "/\\evil.example",
];
const SAFE_STORED = ["/events", "https://example.test/games"];

describe("featured link review hardening: Hono Homepage preview judges stored links", () => {
  it.each(UNSAFE_STORED)("renders stored %s with title and body but no anchor", (raw) => {
    const article = previewArticle(raw);
    expect(article).toContain("Stored evening");
    expect(article).toContain("Stored body");
    expect(article).not.toContain("<a ");
    expect(article).not.toContain("evil.example");
  });

  it.each(SAFE_STORED)("keeps the anchor for stored %s", (raw) => {
    expect(previewArticle(raw)).toContain(`<a href="${raw}">Stored evening</a>`);
  });
});

describe("featured link review hardening: Kit edit preview judges stored links", () => {
  it.each(UNSAFE_STORED)(
    "nulls previewUrl for stored %s but keeps the raw form value",
    async (raw) => {
      const view = await kitPreview(raw);
      expect(view.previewUrl).toBeNull();
      expect(view.values.url).toBe(raw);
    },
  );

  it.each(SAFE_STORED)("keeps previewUrl for stored %s", async (raw) => {
    const view = await kitPreview(raw);
    expect(view.previewUrl).toBe(raw);
    expect(view.values.url).toBe(raw);
  });
});
