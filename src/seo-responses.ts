import { dbFor } from "./admin/db";
import type { Env } from "./env";
import { sitemapEvents } from "./events/reads";
import { type Ctx, publicReadGuard } from "./events/routes-shared";
import { buildRobots, buildSitemapUrls, crawlableEvents, renderSitemap } from "./seo";

const SEO_CACHE = "public, max-age=3600";

async function readSitemapEvents(c: { env: Env }) {
  let db;
  try {
    db = await dbFor(c);
  } catch {
    console.warn("Sitemap events read.", { outcome: "acquire_failed", exception: "ReadFailure" });
    return [];
  }
  if (!db) {
    console.info("Sitemap events read.", { outcome: "no_binding" });
    return [];
  }
  try {
    const rows = await sitemapEvents(db);
    console.info("Sitemap events read.", { outcome: "ok", returned: rows.length });
    return rows;
  } catch {
    console.warn("Sitemap events read.", { outcome: "query_failed", exception: "ReadFailure" });
    return [];
  }
}

export async function sitemapResponse(c: Ctx): Promise<Response> {
  const limited = await publicReadGuard(c);
  if (limited) return limited;
  c.header("content-type", "application/xml; charset=UTF-8");
  c.header("cache-control", SEO_CACHE);
  // The published-only read degrades to static entries on database failure.
  const rows = await readSitemapEvents(c);
  return c.body(renderSitemap(buildSitemapUrls(c.env.APP_URL, crawlableEvents(rows))));
}

export function robotsResponse(c: Ctx): Response {
  c.header("content-type", "text/plain; charset=UTF-8");
  c.header("cache-control", SEO_CACHE);
  return c.body(buildRobots(c.env.APP_URL));
}
