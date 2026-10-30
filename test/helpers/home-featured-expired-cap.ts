// Regression: expired published inventory must not consume the
// published-base row cap. 100 expired rows at positions 0..99 plus one live
// row at position 100 previously filled the 100-row probe with expired rows,
// so the cached homepages rendered no featured block even though one live
// item existed. The cached path now excludes already-ended rows before the
// cap; the per-request window still judges every cached row.
//
// Real SQL on a disposable fixture (member-data helper refuses non-test
// URLs before connecting).
import { sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { featuredContents } from "../../src/db/admin-schema";
import type { Env } from "../../src/env";
import { listPublishedFeatured, listVisibleFeatured } from "../../src/featured";
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

    it("keeps a healthy sibling when a stored body is extremely large", async () => {
      await fixture.db.insert(featuredContents).values([
        { title: "Oversized", body: sql`repeat('é', 50000000)`, isPublished: true, position: 0 },
        { title: "Healthy", isPublished: true, position: 1 },
      ]);
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      const direct = await listVisibleFeatured(fixture.db, NOW);
      expect(direct.map((row) => row.title)).toEqual(["Healthy"]);
      const rows = await cachedFeatured(env, async () => fixture.db, NOW);
      expect(rows.map((row) => row.title)).toEqual(["Healthy"]);
    }, 30000);

    it("scheduled rows cannot hide a live row on the cached homepage", async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: 100 }, (_, i) => ({
          title: `Future ${i}`,
          isPublished: true,
          position: i,
          startsAt: new Date(NOW.getTime() + 60000),
        })),
      );
      await fixture.db.insert(featuredContents).values({
        title: "Live after future",
        isPublished: true,
        position: 100,
      });
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      const visible = await cachedFeatured(env, async () => fixture.db, NOW);
      expect(visible.map((row) => row.title)).toEqual(["Live after future"]);
    });

    it("backfills the live row after a saturated window ends", async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: 100 }, (_, i) => ({
          title: `Ending ${i}`,
          isPublished: true,
          position: i,
          endsAt: new Date(NOW.getTime() + 1000),
        })),
      );
      await fixture.db.insert(featuredContents).values({
        title: "Backfilled",
        isPublished: true,
        position: 100,
      });
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      expect(await cachedFeatured(env, async () => fixture.db, NOW)).toHaveLength(100);
      const after = await cachedFeatured(
        env,
        async () => fixture.db,
        new Date(NOW.getTime() + 1000),
      );
      expect(after.map((row) => row.title)).toEqual(["Backfilled"]);
    });

    it("does not let an older saturated fill overwrite a newer snapshot", async () => {
      await fixture.db.insert(featuredContents).values(
        Array.from({ length: 100 }, (_, i) => ({
          title: `Ending ${i}`,
          isPublished: true,
          position: i,
          endsAt: new Date(NOW.getTime() + 1000),
        })),
      );
      await fixture.db.insert(featuredContents).values({
        title: "Backfilled after overlap",
        isPublished: true,
        position: 100,
      });
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const older = cachedFeatured(
        env,
        async () => {
          await gate;
          return fixture.db;
        },
        NOW,
      );
      const later = new Date(NOW.getTime() + 1000);
      expect(
        (await cachedFeatured(env, async () => fixture.db, later)).map((row) => row.title),
      ).toEqual(["Backfilled after overlap"]);
      release();
      expect(await older).toHaveLength(100);
      expect(
        (await cachedFeatured(env, async () => fixture.db, later)).map((row) => row.title),
      ).toEqual(["Backfilled after overlap"]);
    });

    it("does not reuse a newer fill for an earlier concurrent request", async () => {
      await fixture.db.insert(featuredContents).values({
        title: "Earlier live row",
        isPublished: true,
        endsAt: new Date(NOW.getTime() + 1000),
      });
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      const open = async () => fixture.db;
      expect(await cachedFeatured(env, open, new Date(NOW.getTime() + 1000))).toEqual([]);
      expect((await cachedFeatured(env, open, NOW)).map((row) => row.title)).toEqual([
        "Earlier live row",
      ]);
    });

    it("caches a successful empty read but not a missing database", async () => {
      const env = { ADMIN_DB: fixture.db } as unknown as Env;
      const opener = vi.fn(async () => fixture.db);
      expect(await cachedFeatured(env, opener, NOW)).toEqual([]);
      expect(await cachedFeatured(env, opener, NOW)).toEqual([]);
      expect(opener).toHaveBeenCalledTimes(1);
      __resetHomeGuestCacheForTests();
      const unavailable = vi.fn(async () => null);
      expect(await cachedFeatured(env, unavailable, NOW)).toEqual([]);
      expect(await cachedFeatured(env, unavailable, NOW)).toEqual([]);
      expect(unavailable).toHaveBeenCalledTimes(2);
    });

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
