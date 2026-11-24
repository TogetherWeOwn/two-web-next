import { Context } from "hono";
import type { Env } from "./env";
import { internalErrorHandler } from "./errors";
import { safeRequestId } from "./http/request-log";
import { KIT_SEO_PATHS } from "./kit-seo-routes";
import { robotsResponse, sitemapResponse } from "./seo-responses";

/**
 * Detached adapter for the literal SEO GET and HEAD endpoints. The caller
 * owns ingress (including trusted host), alias fallback and global response
 * headers. The shared sitemap handler owns events-read admission.
 */
export async function fetchKitSeo(
  request: Request,
  env: Env,
  requestId?: string,
): Promise<Response | null> {
  if (request.method !== "GET" && request.method !== "HEAD") return null;
  const { pathname } = new URL(request.url);
  if (pathname !== KIT_SEO_PATHS.robots && pathname !== KIT_SEO_PATHS.sitemap) return null;

  const c = new Context<{ Bindings: Env }>(request, { env, path: pathname });
  const id = safeRequestId(requestId);
  if (id !== undefined) c.set("requestId", id);
  let response: Response;
  try {
    response = pathname === KIT_SEO_PATHS.robots ? robotsResponse(c) : await sitemapResponse(c);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    response = await internalErrorHandler(error, c, pathname);
  }
  return request.method === "HEAD" ? new Response(null, response) : response;
}
