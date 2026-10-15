// Policy/SEO leaves: `/privacy`, `/sitemap_index.xml`, `/robots.txt`,
// `POST /csp-reports`.
//
// Disjoint from the OAuth/login extraction: no session reads here —
// `/privacy` and `/robots.txt` are fully static, `/sitemap_index.xml`
// degrades to the static entries when the database is down, and the CSP
// sink answers 204 when everything behind it is down. One register function
// behind the same barrel pattern as the event routes and the static leaves;
// `src/index.tsx` only calls it. Registered pre-session so the CSP sink
// keeps its funnel posture (same placement as the Worker entry had it:
// before the session-touching join/auth handlers).
import type { Hono } from "hono";
import type { Env } from "./env";
import { dbFor } from "./admin/db";
import { sitemapEvents } from "./events/reads";
import { cspReportsRoute } from "./csp-reports";
import { Privacy } from "./pages";
import { POLICY_VERSION, renderPolicyMarkdown } from "./privacy";
import { POLICY_MARKDOWN } from "./privacy-content";
import { buildRobots, buildSitemapUrls, crawlableEvents, renderSitemap } from "./seo";

// Pre-rendered once at module load, so the request path performs zero reads
// of any kind (see the `/privacy` comment below).
const PRIVACY_HTML = renderPolicyMarkdown(POLICY_MARKDOWN);

export function registerSeoLeaves(app: Hono<{ Bindings: Env }>): void {
  // Versioned privacy policy (N1: TOG-9893 — ports two-web routes/funnel.php's
  // `/privacy` + PrivacyController). Funnel-style: no session, no cookie, no
  // cache, no database — stays 200 during an app-DB outage. The markdown is
  // bundled at build (src/privacy-content.ts, generated from
  // content/privacy-policy-vN.md) and pre-rendered once at module load, so the
  // request path performs zero reads of any kind. CSP comes from the global
  // secureHeaders middleware in the Worker entry.
  app.get("/privacy", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.html(<Privacy appUrl={c.env.APP_URL} version={POLICY_VERSION} html={PRIVACY_HTML} />);
  });

  // Sitemap (ports two-web routes/web.php's sitemap closure; crawl set per TOG-7072): published
  // events only. No DB binding yet, so the static entries ship now; the W8 events slice adds the
  // published /e/{key} rows (drafts 403 / cancelled 410 stay out of the index).
  // W6 adds /join (changefreq monthly, priority 0.9 — same as legacy).
  app.get("/sitemap_index.xml", async (c) => {
    c.header("content-type", "application/xml; charset=UTF-8");
    c.header("cache-control", "public, max-age=3600");
    // Published events only; a DB outage degrades to the static entries, never a 500.
    const db = await dbFor(c).catch(() => null);
    const rows = db ? await sitemapEvents(db).catch(() => []) : [];
    return c.body(renderSitemap(buildSitemapUrls(c.env.APP_URL, crawlableEvents(rows))));
  });

  // robots.txt is dynamic, not a static file in public/ (TOG-7071): the Sitemap line names this
  // environment's APP_URL host, so each environment advertises itself.
  app.get("/robots.txt", (c) => {
    c.header("content-type", "text/plain; charset=UTF-8");
    c.header("cache-control", "public, max-age=3600");
    return c.body(buildRobots(c.env.APP_URL));
  });

  // CSP violation sink (TOG-10107 — ports two-web routes/funnel.php's
  // `POST /csp-reports`). Funnel posture by placement: registered before any
  // session-touching handler and the handler itself reads no session, no
  // cookie, no cache, no database — it answers 204 during an app-DB outage.
  // Deliberately no throttle: throttle reads the database-backed store, like
  // `/discord`. Flood control lives in the handler instead.
  app.post("/csp-reports", cspReportsRoute);
}
