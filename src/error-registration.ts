import type { Hono } from "hono";
import type { Env } from "./env";
import { internalErrorHandler, notFoundHandler } from "./error-responses";
import { withPinnedAssetCache } from "./pinned-assets";
import { isPublicApiPath, publicApiNotFound } from "./public-data/unknown-path";

export function registerErrorHandlers(app: Hono<{ Bindings: Env }>): void {
  app.notFound(async (c) => {
    // The read API answers its own namespace in JSON for every method: no
    // asset lookup, no branded HTML.
    if (isPublicApiPath(c.req.path)) return publicApiNotFound(c);
    // run_worker_first admits every request through TrustHosts before a
    // static lookup. ASSETS.fetch never re-enters the user Worker.
    if (c.env?.ASSETS && (c.req.method === "GET" || c.req.method === "HEAD")) {
      const asset = await c.env.ASSETS.fetch(c.req.raw);
      // ASSETS responses have immutable headers; outer security middleware
      // needs a writable copy. Preserve the streaming body and asset metadata.
      // Pinned fonts pick up the year-long immutable header here (TOG-12550).
      if (asset.status !== 404)
        return withPinnedAssetCache(c.req.url, new Response(asset.body, asset));
    }
    return notFoundHandler(c);
  });
  app.onError((err, c) => internalErrorHandler(err, c));
}
