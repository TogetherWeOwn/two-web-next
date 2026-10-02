import { serializeSigned } from "hono/utils/cookie";
import { describe, expect, it } from "vitest";
import rawApp from "../src/index";
import app from "./app";
import { robotsTagFor, SECURITY_HEADERS } from "../src/headers";
import { profilesApp } from "../src/profiles/routes";
import { createMemoryProfileStore } from "../src/profiles/store";
import type { Env } from "../src/env";
import { createMemorySessionStore, hashToken, newSessionToken } from "../src/sessions";

// W15 (TOG-10118): the SEO/sitemap/robots/static-leaf/header acceptance net.
// Ports the legacy two-web Pest files named in the mapping table at the
// bottom: sitemap/robots (TOG-7071/7072), share meta (TOG-5624/6793), the
// about/faq/rules/privacy leaves (TOG-5310/8396/5147/8609/6853), the manifest
// half of WebManifestTest (TOG-7677; icons live in N2), and the response
// headers (TOG-7328/6770/8729 — four static headers + CSP sink presence +
// staging X-Robots-Tag by serving host + pinned HSTS absence; the CSP shape
// itself belongs to TOG-10107).
// Event share tags and /events routes belong to W8; the W8 slice extends
// the sitemap/share tables here.

const APP_URL = "https://next.example.test";
const SESSION_SECRET = "test-session-secret-at-least-32-bytes-long";

const env: Env = {
  APP_URL,
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/configured",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET,
};

const MOD = { userId: "111", username: "mod", moderator: true };
const MEMBER = { userId: "100000000000000001", username: "alice", member: true, moderator: false };

async function cookieFor(
  store: ReturnType<typeof createMemorySessionStore>,
  row: { userId: string; username: string; member?: boolean; moderator?: boolean },
): Promise<string> {
  const token = newSessionToken();
  await store.create({
    tokenHash: await hashToken(token),
    userId: row.userId,
    username: row.username,
    avatar: null,
    member: row.member ?? true,
    moderator: row.moderator ?? false,
    expiresAt: new Date(Date.now() + 3600_000),
  });
  const serialized = await serializeSigned("__Host-two_session", token, SESSION_SECRET, {
    path: "/",
    secure: true,
    httpOnly: true,
    sameSite: "Lax",
  });
  return serialized.split(";")[0]!;
}

