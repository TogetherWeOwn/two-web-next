import { once } from "node:events";
import { createServer } from "node:http";
import { build } from "esbuild";
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

// Producer-derived security.txt body: buildSecurityTxt bundled once from
// src/security-txt.ts, so the passing fixture is the exact producer output for the loopback
// origin and cannot drift from it. The loopback stub has no TLS, so like the
// real Worker on an http origin the body carries no Canonical line; the https
// Canonical path is covered by the securityTxtAssertions unit tests.
let securityTxtBuilderPromise = null;
function securityTxtBuilder() {
  securityTxtBuilderPromise ??= build({
    entryPoints: ["src/security-txt.ts"],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
  }).then(
    async (bundle) =>
      (
        await import(
          `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString("base64")}`
        )
      ).buildSecurityTxt,
  );
  return securityTxtBuilderPromise;
}

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
  // RFC 9116 publication (S8): the body is rendered per request from the real
  // producer (see stub below), so the probe's Expires-pin and no-Canonical-on-
  // http assertions exercise a true positive. The pin itself stays hardcoded
  // in bin/smoke.mjs like the queue thresholds in /up above; the drift guard
  // at the bottom of this file pins SMOKE_SECURITY_TXT_EXPIRES to
  // src/security-txt.ts, so a pin change fails here first. Body is unused (the
  // stub renders the producer); status and type still drive the generic loops.
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

export async function startSmokeFixture(t, change = () => {}, extraFixtures = {}) {
  const requests = [];
  const buildSecurityTxt = await securityTxtBuilder();
  const server = createServer((request, response) => {
    requests.push({
      path: request.url,
      method: request.method,
      cookie: request.headers.cookie,
      host: request.headers.host,
      override: request.headers["cloudflare-workers-version-overrides"],
      fetchMetadata: ["mode", "dest", "site"].map((name) => request.headers[`sec-fetch-${name}`]),
    });
    const fixture = extraFixtures[request.url] ?? smokeFixtures[request.url];
    if (!fixture) {
      response.writeHead(500).end("Unexpected request");
      return;
    }
    const [status, type, body, location] = fixture;
    // Origin-aware SEO fixtures (W16b TOG-11942): the stub advertises its own
    // origin the way the Worker advertises APP_URL, so the probe's
    // same-origin robots/sitemap assertions exercise a true positive. The
    // security.txt body is rendered from the real producer for that origin.
    const origin = `http://${request.headers.host}`;
    const resolved =
      request.url === "/.well-known/security.txt"
        ? buildSecurityTxt(origin)
        : typeof body === "function"
          ? body(origin)
          : body;
    const result = {
      status,
      body: resolved,
      headers: {
        "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
        "x-content-type-options": "nosniff",
        "referrer-policy": "strict-origin-when-cross-origin",
        "x-frame-options": "DENY",
        ...(type ? { "content-type": `${type}; charset=UTF-8` } : {}),
        ...(type === "text/html" ? { "x-robots-tag": "noindex, nofollow" } : {}),
        // Cutover identity (TOG-12863): the live /up answers as two-web-next
        // with no-store, so the stub advertises the same pair.
        ...(request.url === "/up"
          ? { "x-two-origin": "two-web-next", "cache-control": "no-store" }
          : {}),
        ...(location ? { location } : {}),
        "set-cookie": "fixture=not-a-session; Path=/",
      },
    };
    change(request.url, result, request.headers);
    response.writeHead(result.status, result.headers);
    if (result.body === null) response.flushHeaders();
    else response.end(result.body);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  return { url: `http://127.0.0.1:${server.address().port}`, requests };
}
