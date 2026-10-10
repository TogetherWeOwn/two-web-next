import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { adminApp } from "../src/admin/routes";
import { listFeatured } from "../src/admin/store";
import { FEATURED_PAGE_SIZE } from "../src/admin/table-list";
import { featuredContents } from "../src/db/admin-schema";
import { createMemorySessionStore } from "../src/sessions";
import { cookieFor, env, MODERATOR } from "./helpers/member-data";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

function link(html: string, rel: "next" | "prev") {
  return html.match(new RegExp(`rel="${rel}" href="([^"]+)"`))?.[1]?.replaceAll("&amp;", "&");
}

function featuredIds(html: string) {
  return [...html.matchAll(/data-testid="featured-position-(\d+)"/g)].map((m) => Number(m[1]));
}

describe.skipIf(!process.env.DATABASE_URL)(
  "featured pagination (isolated agent-testdb / CI schema)",
  () => {
    let fixture: MemberDataFixture;
    let cookie: string;
    const store = createMemorySessionStore();
    const request = async (path: string) => {
      const response = await adminApp({ sessionStore: store, db: fixture.db }).request(
        path,
        { headers: { cookie } },
        { ...env, ADMIN_DB: fixture.db },
      );
      expect(response.status).toBe(200);
      return response.text();
    };

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterAll(() => fixture?.dispose());
    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      cookie = await cookieFor(store, MODERATOR);
    });

    it("bounds the list read to one page with a next-page affordance", async () => {
      const rows = await fixture.db
        .insert(featuredContents)
        .values(
          Array.from({ length: FEATURED_PAGE_SIZE + 2 }, (_, i) => ({
            title: `Slot ${String(i + 1).padStart(2, "0")}`,
            isPublished: true,
            position: i + 1,
          })),
        )
        .returning();
      const ordered = [...rows].sort((a, b) => a.position - b.position || a.id - b.id);

      // The store fetches one lookahead row so the route needs no count query.
      expect(await listFeatured(fixture.db, {})).toHaveLength(FEATURED_PAGE_SIZE + 1);

      // No page param still renders page 1.
      const first = await request("/featured");
      expect(featuredIds(first)).toEqual(ordered.slice(0, FEATURED_PAGE_SIZE).map((r) => r.id));
      expect(first).toContain("Page 1");
      expect(link(first, "prev")).toBeUndefined();
      const next = new URL(link(first, "next")!, env.APP_URL);
      expect(next.pathname).toBe("/admin/featured");
      expect(next.searchParams.get("page")).toBe("2");

      const second = await request("/featured?page=2");
      expect(featuredIds(second)).toEqual(ordered.slice(FEATURED_PAGE_SIZE).map((r) => r.id));
      expect(second).toContain("Page 2");
      expect(link(second, "next")).toBeUndefined();
      const prev = new URL(link(second, "prev")!, env.APP_URL);
      expect(prev.searchParams.get("page")).toBeNull();
    });

    it.each(["", "0", "-1", "1.5", "bogus"])("invalid page %s renders page 1", async (page) => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: FEATURED_PAGE_SIZE + 1 }, (_, i) => ({
          title: `Slot ${i + 1}`,
          isPublished: true,
          position: i + 1,
        })),
      );
      const html = await request(`/featured?page=${encodeURIComponent(page)}`);
      expect(featuredIds(html)).toHaveLength(FEATURED_PAGE_SIZE);
      expect(html).toContain("Page 1");
      expect(link(html, "next")).toContain("page=2");
    });
  },
);