describe("sitemap + robots (per-env host)", () => {
  it("lists the static leaves as XML, never gated or machine URLs", async () => {
    const res = await app.request("/sitemap_index.xml", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/xml; charset=UTF-8");
    const xml = await res.text();
    for (const loc of [
      `${APP_URL}/`,
      `${APP_URL}/join`,
      `${APP_URL}/about`,
      `${APP_URL}/faq`,
      `${APP_URL}/rules`,
      `${APP_URL}/privacy`,
    ]) {
      expect(xml).toContain(`<loc>${loc}</loc>`);
    }
    for (const banned of [
      "/events/past",
      "/admin",
      "/profile",
      "/members/",
      "/events.json",
      "/auth/",
    ]) {
      expect(xml).not.toContain(banned);
    }
  });

  it("/robots.txt advertises this environment's own sitemap host as plain text", async () => {
    const res = await app.request("/robots.txt", {}, env);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain; charset=UTF-8");
    expect(await res.text()).toBe(
      `User-agent: *\nDisallow:\nSitemap: ${APP_URL}/sitemap_index.xml\n`,
    );
  });

  it("staging advertises the staging host, never the apex (TOG-7071)", async () => {
    const staging = { ...env, APP_URL: "https://staging.example.test" };
    const robots = await (await app.request("/robots.txt", {}, staging)).text();
    expect(robots).toContain("Sitemap: https://staging.example.test/sitemap_index.xml");
    expect(robots).not.toContain("next.example.test");
  });

  it("no static robots.txt shadows the route (TOG-7071)", async () => {
    const { existsSync } = await import("node:fs");
    const { resolve, dirname } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    expect(existsSync(resolve(root, "public/robots.txt"))).toBe(false);
  });
});

describe("share meta (TOG-5624)", () => {
  const tags = (html: string, canonical: string, title: string, description: string) => {
    for (const needle of [
      `<link rel="canonical" href="${canonical}"`,
      '<meta property="og:type" content="website"',
      '<meta property="og:site_name" content="Together We Own"',
      `<meta property="og:url" content="${canonical}"`,
      `<meta property="og:title" content="${title}"`,
      `<meta property="og:description" content="${description}"`,
      '<meta name="twitter:card" content="summary"',
      `<meta name="twitter:title" content="${title}"`,
      `<meta name="twitter:description" content="${description}"`,
    ]) {
      expect(html, needle).toContain(needle);
    }
  };

  it("tags home with its canonical + OG/Twitter set and no og:image", async () => {
    const html = await (await app.request("/", {}, env)).text();
    tags(
      html,
      `${APP_URL}/`,
      "Together We Own — the lobby is open",
      "We spent most of our life private. Now you can just turn up.",
    );
    expect(html).not.toContain("og:image");
  });

  it("tags the join page with its own canonical (funnel lives on shared links)", async () => {
    const html = await (await app.request("/join", {}, env)).text();
    tags(
      html,
      `${APP_URL}/join`,
      "Join Together We Own",
      "Approve once with Discord and we will add you to the server.",
    );
  });

  it("emits no double-slash canonical when APP_URL carries a trailing slash", async () => {
    // APP_URL is an unconstrained binding; src/seo.ts canonicalUrl strips
    // the slash so the canonical matches the sitemap and resolves 200.
    const slashed = { ...env, APP_URL: `${APP_URL}/` };
    const html = await (await app.request("/join", {}, slashed)).text();
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/join"`);
    expect(html).toContain(`<meta property="og:url" content="${APP_URL}/join"`);
    expect(html).not.toContain("//join");
    const home = await (await app.request("/", {}, slashed)).text();
    expect(home).toContain(`<link rel="canonical" href="${APP_URL}/"`);
    expect(home).not.toContain('href="https://next.example.test//"');
  });

  it("keeps exactly one self-pointing canonical per tagged page", async () => {
    for (const [path, canonical] of [
      ["/", `${APP_URL}/`],
      ["/join", `${APP_URL}/join`],
    ] as const) {
      const html = await (await app.request(path, {}, env)).text();
      expect(html.match(/rel="canonical"/g)).toHaveLength(1);
      expect(html).toContain(`<link rel="canonical" href="${canonical}"`);
    }
  });

  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s has one configured self-canonical and keeps feed autodiscovery",
    async (path) => {
      for (const appUrl of [APP_URL, `${APP_URL}/`]) {
        const res = await app.request(
          `${APP_URL}${path}?utm_source=share`,
          {
            headers: { "x-forwarded-host": "untrusted.example.test" },
          },
          { ...env, APP_URL: appUrl },
        );
        expect(res.status).toBe(200);
        expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
        expect(res.headers.getSetCookie()).toHaveLength(0);
        const html = await res.text();
        expect(html.match(/rel="canonical"/g)).toHaveLength(1);
        expect(html).toContain(`<link rel="canonical" href="${APP_URL}${path}"`);
        expect(html).toContain(`<meta property="og:url" content="${APP_URL}${path}"`);
        expect(html).not.toContain("untrusted.example.test");
        expect(html).not.toContain("utm_source");
        expect(html).toContain('type="application/rss+xml"');
        // Main's TrustHosts guard now refuses an actual foreign URL before routing.
        const refused = await app.request(
          `https://untrusted.example.test${path}`,
          {},
          { ...env, APP_URL: appUrl },
        );
        expect(refused.status).toBe(404);
        expect(await refused.text()).not.toContain('rel="canonical"');
      }
    },
  );
});

