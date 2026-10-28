// Regression: expired published inventory must not consume the
// published-base row cap. 100 expired rows at positions 0..99 plus one live
// row at position 100 previously filled the 100-row probe with expired rows,
// so the cached homepages rendered no featured block even though one live
// item existed. The cached path now excludes already-ended rows before the
// cap; the per-request window still judges every cached row.
//
// Real SQL on a disposable fixture (member-data helper refuses non-test
// URLs before connecting).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { listPublishedFeatured } from "../../src/featured";
import { __resetHomeGuestCacheForTests, cachedFeatured } from "../../src/home-cache";
import { createMemberDataFixture, type MemberDataFixture } from "./member-data-db";

export function registerExpiredFeaturedCapTests() {
  describe("expired published rows do not consume the cap", () => {
    let fixture: MemberDataFixture;
    let warn: ReturnType<typeof vi.spyOn>;

    const NOW = new Date("2026-10-20T12:00:00Z");

    beforeAll(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });

    afterAll(async () => {
      await fixture?.dispose();
    });

    beforeEach(async () => {
      await fixture.reset();
      await fixture.db.delete(featuredContents);
      __resetHomeGuestCacheForTests();
      warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    });

    afterEach(() => {
      vi.restoreAllMocks();
      __resetHomeGuestCacheForTests();
    });

    async function seedExpiredCrowd() {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: 100 }, (_, i) => ({
          title: `Expired slot ${i}`,
          isPublished: true,
          position: i,
          startsAt: new Date(NOW.getTime() - 7200_000),
          endsAt: new Date(NOW.getTime() - 3600_000),
        })),
      );
      const [live] = await fixture.db
        .insert(featuredContents)
        .values({ title: "Live after archive", isPublished: true, position: 100 })
        .returning();
      return live!;
    }

    it("listPublishedFeatured(db, now) excludes ended rows before the cap", async () => {
      const live = await seedExpiredCrowd();
      const base = await listPublishedFeatured(fixture.db, NOW);
      expect(base.map((row) => row.title)).toEqual(["Live after archive"]);
      expect(base[0]!.id).toBe(live.id);
      expect(warn).not.toHaveBeenCalled();
    });

    it("cachedFeatured serves the live row on fill and on cache hit", async () => {
      await seedExpiredCrowd();
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      const openDb = async () => fixture.db;
      const fill = await cachedFeatured(env, openDb, NOW);
      expect(fill.map((row) => row.title)).toEqual(["Live after archive"]);
      // The hit re-applies the live window per request against the cached base.
      const hit = await cachedFeatured(env, openDb, new Date(NOW.getTime() + 1800_000));
      expect(hit.map((row) => row.title)).toEqual(["Live after archive"]);
      expect(warn).not.toHaveBeenCalled();
    });
  });
}
