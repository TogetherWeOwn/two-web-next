import { test, expect } from "./fixtures";
import { STAGING_APP_URL } from "../src/qa";

// Public GET-only pin for the local CI browser smoke: sitemap, robots, RSS
// and ICS need no session or test-owned fixtures. The local run is unauthenticated
// by default, so no storageState override is required here (unlike the
// staging config, which inherits a member storageState). CI runs e2e/seed.mjs
// first; pin its published event as well as the feed envelopes so a broken
// database read cannot silently pass by returning an empty collection.
// Handler contracts live in src/index.tsx (sitemap/robots) and
// src/events/routes-feeds.ts (feeds). Runs in the existing browser-smoke job
// with no workflow change: playwright.config.ts already picks up every
// e2e/*.spec.ts outside staging/ and watch/.
test("public feeds and SEO endpoints answer unauthenticated GETs", async ({ request }) => {
  const eventKey = "01J00000000000000000000001";
  const eventUrl = `${STAGING_APP_URL}/e/${eventKey}`;
  const sitemap = await request.get("/sitemap_index.xml");
  expect(sitemap.status()).toBe(200);
  expect(sitemap.headers()["content-type"]).toContain("application/xml");
  const sitemapBody = await sitemap.text();
  expect(sitemapBody).toContain('<?xml version="1.0" encoding="UTF-8"?>');
  expect(sitemapBody).toContain("<urlset");
  expect(sitemapBody).toContain("</urlset>");
  // Static entries render with or without a database (a DB outage degrades to
  // the static set, never a 500), so this loc pin holds with zero fixtures.
  // The local worker serves the virtual staging origin (e2e/worker.ts).
  expect(sitemapBody).toContain(`<loc>${STAGING_APP_URL}/join</loc>`);
  expect(sitemapBody).toContain(`<loc>${eventUrl}</loc>`);

  const robots = await request.get("/robots.txt");
  expect(robots.status()).toBe(200);
  expect(robots.headers()["content-type"]).toContain("text/plain");
  const robotsBody = await robots.text();
  expect(robotsBody).toContain("User-agent: *");
  // Each environment advertises its own host (src/seo.ts buildRobots); the
  // local worker maps requests to the virtual staging origin.
  expect(robotsBody).toContain(`Sitemap: ${STAGING_APP_URL}/sitemap_index.xml`);

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
  expect(rssBody).toContain(`<guid isPermaLink="true">${eventUrl}</guid>`);

  const ics = await request.get("/events.ics");
  expect(ics.status()).toBe(200);
  expect(ics.headers()["content-type"]).toBe("text/calendar; charset=utf-8");
  expect(ics.headers()["cache-control"]).toBe("max-age=300, public");
  expect(ics.headers()["set-cookie"] ?? null).toBeNull();
  const icsBody = await ics.text();
  expect(icsBody).toContain("BEGIN:VCALENDAR");
  expect(icsBody).toContain("END:VCALENDAR");
  expect(icsBody).toContain(`\r\nUID:${eventKey}@${new URL(STAGING_APP_URL).host}\r\n`);
});

// Published per-event RSS/ICS coverage lives in the event-rsvp journey while
// that journey's owned fixture is published.