describe("static leaves (DB-free floor)", () => {
  it.each(["/about", "/faq", "/rules", "/privacy"])(
    "%s renders 200 with no cookies",
    async (path) => {
      const res = await app.request(path, {}, env);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.getSetCookie()).toHaveLength(0);
    },
  );

  it("/about carries the facts, a join CTA and the footer link set", async () => {
    const html = await (await app.request("/about", {}, env)).text();
    expect(html).toContain("About Together We Own");
    expect(html).toContain('data-testid="about-facts"');
    expect(html).toContain('data-testid="about-join"');
    expect(html).toContain("Voice-first");
    expect(html).toContain("Est. 1998");
  });

  it("the home shell footers the leaf links, and the leaves are in the sitemap", async () => {
    const xml = await (await app.request("/sitemap_index.xml", {}, env)).text();
    for (const leaf of ["about", "faq", "rules", "privacy"]) {
      expect(xml).toContain(`<loc>${APP_URL}/${leaf}</loc>`);
      const html = await (await app.request("/", {}, env)).text();
      expect(html).toContain(`href="/${leaf}"`);
    }
  });

  it("/faq answers the published questions with a join CTA", async () => {
    const html = await (await app.request("/faq", {}, env)).text();
    expect(html).toContain("Frequently asked questions");
    expect(html).toContain('data-testid="faq-list"');
    expect(html).toContain('data-testid="faq-join"');
    expect(html).toContain("What is Together We Own?");
    expect(html).toContain("Sunday Squad, every Sunday at 8pm Eastern");
    expect(html).toContain("How do I open a private support ticket?");
    expect(html).toContain("How do I fill in my profile?");
    expect(html).toContain("How does the game picker work?");
  });

  it("/rules carries the five rules with a machine + human stamp when configured", async () => {
    const html = await (await app.request("/rules", {}, env)).text();
    for (const rule of [
      "18+ only",
      "Respect the room",
      "Voice-first",
      "Play fair",
      "Moderators have the last word",
    ]) {
      expect(html).toContain(rule);
    }
    expect(html).toContain('data-testid="rules-list"');
    expect(html).toContain('data-testid="rules-join"');
    expect(html).not.toContain("rules-last-updated");

    const dated = { ...env, RULES_LAST_UPDATED: "2026-09-01" };
    const stamped = await (await app.request("/rules", {}, dated)).text();
    expect(stamped).toContain('data-testid="rules-last-updated"');
    expect(stamped).toContain("Last updated");
    expect(stamped).toContain("1 September 2026");
    expect(stamped).toContain('datetime="2026-09-01"');
  });

  it("/rules hides the stamp instead of 500ing on invalid or empty dates", async () => {
    for (const RULES_LAST_UPDATED of ["not-a-date", ""]) {
      const res = await app.request("/rules", {}, { ...env, RULES_LAST_UPDATED });
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain("rules-last-updated");
    }
  });

  it("/privacy renders the versioned policy with a join CTA and no scripts", async () => {
    const html = await (await app.request("/privacy", {}, env)).text();
    expect(html).toContain("Privacy policy");
    expect(html).toContain("Version 2");
    expect(html).toContain('data-testid="privacy-policy"');
    expect(html).toContain('data-testid="privacy-join"');
    expect(html).toContain("What we never store, ever");
    expect(html).toContain("we never ask for one");
    expect(html).toContain("Ask anytime to be removed");
    expect(html).not.toContain("<script");
  });

  it("static leaves stay 200 with a throwing session store: no session, cookie or DB read", async () => {
    const throwing = () =>
      new Proxy(
        {},
        {
          get: () => {
            throw new Error("leaves must not touch the session store");
          },
        },
      );
    const e = {
      ...env,
      SESSION_STORE: throwing(),
      DATABASE_URL: "postgres://agent-testdb:5432/unused",
    } as unknown as Env;
    for (const path of ["/discord", "/about", "/faq", "/rules", "/privacy"]) {
      const res = await app.request(path, {}, e);
      expect(res.status, path).toBe(path === "/discord" ? 302 : 200);
      expect(res.headers.getSetCookie()).toHaveLength(0);
    }
  });
});

