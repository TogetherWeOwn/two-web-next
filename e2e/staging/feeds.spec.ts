import { test, expect, stagingOrigin, emptyStorageState } from "./fixtures";

// Public GET-only smoke: sitemap, robots, RSS and ICS need no session, no QA
// token and no fixtures. Runs explicitly unauthenticated so a stored member
// bearer is never attached to these reads.
test.use({ storageState: emptyStorageState });

// Feed/SEO smoke for the staging Worker. Each endpoint must answer 200 with
// its contract content-type and a well-formed body. Handler contracts live in
// src/index.tsx (sitemap/robots) and src/events/routes.tsx (feeds).
test("staging feeds and SEO endpoints answer public GETs", async ({ request }) => {
  const sitemap = await request.get("/sitemap_index.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const sitemapBody = await sitemap.text();
  expect(sitemapBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(sitemapBody).toContain("<urlset");
  expect(sitemapBody).toContain("</urlset>");

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const robotsBody = await robots.text();
  expect(robotsBody).toContain("User-agent: *");
  // Each environment advertises its own host (src/seo.ts buildRobots).
  expect(robotsBody).toContain(`Sitemap: ${stagingOrigin}/sitemap_index.xml`);

  const rss = await request.get("/events.rss");
  expect(rss.status()).toBe(200);
  expect(rss.headers()["content-type"]).toBe("application/rss+xml; charset=utf-8");
  expect(rss.headers()["cache-control"]).toBe("max-age=300, public");
  expect(rss.headers()["set-cookie"] ?? null).toBeNull();
  const rssBody = await rss.text();
  expect(rssBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(rssBody).toContain("<rss");
  expect(rssBody).toContain("<channel>");
  expect(rssBody).toContain("</rss>");

  const ics = await request.get("/events.ics");
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(ics.headers()["cache-control"]).toBe("max-age=300, public");
  expect(ics.headers()["set-cookie"] ?? null).toBeNull();
  const icsBody = await ics.text();
  expect(icsBody).toContain("BEGIN:VCALENDAR");
  expect(icsBody).toContain("END:VCALENDAR");
});

// Published per-event RSS/ICS coverage lives in event-rsvp.spec.ts while that
// journey's owned fixture is published. Empty collection feeds are valid here.
