import { decideRoute, productionManifestFor } from "./route-ownership";

// Kit rewrites redirects from handle into data JSON after the hook returns.
// Hono-owned data twins must avoid that response rewrite entirely. The same
// production manifest still decides ownership; normal documents use the adapter.
export function honoOwnedProductionDataRequest(
  request: Request,
  env: { APP_URL?: string; KIT_ROUTE_ARCHIVE?: string; KIT_ROUTE_STATIC?: string },
): boolean {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/__data.json")) return false;
  const manifest = productionManifestFor(env);
  return manifest !== undefined && decideRoute(request, manifest, url) === undefined;
}