describe("homepage degraded fallback", () => {
  it("renders 200 with the pitch and the join CTA when the bot DB is down", async () => {
    const res = await app.request("/", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("Together We Own");
    expect(html).toContain("The lobby is open.");
    expect(html).toContain("No application. No interview.");
    expect(html).toContain("Not a crowd. A place that knows your name.");
    expect(html).toContain('data-testid="join"');
    expect(html).not.toContain('data-testid="member-count"');
    expect(html).not.toContain("SQLSTATE");
  });
});

describe("profile share tags (TOG-6793)", () => {
  function profileHarness() {
    const sessions = createMemorySessionStore();
    const store = createMemoryProfileStore([
      {
        id: MEMBER.userId,
        username: "alice",
        avatar: null,
        bio: "Co-op after work.",
        games: [],
        timezone: null,
      },
    ]);
    return {
      sessions,
      app: profilesApp({ sessionStore: sessions, store, accessLog: async () => true }),
    };
  }

  it("tags the shareable member URL with a generic description, never the bio", async () => {
    const { app: profiles, sessions } = profileHarness();
    const cookie = await cookieFor(sessions, { userId: "100000000000000002", username: "bob" });
    const html = await (
      await profiles.request(`/members/${MEMBER.userId}`, { headers: { cookie } }, env)
    ).text();
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/members/${MEMBER.userId}"`);
    expect(html).toContain('<meta property="og:title" content="alice — Member profile"');
    expect(html).toContain(
      '<meta property="og:description" content="A member of Together We Own."',
    );
    expect(html).toContain("Co-op after work.");
    expect(html).not.toContain('<meta property="og:description" content="Co-op after work.');
    expect(html.match(/rel="canonical"/g)).toHaveLength(1);
  });

  it("emits no double-slash member canonical when APP_URL carries a trailing slash", async () => {
    const { app: profiles, sessions } = profileHarness();
    const cookie = await cookieFor(sessions, { userId: "100000000000000002", username: "bob" });
    const slashed = { ...env, APP_URL: `${APP_URL}/` };
    const html = await (
      await profiles.request(`/members/${MEMBER.userId}`, { headers: { cookie } }, slashed)
    ).text();
    expect(html).toContain(`<link rel="canonical" href="${APP_URL}/members/${MEMBER.userId}"`);
    expect(html).not.toContain("//members/");
  });

  it("leaks no share tags to logged-out visitors: the redirect body carries no canonical or tags", async () => {
    const { app: profiles } = profileHarness();
    for (const path of [`/members/${MEMBER.userId}`, "/profile"]) {
      const res = await profiles.request(path, {}, env);
      expect(res.status).toBe(302);
      const body = await res.text();
      expect(body).not.toContain('rel="canonical"');
      expect(body).not.toContain("og:title");
      expect(body).not.toContain("twitter:title");
      expect(body).not.toContain("alice");
    }
  });
});

describe("security headers per route class", () => {
  it("pins the four static values byte-identical to the legacy middleware", () => {
    expect(SECURITY_HEADERS).toEqual({
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Frame-Options": "DENY",
      "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
    });
  });

  it("sets the four headers on every response class: HTML, redirect, JSON, XML, text, 404", async () => {
    for (const path of [
      "/",
      "/about",
      "/join",
      "/discord",
      "/sitemap_index.xml",
      "/robots.txt",
      "/up",
      "/definitely-not-here",
    ]) {
      const res = await app.request(path, {}, env);
      for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
        expect(res.headers.get(header), `${path} ${header}`).toBe(value);
      }
    }
  });

  it("pins X-Frame-Options to DENY, not SAMEORIGIN (nothing frames this site)", async () => {
    expect((await app.request("/", {}, env)).headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("serves a CSP with the report sink on HTML: documents, leaves and error pages", async () => {
    // The CSP shape belongs to the CSP-report slice (TOG-10107): this card
    // pins that a policy with the sink rides every document, not its exact
    // directives, so the two cards cannot fight over one header. Admin HTML
    // needs a DB-backed access log and is pinned by TOG-10107/TOG-10116.
    for (const path of [
      "/",
      "/about",
      "/faq",
      "/rules",
      "/privacy",
      "/join",
      "/definitely-not-here",
    ]) {
      const res = await app.request(path, {}, env);
      expect(res.headers.get("content-type"), path).toContain("text/html");
      const csp = res.headers.get("Content-Security-Policy");
      expect(csp, path).toContain("default-src 'self'");
      expect(csp, path).toContain("report-uri /csp-reports");
      expect(csp, path).toContain("report-to csp-endpoint");
      expect(res.headers.get("reporting-endpoints"), path).toBe('csp-endpoint="/csp-reports"');
    }
  });

  it("tags non-apex HTML with X-Robots-Tag and leaves the apex clean (TOG-8729)", async () => {
    expect(robotsTagFor("https://togetherweown.com")).toBeNull();
    expect(robotsTagFor(APP_URL)).toBe("noindex, nofollow");
    expect((await app.request("/", {}, env)).headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
    // Explicit absolute URL pins apex config + apex serving host; the test
    // helper resolves relative requests to APP_URL, never Hono's localhost.
    const apex = await app.request(
      "https://togetherweown.com/",
      {},
      { ...env, APP_URL: "https://togetherweown.com" },
    );
    expect(apex.headers.get("X-Robots-Tag")).toBeNull();
  });

  it("noindexes foreign-host refusals while trusted apex HTML and preview JSON keep their header policy", async () => {
    // Unit: config-only call keeps the old verdict; a serving host refines it.
    expect(robotsTagFor("https://togetherweown.com", "togetherweown.com")).toBeNull();
    expect(robotsTagFor("https://togetherweown.com", "preview.example.test")).toBe(
      "noindex, nofollow",
    );
    expect(robotsTagFor("not-a-url", "togetherweown.com")).toBe("noindex, nofollow");
    // W16 TrustHosts refuses aliases outside this environment's APP_URL before
    // routing. Use the raw app so these explicit foreign authorities stay intact.
    const apex = { ...env, APP_URL: "https://togetherweown.com" };
    for (const url of [
      "https://preview.example.test/",
      "https://two-web-next.example.workers.dev/",
      "http://localhost/",
    ]) {
      const res = await rawApp.request(url, {}, apex);
      expect(res.status, url).toBe(404);
      expect(res.headers.get("content-type"), url).toContain("text/html");
      expect(res.headers.get("cache-control"), url).toBe("no-store, private");
      expect(res.headers.get("X-Robots-Tag"), url).toBe("noindex, nofollow");
    }
    const prod = await rawApp.request("https://togetherweown.com/", {}, apex);
    expect(prod.status).toBe(200);
    expect(prod.headers.get("X-Robots-Tag")).toBeNull();
    // Trusted preview JSON stays untagged; the same URL with apex config is
    // instead a branded HTML refusal and must carry the noindex header.
    const preview = { ...env, APP_URL: "https://preview.example.test" };
    const json = await app.request("/up", {}, preview);
    expect(json.status).toBe(503); // trusted host, but the fixture has no DB
    expect(json.headers.get("content-type")).toContain("application/json");
    expect(json.headers.get("X-Robots-Tag")).toBeNull();
    const refused = await rawApp.request("https://preview.example.test/up", {}, apex);
    expect(refused.status).toBe(404);
    expect(refused.headers.get("content-type")).toContain("text/html");
    expect(refused.headers.get("X-Robots-Tag")).toBe("noindex, nofollow");
  });

  it("never emits Strict-Transport-Security from the app: the edge owns HSTS (TOG-8729)", async () => {
    // Hono defaults strictTransportSecurity on; src/index.tsx explicitly
    // disables it, so a local dev server can never pin a machine to HTTPS.
    for (const path of ["/", "/about", "/up"]) {
      const res = await app.request(path, {}, env);
      expect(res.headers.get("Strict-Transport-Security"), path).toBeNull();
    }
  });

  it("the mounted admin dispatch carries the global headers even when it fails closed", async () => {
    // Without a DB the access log cannot record, so the mounted admin
    // fail-closes to 503 (HEAD behavior) — but the outer-dispatch headers
    // ride along anyway: the middleware runs before the guard refuses.
    const store = createMemorySessionStore();
    const cookie = await cookieFor(store, MOD);
    const mounted = await app.request(
      "/admin/events/new",
      { headers: { cookie } },
      { ...env, SESSION_STORE: store },
    );
    expect(mounted.status).toBe(503);
    for (const [header, value] of Object.entries(SECURITY_HEADERS)) {
      expect(mounted.headers.get(header), header).toBe(value);
    }
    expect(mounted.headers.get("Content-Security-Policy")).toContain("default-src 'self'");
  });
});

describe("URL freeze + no soft 404s", () => {
  it.each([
    "/",
    "/join",
    "/about",
    "/faq",
    "/rules",
    "/privacy",
    "/sitemap_index.xml",
    "/robots.txt",
  ])("%s answers 200", async (path) => {
    expect((await app.request(path, {}, env)).status).toBe(200);
  });

  it("/discord redirects 302, never 301", async () => {
    const res = await app.request("/discord", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://discord.gg/configured");
  });

  it("unknown paths at every depth answer a real 404, never a soft 200", async () => {
    for (const path of ["/nx-9x7q2-zzz", "/join-us", "/aaa/bbb/ccc-zzz-9182", "/wp-admin"]) {
      expect((await app.request(path, {}, env)).status, path).toBe(404);
    }
    expect((await app.request("/", {}, env)).status).toBe(200);
  });

  it("the branded 404 carries the join CTA and a noindex, never internals", async () => {
    const res = await app.request("/nx-9x7q2-zzz", {}, env);
    const html = await res.text();
    expect(html).toContain("We cannot find that page");
    expect(html).toContain("Back to the homepage");
    expect(html).toContain('name="robots" content="noindex, nofollow"');
  });
});

// Legacy → Vitest mapping (acceptance: each legacy file below is ported or
// explicitly handed to its owning slice; events-gated assertions wait on W8).
//
// | Legacy Pest file (two-web @ e1e939a)                | Ported here        |
// |------------------------------------------------------|--------------------|
// | tests/Feature/SitemapTest.php (static leaves half)   | sitemap describe |
// | tests/Feature/SitemapTest.php (published /e/{key})   | W8 (events slice)|
// | tests/Feature/RobotsTxtTest.php (route + host)       | robots tests     |
// | tests/Feature/RobotsTxtTest.php (no static file pin) | robots tests     |
// | tests/Feature/ShareMetaTagsTest.php (home + join)    | share meta       |
// | tests/Feature/ShareMetaTagsTest.php (events page)    | W8               |
// | tests/Feature/Profile/ProfileShareTagsTest.php       | profile tags     |
// | tests/Feature/DiscordFunnelTest.php (redirect+floor) | URL freeze +     |
// |                                                      | leaves floor     |
// | tests/Feature/AboutPageTest.php                      | static leaves    |
// | tests/Feature/FaqPageTest.php                        | static leaves    |
// | tests/Feature/RulesPageTest.php                      | static leaves    |
// | tests/Feature/PrivacyPageTest.php (page + wiring)    | static leaves    |
// | tests/Feature/NotFoundTest.php                       | URL freeze       |
// | tests/Feature/HomePageTest.php                       | degraded fallback|
// | tests/Feature/LandingPageDegradedTest.php            | degraded fallback|
// | tests/Feature/SecurityHeadersTest.php                | headers per class|
// | tests/Feature/ContentSecurityPolicyTest.php (shape)  | TOG-10107 (sink) |
// | tests/Feature/ContentSecurityPolicyTest.php (static) | headers per class|
// | tests/Unit/SecurityHeadersNginxTest.php              | headers.ts pins* |
// | tests/Unit/WebManifestTest.php                       | N2 (merged)      |
// | tests/Feature/CriticalPathTest.php                   | dropped: Livewire|
// |                                                      | runtime; no equiv|
// | tests/Feature/SessionCookieFlagsTest.php             | TOG-10114 (auth) |
// | tests/Feature/LandingPageCountsTest.php              | data slices (W8) |
// | tests/Feature/HomeUpcomingEventsTest.php             | W8               |
// | tests/Feature/FeaturedContentOnHomePageTest.php      | W8               |
// * The nginx template has no Workers equivalent: the edge (Cloudflare)
// owns HSTS there, so this card explicitly disables Hono's default HSTS
// (strictTransportSecurity: false in src/index.tsx) and pins its absence
// instead of asserting on a file that does not exist.
describe("mapping table", () => {
  it("is documentation, not code", () => {
    expect(true).toBe(true);
  });
});
