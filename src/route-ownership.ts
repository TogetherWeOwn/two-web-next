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
// until its enablement is reviewed. Production (the Hono Worker) sees no
// traffic change; the preview Worker moves /events/past from Kit to Hono by
// design — that is the rollback. Add one entry per migrated route, enabled
// only when its Kit handler is ready to own the exact method/path.
const ROUTE_MANIFEST: OwnedRoute[] = [{ method: "GET", path: "/events/past", enabled: false }];

// Response header set only on the Kit-rendered branch of the hook, so the
// preview parity check and worker e2e can prove which renderer answered.
// Hono responses (honoFetch or the catch-all fallback) never carry it.
export const KIT_RENDERER_HEADER = "x-two-renderer";
export const KIT_RENDERER_VALUE = "kit";

// Paths Kit must never shadow, whatever the manifest claims. The machine API
// prefix plus the operational endpoints the Hono app owns.
const RESERVED_PREFIXES = ["/api/"];
const RESERVED_EXACT = new Set(["/up", "/csp-reports"]);

// Kit data requests carry the page path with this suffix; ownership follows
// the underlying page, with or without CSR.
const DATA_SUFFIX = "/__data.json";

// Kit 3.0.0 routes on decode_pathname (respond.js:299): split on %25 to
// avoid double-decoding, decodeURI each piece. Malformed sequences fail
// closed to Hono, never to Kit.
function decodeKitPath(path: string): string | null {
  try {
    return path.split("%25").map(decodeURI).join("%25");
  } catch {
    return null;
  }
}

function normalizePath(path: string): string | null {
  const withoutData = path.endsWith(DATA_SUFFIX) ? path.slice(0, -DATA_SUFFIX.length) : path;
  const decoded = decodeKitPath(withoutData);
  if (decoded === null) return null;
  // An encoded data suffix (%5F is "_") decodes into the suffix; strip again
  // so /events/past/%5F%5Fdata.json follows its page like the literal form.
  const base = decoded.endsWith(DATA_SUFFIX) ? decoded.slice(0, -DATA_SUFFIX.length) : decoded;
  let out = base;
  while (out.length > 1 && out.endsWith("/")) out = out.slice(0, -1);
  return out || "/";
}

function isReserved(path: string): boolean {
  if (RESERVED_EXACT.has(path)) return true;
  // The bare prefix counts too: trailing-slash normalization turns "/api/"
  // into "/api", which must not escape the reservation.
  return RESERVED_PREFIXES.some(
    (prefix) => path === prefix.slice(0, -1) || path.startsWith(prefix),
  );
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
  if (normalized === null) return "hono";
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
  if (normalized === null) return [];
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

// The Kit catch-all route id that hands the request to the Hono app. Shared
// here so the hook and its tests agree without importing SvelteKit code.
export const HONO_FALLBACK_ROUTE_ID = "/[...path]";

// Minimal structural shape of the SvelteKit hook event the dispatch needs.
// Deliberately framework-free: the root Vitest suite cannot transform
// web/src/hooks.server.ts (web/tsconfig.json extends the SvelteKit-generated
// $app/tsconfig, so the vite:oxc transform fails under coverage), hence this
// helper lives here and the hook test targets it directly.
export interface HookEventLike {
  request: Request;
  url: URL;
  route: { id?: string | null } | null | undefined;
}

export interface HookDispatchDeps {
  appUrl: string;
  isTrustedHost: (appUrl: string, hosts: Array<string | null | undefined>) => boolean;
  decideOwner: (request: Request) => RouteOwner;
  honoFetch: (request: Request) => Promise<Response>;
  resolve: (event: HookEventLike) => Promise<Response>;
  decorateKitResponse?: (response: Response, event: HookEventLike) => void | Promise<void>;
}

function defaultDecorateKitResponse(response: Response): void {
  response.headers.set(KIT_RENDERER_HEADER, KIT_RENDERER_VALUE);
}

// Framework-free core of web/src/hooks.server.ts handle(): exactly one
// renderer runs, decided before resolve and before any auth/body read. A
// resolve() failure propagates and is never replayed through Hono.
export async function dispatchHookRequest(
  event: HookEventLike,
  deps: HookDispatchDeps,
): Promise<Response> {
  if (!deps.isTrustedHost(deps.appUrl, [event.request.headers.get("host"), event.url.host])) {
    return deps.honoFetch(event.request);
  }
  if (deps.decideOwner(event.request) === "hono") {
    return deps.honoFetch(event.request);
  }
  const response = await deps.resolve(event);
  if (event.route?.id === HONO_FALLBACK_ROUTE_ID) return response;
  if (deps.decorateKitResponse) {
    await deps.decorateKitResponse(response, event);
  } else {
    defaultDecorateKitResponse(response);
  }
  return response;
}
