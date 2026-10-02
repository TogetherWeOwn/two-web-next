// W16b (TOG-11942): TOG-9016 rows 3 + 18 parity as one named net.
// Row 3 (sitemap + per-env robots): staging and production diverge
// side-by-side — robots Sitemap host, sitemap loc origin, HTML noindex.
// Row 18 (headers/CSP/TrustHosts/SESSION_DOMAIN): the four static headers
// are byte-identical to legacy AddSecurityHeaders::HEADERS, and every CSP
// delta from legacy AddContentSecurityPolicy is pinned with its reason —
// stricter (free), added (needs a proof), or restored here. TrustHosts and
// host-only cookies are pinned at the slice level; the exhaustive matrices
// stay in test/trust-hosts.test.ts and test/auth-acceptance.test.ts.

import { describe, expect, it } from "vitest";
import app from "./app";
import { Home } from "../src/pages";
import { robotsTagFor, SECURITY_HEADERS } from "../src/headers";
import { buildRobots } from "../src/seo";
import { STAGING_APP_URL } from "../src/qa";
import type { Env } from "../src/env";

const PROD_APP_URL = "https://togetherweown.com";

const base: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const staging: Env = { ...base, APP_URL: STAGING_APP_URL };
const production: Env = { ...base, APP_URL: PROD_APP_URL };

// Legacy two-web AddSecurityHeaders::HEADERS (SHA 5a611b1), verbatim.
const LEGACY_STATIC_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function directives(res: Response): Record<string, string> {
  const csp = res.headers.get("content-security-policy");
  expect(csp).not.toBeNull();
  return Object.fromEntries(csp!.split(";").map((part) => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources.join(" ")];
  }));
}

describe("row 3: robots + sitemap diverge per environment", () => {
  it("staging robots names the staging host; production names the apex", async () => {
    const stagingRobots = await (await app.request("/robots.txt", {}, staging)).text();
    expect(stagingRobots).toBe(`User-agent: *\nDisallow:\nSitemap: ${STAGING_APP_URL}/sitemap_index.xml\n`);
    expect(stagingRobots).not.toContain(PROD_APP_URL);
    const prodRobots = await (await app.request("/robots.txt", {}, production)).text();
    expect(prodRobots).toBe(`User-agent: *\nDisallow:\nSitemap: ${PROD_APP_URL}/sitemap_index.xml\n`);
    // Legacy parity note: legacy routes/web.php also emits allow-shaped
    // `Disallow:` in every env — the staging crawl bar is the noindex header
    // layer below, not the robots body.
    expect(buildRobots(STAGING_APP_URL)).toContain("Disallow:\n");
  });

  it("sitemap locs stay on the serving environment's origin", async () => {
    for (const e of [staging, production]) {
      const xml = await (await app.request("/sitemap_index.xml", {}, e)).text();
      const locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]!.trim());
      expect(locs.length).toBeGreaterThan(0);
      for (const loc of locs) expect(loc.startsWith(`${e.APP_URL}/`)).toBe(true);
      const other = e.APP_URL === STAGING_APP_URL ? PROD_APP_URL : STAGING_APP_URL;
      expect(xml).not.toContain(other);
    }
  });

  it("staging HTML is noindexed; apex HTML served from the apex is clean", () => {
    expect(robotsTagFor(STAGING_APP_URL, "next.togetherweown.com")).toBe("noindex, nofollow");
    expect(robotsTagFor(PROD_APP_URL, "togetherweown.com")).toBeNull();
  });

  it("staging HTML responses carry the tag; apex responses do not", async () => {
    const tagged = await app.request("/", {}, staging);
    expect(tagged.status).toBe(200);
    expect(tagged.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const clean = await app.request("/", {}, production);
    expect(clean.status).toBe(200);
    expect(clean.headers.get("x-robots-tag")).toBeNull();
  });

  it("foreign-host refusals are noindexed even in the apex config", async () => {
    // A preview alias serving an apex-configured build (the workers.dev case
    // robotsTagFor documents): the URL host itself is foreign, so the serving
    // host — not just the config — trips the tag. A spoofed Host header over
    // an apex URL is refused the same way, but its tag reads the URL host,
    // which the edge guarantees equals the real Host in production.
    const res = await app.request("https://evil.example.test/", {}, production);
    expect(res.status).toBe(404);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await res.text()).not.toContain("evil.example.test");
  });
});

describe("row 18: static headers byte-identical to legacy", () => {
  it("SECURITY_HEADERS matches legacy AddSecurityHeaders::HEADERS", () => {
    expect(SECURITY_HEADERS).toEqual(LEGACY_STATIC_HEADERS);
  });

  it("every response class carries the four headers with legacy values", async () => {
    const res = await app.request("/", {}, staging);
    for (const [name, value] of Object.entries(LEGACY_STATIC_HEADERS)) {
      expect(res.headers.get(name)).toBe(value);
    }
  });
});

