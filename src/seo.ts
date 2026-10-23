// SEO parity slice (W4): sitemap + per-env robots + crawl-set contract.
//
// Ports two-web routes/web.php's sitemap/robots closures. The crawl set rule
// (TOG-7072): published events only — drafts 403 for guests, cancelled answers
// 410 Gone (TOG-6781), and the past archive is never indexed. Route-level
// 403/410 for /e/{key} land with the events slice (W8); this module pins the
// sitemap side: only published keys are ever emitted, and /events/past is
// never a sitemap entry.

import { PUBLIC_ROUTE_SLOTS } from "./seo-slots";

export type SitemapUrl = {
  loc: string;
  lastmod?: string;
  changefreq: string;
  priority: string;
};

// The event fields the sitemap needs. W8 fills these from the published-events
// query (same scope as the legacy sitemap: status = published, ordered by
// starts_at); the status filter below is the contract, not the query. The
// union mirrors every events.status value so an archived "past" row is
// rejected here too, not only by the query.
export type SitemapEventCandidate = {
  key: string;
  status: "published" | "draft" | "cancelled" | "past";
  updatedAt: string | null;
};

export type SitemapEvent = {
  key: string;
  updatedAt: string | null;
};

// Only published events are crawlable. Drafts (403 for guests), cancelled
// (410 Gone) and archived past-status events must never appear in the index.
export function crawlableEvents(candidates: SitemapEventCandidate[]): SitemapEvent[] {
  return candidates
    .filter((e) => e.status === "published")
    .map((e) => ({ key: e.key, updatedAt: e.updatedAt }));
}

export const stripTrailingSlash = (url: string) => url.replace(/\/+$/, "");

// Canonical builder for the funnel + profile page components (home, join,
// member profile): APP_URL is an unconstrained string binding, so a trailing
// slash must never leak a double-slash canonical (TOG-10118 review: such
// canonicals 404). Events shells build their own canonicals in W8.
export const canonicalUrl = (appUrl: string, path: string): string =>
  `${stripTrailingSlash(appUrl)}${path}`;

// State-derived discovery titles are shared by Hono and Kit. Keep them with
// canonicalUrl, which both Kit pages already import, to avoid an extra client
// chunk. Callers add the site suffix and renderers escape the text.
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** Query text kept in a title, in code points, before the ellipsis. */
export const TITLE_QUERY_LIMIT = 40;

/** Trimmed query capped at TITLE_QUERY_LIMIT code points; "" when blank.
 * Mirrors matchQuery (src/events/search-log.ts): the calendar keeps raw q in
 * state while searching uses the NUL-stripped, newline-normalized form, so the
 * title must apply the same normalization or a NUL-only query titles as a
 * search while the page renders the month grid. */
function titleQuery(q: string | undefined | null): string {
  const cleaned = (q ?? "")
    .replace(/\u0000/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .trim();
  const points = Array.from(cleaned);
  if (points.length <= TITLE_QUERY_LIMIT) return points.join("");
  return `${points.slice(0, TITLE_QUERY_LIMIT).join("")}…`;
}

/** "June 2030" for a "YYYY-MM" wall month; null when it is not one. */
function monthLabel(month: string | undefined | null): string | null {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month ?? "");
  return match ? `${MONTH_NAMES[Number(match[2]) - 1]} ${match[1]}` : null;
}

/** Upcoming schedule: search beats month; the plain list keeps "Events". */
export function eventsTitle(state: { view: string; month: string; q?: string | null }): string {
  const q = titleQuery(state.q);
  if (q) return `Events matching “${q}”`;
  const label = state.view === "calendar" ? monthLabel(state.month) : null;
  return label ? `Events — ${label}` : "Events";
}

export const EVENTS_SEARCH_TOO_LONG_TITLE = "Events — search too long";

/** Past archive: search beats page; the first page keeps "Past events". */
export function pastEventsTitle(page: number, q?: string | null): string {
  const query = titleQuery(q);
  if (query) return `Past events matching “${query}”`;
  return page > 1 ? `Past events — page ${page}` : "Past events";
}

/** Hot zones index: "all" keeps "Hot zones"; a season names itself. */
export function hotzonesTitle(season: string): string {
  return season === "all" ? "Hot zones" : `Hot zones — ${season}`;
}

/** Hot-zone signal page: "all" keeps "<signal> hot zone"; a season names itself. */
export function hotzoneSignalTitle(signal: string, season: string): string {
  const base = `${signal} hot zone`;
  return season === "all" ? base : `${base} — ${season}`;
}

// Brand share image (rich unfurls): one approved static asset reused as the
// og:image on every canonical page — no new artwork, no per-event covers.
// PNG, not the SVG logo: Discord and X crawlers unfurl PNG reliably while
// SVG support is spotty. Shared by the Hono Layout (page-shell.tsx) and the
// Kit heads (SiteMetadata.svelte, ProfileView.svelte) so both renderers emit
// identical share image tags.
export const SHARE_IMAGE_PATH = "/icons/icon-512.png";

// Absolute share-image URL from the page canonical's origin (og:image must be
// absolute; deriving from the canonical keeps every environment self-
// describing). A relative canonical cannot happen (canonicalUrl always
// prefixes APP_URL); the fallback keeps the tag well-formed anyway.
export function shareImageUrl(canonical: string): string {
  try {
    return new URL(SHARE_IMAGE_PATH, canonical).href;
  } catch {
    return SHARE_IMAGE_PATH;
  }
}

// Static entries come from the public route slots (seo-slots.ts); published
// /e/{key} rows follow at 0.6. A sitemap must never list a URL that 404s, and
// /events/past stays out.
export function buildSitemapUrls(appUrl: string, events: SitemapEvent[]): SitemapUrl[] {
  const base = stripTrailingSlash(appUrl);
  const urls: SitemapUrl[] = Object.entries(PUBLIC_ROUTE_SLOTS).map(([path, slot]) => ({
    loc: `${base}${path}`,
    changefreq: slot.changefreq,
    priority: slot.priority,
  }));
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
