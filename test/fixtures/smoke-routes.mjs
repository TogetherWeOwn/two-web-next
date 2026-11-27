import { SMOKE_PROBE_KEY } from "../../bin/smoke.mjs";

export const joinAction =
  '<a href="/join/discord" data-testid="join-oneclick">Join with Discord</a>';
export const calendarFixtures = {
  "/events?view=calendar": [
    200,
    "text/html",
    (origin) =>
      `<link rel="canonical" href="${origin}/events"><section data-island="events-calendar">${["head", "subscribe", "actions", "miss", "content"].map((zone) => `<div data-cal-zone="${zone}"></div>`).join("")}</section>`,
  ],
};

// Independent local responses matching the route contracts, not a live Worker/DB.
// The /up fixture carries the candidate revision the version-override tests
// pin (22345678-...): non-overridden probes ignore it, while overridden
// probes require revision.version_id to equal the override UUID.
export const smokeFixtures = {
  "/up": [
    200,
    "application/json",
    '{"status":"healthy","db":"ok","pending_migrations":0,"queue":{"status":"unknown","warn_at":20,"critical_at":100},"revision":{"version_id":"22345678-1234-1234-1234-123456789abc","commit":null}}',
  ],
  "/": [200, "text/html", "<h1>The lobby is open.</h1>"],
  "/about": [200, "text/html", "<h1>About Together We Own</h1>"],
  "/faq": [200, "text/html", "<h1>Frequently asked questions</h1>"],
  "/rules": [200, "text/html", '<h1 id="rules-heading">House rules</h1>'],
  "/privacy": [200, "text/html", "<h1>Privacy policy</h1>"],
  "/events": [200, "text/html", '<h1 id="events-heading">Events</h1>'],
  "/events/past": [200, "text/html", '<h1 id="past-events-heading">Past events</h1>'],
  "/join": [
    200,
    "text/html",
    '<h1 id="join-heading">Join Together We Own</h1><p>One click with Discord</p>',
  ],
  "/events.rss": [200, "application/rss+xml", '<rss version="2.0"><channel></channel></rss>'],
  "/events.ics": [200, "text/calendar", "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"],
  "/sitemap_index.xml": [
    200,
    "application/xml",
    (origin) =>
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${origin}/</loc></url></urlset>`,
  ],
  "/robots.txt": [
    200,
    "text/plain",
    (origin) => `User-agent: *\nDisallow:\nSitemap: ${origin}/sitemap_index.xml\n`,
  ],
  // The HTTP fixture renders security.txt from the producer for its origin.
  // test/smoke.test.mjs checks the smoke expiry pin against that producer.
  "/.well-known/security.txt": [200, "text/plain", null],
  "/discord": [302, null, "", "https://discord.gg/fixture"],
  "/profile": [302, null, "", "/auth/discord"],
  "/admin": [302, null, "", "/auth/discord"],
  // Session-free public read API: collection envelope, one missing event
  // (404 not_found, mirroring the real handler), community snapshot, join
  // handoff, and discovery document. Bodies mirror the acceptance healthy
  // fixtures; the probe asserts each envelope shape and the OpenAPI marker,
  // not fixture contents.
  "/api/public/events": [
    200,
    "application/json",
    '{"data":[],"page":1,"limit":20,"meta":{"current_page":1,"per_page":20,"total":0,"last_page":1}}',
  ],
  // The fixed probe key exists in no database, so like the real handler
  // (src/public-data/routes.ts) the stub answers 404 not_found.
  [`/api/public/events/${SMOKE_PROBE_KEY}`]: [
    404,
    "application/json",
    '{"error":{"code":"not_found","message":"No published event with that key."}}',
  ],
  "/api/public/community": [
    200,
    "application/json",
    '{"member_count":123,"online_count":12,"ranks":[{"key":"veterans","label":"Veterans","member_count":42}]}',
  ],
  "/api/public/join": [
    200,
    "application/json",
    '{"intro":"Approve once with Discord and we will add you to the server.","invite_url":"https://discord.gg/fixture"}',
  ],
  "/openapi.json": [
    200,
    "application/json",
    '{"openapi":"3.1.0","info":{"title":"Together We Own public read API","version":"1.0.0"},"paths":{"/api/public/events":{"get":{"responses":{"200":{"description":"ok"}}}}}}',
  ],
  // Single-event HTML detail (GET /e/:key, src/events/routes-detail.tsx):
  // the fixed probe key exists in no database, so like the real handler's
  // notFound() the stub answers the branded missing-event page.
  [`/e/${SMOKE_PROBE_KEY}`]: [
    404,
    "text/html",
    "<title>We cannot find that page — Together We Own</title>",
  ],
  "/__smoke_unknown_route__": [
    404,
    "text/html",
    "<title>We cannot find that page — Together We Own</title>",
  ],
};
