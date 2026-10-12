// Exact route ownership for the SvelteKit strangler.
//
// One method-aware, server-controlled decision per request, made in the Kit
// hook before Kit resolve and before any auth/body read: a Hono-owned request
// never reaches resolve(), a Kit-owned request never reaches the Hono app.
// Hono is the default for every path; a native route renders in Kit only when
// its manifest entry is explicitly enabled, so disabling a route rolls back to
// the unchanged in-process Hono handler with no replay and no self-HTTP.
//
// The decision reads the method and path only. Query strings, headers,
// cookies and bodies are never inputs: renderer-override hints smuggled in any
// of those are ignored, and the original Request passes through untouched
// (query preserved, body unread) to whichever renderer owns it.

export type RouteOwner = "kit" | "hono";

export interface OwnedRoute {
  // Uppercase HTTP method, for example "GET". Never list HEAD: it follows the
  // matching GET entry, while every other method stays distinct.
  method: string;
  // Exact path ("/events/past") or :param pattern ("/events/:key").
  path: string;
  // Native rendering stays off until explicitly enabled.
  enabled: boolean;
}

export interface RouteDecision {
  method: string;
  path: string;
}

// The only native route so far renders the archive page; it stays on Hono
// until its enablement is reviewed, so shipping this manifest changes no
// traffic. Add one entry per migrated route, enabled only when its Kit
// handler is ready to own the exact method/path.
const ROUTE_MANIFEST: OwnedRoute[] = [{ method: "GET", path: "/events/past", enabled: false }];

// Paths Kit must never shadow, whatever the manifest claims. The machine API
// prefix plus the operational endpoints the Hono app owns.
const RESERVED_PREFIXES = ["/api/"];
const RESERVED_EXACT = new Set(["/up", "/csp-reports"]);

// Kit data requests carry the page path with this suffix; ownership follows
// the underlying page, with or without CSR.
const DATA_SUFFIX = "/__data.json";

function normalizePath(path: string): string {
  let out = path.endsWith(DATA_SUFFIX) ? path.slice(0, -DATA_SUFFIX.length) : path;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out || "/";
}

function isReserved(path: string): boolean {
  if (RESERVED_EXACT.has(path)) return true;
  // The bare prefix counts too: trailing-slash normalization turns "/api/"
  // into "/api", which must not escape the reservation.
  return RESERVED_PREFIXES.some((prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix));
}

function matchPattern(pattern: string, path: string): boolean {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return false;
  return patternParts.every((part, i) => part.startsWith(":") || part === pathParts[i]);
}

// Exact static entries beat :param patterns; among patterns the one with more
// static segments wins; manifest order breaks remaining ties.
function bestMatch(path: string, manifest: OwnedRoute[]): OwnedRoute | undefined {
  let best: OwnedRoute | undefined;
  let bestStatic = -1;
  let bestExact = false;
  for (const entry of manifest) {
    const pattern = entry.path;
    const exact = !pattern.includes(":");
    if (exact ? pattern !== path : !matchPattern(pattern, path)) continue;
    const statics = exact
      ? Number.MAX_SAFE_INTEGER
      : pattern.split("/").filter((p) => !p.startsWith(":")).length;
    if (bestExact && !exact) continue;
    if (exact && !bestExact) {
      best = entry;
      bestExact = true;
      bestStatic = Number.MAX_SAFE_INTEGER;
      continue;
    }
    if (statics > bestStatic) {
      best = entry;
      bestStatic = statics;
    }
  }
  return best;
}

export function resolveRouteOwner(
  decision: RouteDecision,
  manifest: OwnedRoute[] = ROUTE_MANIFEST,
): RouteOwner {
  const normalized = normalizePath(decision.path);
  if (isReserved(normalized)) return "hono";
  const upper = decision.method.toUpperCase();
  const lookup = upper === "HEAD" ? "GET" : upper;
  const candidates = manifest.filter((entry) => entry.method.toUpperCase() === lookup);
  return bestMatch(normalized, candidates)?.enabled ? "kit" : "hono";
}

// The exact methods Kit claims for a path. Anything else on that path belongs
// to Hono, whose own 405/Allow semantics then govern the response. HEAD is
// claimed wherever GET is, mirroring the dispatch lookup.
export function allowedMethodsFor(path: string, manifest: OwnedRoute[] = ROUTE_MANIFEST): string[] {
  const normalized = normalizePath(path);
  if (isReserved(normalized)) return [];
  const seen = new Set<string>();
  for (const entry of manifest) {
    if (!entry.enabled) continue;
    const exact = !entry.path.includes(":");
    if (!(exact ? entry.path === normalized : matchPattern(entry.path, normalized))) continue;
    const method = entry.method.toUpperCase();
    seen.add(method);
    if (method === "GET") seen.add("HEAD");
  }
  return [...seen].sort();
}

// Hook entry point: pure function of method + path. Reads nothing else, so the
// body is still unread and the URL (query included) is intact for the owner.
export function decideOwner(request: Request, manifest: OwnedRoute[] = ROUTE_MANIFEST): RouteOwner {
  return resolveRouteOwner(
    { method: request.method, path: new URL(request.url).pathname },
    manifest,
  );
}
