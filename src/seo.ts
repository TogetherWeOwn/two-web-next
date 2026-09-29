// SEO parity slice (W4): sitemap + per-env robots + crawl-set contract.
//
// Ports two-web routes/web.php's sitemap/robots closures. The crawl set rule
// (TOG-7072): published events only — drafts 403 for guests, cancelled answers
// 410 Gone (TOG-6781), and the past archive is never indexed. Route-level
// 403/410 for /e/{key} land with the events slice (W8); this module pins the
// sitemap side: only published keys are ever emitted, and /events/past is
// never a sitemap entry.

export type SitemapUrl = {
  loc: string;
  lastmod?: string;
  changefreq: string;
  priority: string;
};

// The event fields the sitemap needs. W8 fills these from the published-events
// query (same scope as the legacy sitemap: status = published, ordered by
// starts_at); the status filter below is the contract, not the query.
export type SitemapEventCandidate = {
  key: string;
  status: "published" | "draft" | "cancelled";
  updatedAt: string | null;
};

export type SitemapEvent = {
  key: string;
  updatedAt: string | null;
};

// Only published events are crawlable. Drafts (403 for guests) and cancelled
// (410 Gone) events must never appear in the index.
export function crawlableEvents(candidates: SitemapEventCandidate[]): SitemapEvent[] {
  return candidates
    .filter((e) => e.status === "published")
    .map((e) => ({ key: e.key, updatedAt: e.updatedAt }));
}

const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

// Static entries for the routes live in W4. /join, /events and friends join
// the index in their own slices (see docs/url-freeze.md) — a sitemap must
// never list a URL that 404s.
export function buildSitemapUrls(appUrl: string, events: SitemapEvent[]): SitemapUrl[] {
  const base = stripTrailingSlash(appUrl);
  const urls: SitemapUrl[] = [
    { loc: `${base}/`, changefreq: "weekly", priority: "1.0" },
    { loc: `${base}/join`, changefreq: "monthly", priority: "0.9" },
    { loc: `${base}/about`, changefreq: "monthly", priority: "0.7" },
    { loc: `${base}/faq`, changefreq: "monthly", priority: "0.7" },
    { loc: `${base}/rules`, changefreq: "monthly", priority: "0.7" },
    { loc: `${base}/privacy`, changefreq: "monthly", priority: "0.7" },
  ];
  for (const e of events) {
    urls.push({
      loc: `${base}/e/${e.key}`,
      ...(e.updatedAt ? { lastmod: e.updatedAt } : {}),
      changefreq: "weekly",
      priority: "0.6",
    });
  }
  return urls;
}

const escapeXml = (s: string): string =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");

export function renderSitemap(urls: SitemapUrl[]): string {
  const items = urls
    .map((u) =>
      [
        "    <url>",
        `        <loc>${escapeXml(u.loc)}</loc>`,
        ...(u.lastmod ? [`        <lastmod>${escapeXml(u.lastmod)}</lastmod>`] : []),
        `        <changefreq>${u.changefreq}</changefreq>`,
        `        <priority>${u.priority}</priority>`,
        "    </url>",
      ].join("\n"),
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${items}\n</urlset>\n`;
}

// robots.txt is dynamic, never a static file in public/ (TOG-7071: a hardcoded
// public/robots.txt once shadowed the route on staging because the CDN serves
// static files before the Worker runs). The Sitemap line names this
// environment's APP_URL host so each environment advertises itself.
export function buildRobots(appUrl: string): string {
  return `User-agent: *\nDisallow:\nSitemap: ${stripTrailingSlash(appUrl)}/sitemap_index.xml\n`;
}
