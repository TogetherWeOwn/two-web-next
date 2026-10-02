// TOG-11986 (parity matrix web-routes row, W8): the public sitemap carries
// /join at 0.9 and one /e/{key} row at 0.6 per published event. Drafts (403),
// cancelled (410) and archived past-status events stay out, the /events/past
// archive is never listed (TOG-7072), and no APP_URL shape leaks a
// double-slash canonical (TOG-10118).
import { describe, expect, it } from "vitest";
import { buildSitemapUrls, crawlableEvents, renderSitemap, type SitemapEventCandidate } from "../src/seo";

const BASE = "https://next.example.test";

const CANDIDATES: SitemapEventCandidate[] = [
  { key: "board-games", status: "published", updatedAt: "2026-09-01T00:00:00.000Z" },
  { key: "secret-draft", status: "draft", updatedAt: "2026-09-02T00:00:00.000Z" },
  { key: "called-off", status: "cancelled", updatedAt: "2026-09-03T00:00:00.000Z" },
  { key: "last-year", status: "past", updatedAt: "2026-09-04T00:00:00.000Z" },
  { key: "movie-night", status: "published", updatedAt: null },
];

const rows = (appUrl = BASE) => buildSitemapUrls(appUrl, crawlableEvents(CANDIDATES));

describe("sitemap /join and /e/{key} rows (TOG-11986)", () => {
  it("lists /join exactly once at priority 0.9", () => {
    const join = rows().filter((u) => u.loc === `${BASE}/join`);
    expect(join).toEqual([{ loc: `${BASE}/join`, changefreq: "monthly", priority: "0.9" }]);
  });

  it("emits one 0.6 row per published key, in query order, lastmod only when known", () => {
    const events = rows().filter((u) => u.loc.startsWith(`${BASE}/e/`));
    expect(events).toEqual([
      { loc: `${BASE}/e/board-games`, lastmod: "2026-09-01T00:00:00.000Z", changefreq: "weekly", priority: "0.6" },
      { loc: `${BASE}/e/movie-night`, changefreq: "weekly", priority: "0.6" },
    ]);
  });

  it("keeps draft, cancelled and past-status keys out of the rendered XML", () => {
    const xml = renderSitemap(rows());
    expect(xml).toContain(`<loc>${BASE}/e/board-games</loc>`);
    expect(xml).toContain(`<loc>${BASE}/e/movie-night</loc>`);
    for (const key of ["secret-draft", "called-off", "last-year"]) {
      expect(xml).not.toContain(key);
    }
    expect(xml).not.toContain("/events/past");
  });

  it("emits no event rows when nothing is published", () => {
    const none = buildSitemapUrls(BASE, crawlableEvents(CANDIDATES.filter((e) => e.status !== "published")));
    expect(none.some((u) => u.loc.includes("/e/"))).toBe(false);
    expect(none.some((u) => u.loc === `${BASE}/join`)).toBe(true);
  });

  it.each([BASE, `${BASE}/`, `${BASE}//`])("never emits a double-slash loc for APP_URL %s", (appUrl) => {
    const locs = rows(appUrl).map((u) => u.loc);
    expect(locs).toContain(`${BASE}/join`);
    expect(locs).toContain(`${BASE}/e/board-games`);
    for (const loc of locs) {
      expect(loc.startsWith(`${BASE}/`)).toBe(true);
      expect(loc.slice("https://".length)).not.toContain("//");
    }
  });
});
