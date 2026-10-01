// TOG-11224: the /events index rejoins the public sitemap at priority 0.8
// (parity matrix §1: home 1.0, join 0.9, events.index 0.8, leaves 0.7,
// published /e/{key} 0.6). The past archive stays out of the crawl set
// (TOG-7072) and per-event rows are unchanged.
import { describe, expect, it } from "vitest";
import { buildSitemapUrls, renderSitemap } from "../src/seo";

const BASE = "https://next.example.test";

describe("sitemap /events index entry (TOG-11224)", () => {
  it.each([BASE, `${BASE}/`])(
    "lists /events exactly once at priority 0.8 for APP_URL %s",
    (appUrl) => {
      const matches = buildSitemapUrls(appUrl, []).filter((u) => u.loc === `${BASE}/events`);
      expect(matches).toHaveLength(1);
      expect(matches[0]).toEqual({ loc: `${BASE}/events`, changefreq: "daily", priority: "0.8" });
    },
  );

  it("orders /events between /join and /about, as in the legacy sitemap", () => {
    const order = buildSitemapUrls(BASE, []).map((u) => u.loc);
    const events = order.indexOf(`${BASE}/events`);
    expect(events).toBeGreaterThan(order.indexOf(`${BASE}/join`));
    expect(events).toBeLessThan(order.indexOf(`${BASE}/about`));
  });

  it("keeps /events/past and other non-indexed event routes out of the XML", () => {
    const xml = renderSitemap(
      buildSitemapUrls(BASE, [{ key: "abc", updatedAt: "2026-09-01T00:00:00Z" }]),
    );
    expect(xml).toContain(`<loc>${BASE}/events</loc>`);
    expect(xml).not.toContain("/events/past");
    expect(xml).not.toContain("/events.json");
    expect(xml).not.toContain("/events.rss");
  });

  it("leaves the other static leaves and per-event rows unchanged", () => {
    const byLoc = new Map(
      buildSitemapUrls(BASE, [{ key: "abc", updatedAt: "2026-09-01T00:00:00Z" }]).map((u) => [
        u.loc,
        u,
      ]),
    );
    expect(byLoc.get(`${BASE}/`)).toMatchObject({ changefreq: "weekly", priority: "1.0" });
    expect(byLoc.get(`${BASE}/join`)).toMatchObject({ changefreq: "monthly", priority: "0.9" });
    for (const leaf of ["/about", "/faq", "/rules", "/privacy"]) {
      expect(byLoc.get(`${BASE}${leaf}`)).toMatchObject({ changefreq: "monthly", priority: "0.7" });
    }
    expect(byLoc.get(`${BASE}/e/abc`)).toEqual({
      loc: `${BASE}/e/abc`,
      lastmod: "2026-09-01T00:00:00Z",
      changefreq: "weekly",
      priority: "0.6",
    });
  });
});