describe("row 18: CSP deltas from legacy, each pinned with its reason", () => {
  // Legacy baseline (AddContentSecurityPolicy SHA 56b8df8): script-src 'self'
  // 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src
  // 'self' data: https:; font-src 'self' data:; connect-src 'self';
  // frame-ancestors 'none'; base-uri 'self'; object-src 'none';
  // upgrade-insecure-requests on https; NO form-action (reverted TOG-7095).
  // Restored here: base-uri, connect-src, object-src. upgrade-insecure-
  // requests stays edge-owned with HSTS (TOG-8729): it is meaningless over
  // plaintext dev servers, and Hono cannot serialize a valueless directive.

  it("drops unsafe-inline/unsafe-eval: no inline code survives", async () => {
    const csp = directives(await app.request("/", {}, staging));
    expect(csp["script-src"]).toBe("'self'");
    expect(csp["style-src"]).toBe("'self'");
    // Event JSON-LD <script type="application/ld+json"> blocks are data, not
    // code — never executed — and <script src> islands load same-origin, so
    // script-src 'self' stays sound with both. Only a src-less non-JSON-LD
    // script would need unsafe-inline.
    for (const path of ["/", "/events"]) {
      const html = await (await app.request(path, {}, staging)).text();
      expect(html).not.toMatch(/<script(?![^>]*(?:src=|type="application\/ld\+json"))/);
    }
  });

  it("adds form-action 'self': every form posts same-origin, logout still works", async () => {
    const csp = directives(await app.request("/", {}, staging));
    expect(csp["form-action"]).toBe("'self'");
    // TOG-7095 reverted legacy's form-action because it blocked the admin
    // logout; here the logout form posts to same-origin /logout (rendered for
    // signed-in sessions — guests get the sign-in link instead), which the
    // auth-acceptance suite proves still revokes (GET cannot revoke).
    const signedIn = Home({
      session: { id: "fixture", username: "parity", avatar: null, member: true, moderator: false },
      notice: null, inviteUrl: "https://discord.gg/configured", appUrl: STAGING_APP_URL,
      counts: { memberCount: null, onlineCount: null, ranks: [] },
      upcomingEvents: [], eventsUnavailable: false, featured: [],
    })!.toString();
    expect(signedIn).toContain('<form method="post" action="/logout">');
  });

  it("narrows img-src to self + Discord CDN + exact allowlist (no https:/data:)", async () => {
    // No data: URIs or remote http: subresources exist in src/ or public/, so
    // the legacy broad sources have nothing to serve; avatars come from the
    // Discord CDN and moderator URLs pass the exact-host allowlist.
    const csp = directives(await app.request("/about", {}, staging));
    expect(csp["img-src"]).toContain("'self'");
    expect(csp["img-src"]).toContain("https://cdn.discordapp.com");
    const sources = csp["img-src"]!.split(/\s+/);
    expect(sources).not.toContain("https:");
    expect(sources.some((s) => s.startsWith("data:"))).toBe(false);
  });

  it("restores object-src none, base-uri self, connect-src self (legacy parity)", async () => {
    const csp = directives(await app.request("/", {}, staging));
    expect(csp["object-src"]).toBe("'none'");
    expect(csp["base-uri"]).toBe("'self'");
    expect(csp["connect-src"]).toBe("'self'");
  });

  it("keeps frame-ancestors none and the report sink", async () => {
    const csp = directives(await app.request("/", {}, staging));
    expect(csp["frame-ancestors"]).toBe("'none'");
    expect(csp["report-uri"]).toBe("/csp-reports");
    expect(csp["report-to"]).toBe("csp-endpoint");
  });

  it("HSTS stays absent from the app: the edge owns it (TOG-8729)", async () => {
    const res = await app.request("/", {}, staging);
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });
});

describe("row 18: trusted-host slice pins", () => {
  it("unknown hosts are refused with the branded 404, never a redirect or echo", async () => {
    const res = await app.request(`${STAGING_APP_URL}/`, { headers: { host: "evil.example.test" } }, staging);
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
    const body = await res.text();
    expect(body).toContain("We cannot find that page");
    expect(body).not.toContain("evil.example.test");
    expect(res.headers.get("cache-control")).toBe("no-store, private");
  });

  it("staging never accepts the apex host and vice versa", async () => {
    expect((await app.request(`${STAGING_APP_URL}/up`, { headers: { host: "togetherweown.com" } }, staging)).status).toBe(404);
    expect((await app.request(`${PROD_APP_URL}/up`, { headers: { host: "next.togetherweown.com" } }, production)).status).toBe(404);
  });

  it("session cookies stay host-only: __Host- prefix, no Domain", async () => {
    const login = await app.request("/auth/qa/qa-member", {
      method: "POST",
      headers: { origin: STAGING_APP_URL, "X-TWO-QA-Auth": "test-only-qa-token" },
    }, { ...staging, QA_AUTH_TOKEN: "test-only-qa-token" });
    expect(login.status).toBe(204);
    const cookie = login.headers.getSetCookie().find((c) => c.startsWith("__Host-two_session="))!;
    for (const flag of ["Path=/", "Secure", "HttpOnly", "SameSite=Lax"]) expect(cookie).toContain(flag);
    expect(cookie).not.toMatch(/Domain=/i);
  });
});
