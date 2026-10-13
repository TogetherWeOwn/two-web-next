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

import type { AccessSink } from "./access-log";
import { robotsTagFor, securityHeadersFor } from "./headers";
import type { KitLocals } from "./kit-session";
import { type MemberRead, memberReadResponse } from "./member-reads";
import { SAME_ORIGIN_EXEMPTIONS, UNSAFE_METHODS } from "./same-origin";
import { isTrustedHost } from "./trust-hosts";

export type RouteOwner = "kit" | "hono";

// "public" routes render outside the member-read boundary and must not query
// member owners. Anything else (including an absent field) is member data.
export type RouteReads = "public" | MemberRead;

export interface OwnedRoute {
  // Uppercase HTTP method, for example "GET". Never list HEAD: it follows the
  // matching GET entry, while every other method stays distinct.
  method: string;
  // Exact path ("/events/past") or :param pattern ("/events/:key").
  path: string;
  // Native rendering stays off until explicitly enabled.
  enabled: boolean;
  reads?: RouteReads;
}

export interface RouteDecision {
  method: string;
  path: string;
}

// Native routes stay on Hono until their enablement is reviewed. Production
// (the Hono Worker) sees no traffic change; the preview Worker moves a
// Kit-owned path back to Hono by design — that is the rollback. Add one entry
// per migrated route, enabled only when its Kit handler is ready to own the
// exact method/path. Only GET is listed per page (HEAD follows its GET
// entry); /join/discord and /join/callback stay Hono-owned, so the funnel
// keeps one OAuth authority.
// Exported so the preview parity script derives its expected renderer from the
// shipped manifest instead of hard-coding "kit": flipping enabled flips the
// gate for the right reason.
export const ROUTE_MANIFEST: OwnedRoute[] = [
  { method: "GET", path: "/events/past", enabled: false, reads: "public" },
  { method: "GET", path: "/privacy", enabled: false, reads: "public" },
  { method: "GET", path: "/join", enabled: false, reads: "public" },
  // Profile reads: one Svelte view/model behind both Hono handlers.
  // Native rendering stays off until the edit-parity follow-up
  // reviews the enablement; POST/PATCH sibling paths have no entries and
  // stay Hono-owned, and the retired /members directory has none either.
  {
    method: "GET",
    path: "/profile",
    enabled: false,
    reads: { resource: "profile", action: "view", route: "profile" },
  },
  {
    method: "GET",
    path: "/members/:user",
    enabled: false,
    reads: { resource: "profile", action: "view", route: "profiles.show" },
  },
];

// Response header set only on the Kit-rendered branch of the hook, so the
// preview parity check and worker e2e can prove which renderer answered.
// Hono responses (honoFetch or the catch-all fallback) never carry it.
export const KIT_RENDERER_HEADER = "x-two-renderer";
export const KIT_RENDERER_VALUE = "kit";

// Paths Kit must never shadow, whatever the manifest claims. The machine API
// prefix plus the operational endpoints the Hono app owns. /_app/* is the
// adapter-owned immutable asset prefix: it is served by the adapter before
// hooks run (web/wrangler.jsonc run_worker_first still bypasses handle for
// /_app/immutable/*), so reserving it here guarantees that any request that
// DOES reach the hook (dev, future adapter change) falls through to Hono's
// host-guarded ASSETS branch with full headers, never to Kit resolve.
const RESERVED_PREFIXES = ["/api/", "/_app/"];
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

function enabledRouteFor(decision: RouteDecision, manifest: OwnedRoute[]): OwnedRoute | undefined {
  const normalized = normalizePath(decision.path);
  if (normalized === null) return undefined;
  if (isReserved(normalized)) return undefined;
  const upper = decision.method.toUpperCase();
  const lookup = upper === "HEAD" ? "GET" : upper;
  const candidates = manifest.filter((entry) => entry.method.toUpperCase() === lookup);
  const best = bestMatch(normalized, candidates);
  return best?.enabled ? best : undefined;
}

export function resolveRouteOwner(
  decision: RouteDecision,
  manifest: OwnedRoute[] = ROUTE_MANIFEST,
): RouteOwner {
  return enabledRouteFor(decision, manifest) ? "kit" : "hono";
}

// Hook entry point: pure function of method + path. Reads nothing else, so the
// body is still unread and the URL (query included) is intact for the owner.
export function decideRoute(request: Request, manifest: OwnedRoute[] = ROUTE_MANIFEST) {
  return enabledRouteFor({ method: request.method, path: new URL(request.url).pathname }, manifest);
}

export function decideOwner(request: Request, manifest: OwnedRoute[] = ROUTE_MANIFEST): RouteOwner {
  return decideRoute(request, manifest) ? "kit" : "hono";
}

// Kit-side reads: only an authenticated bridge decision names a viewer.
function viewerOf(locals: unknown): string | null {
  const bridged = locals as Partial<KitLocals> | undefined;
  return bridged?.status === "authenticated" ? (bridged.session?.userId ?? null) : null;
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
  // Kit locals the session bridge merges on the Kit branch only. Hono-owned
  // requests never touch this: their session stays Hono's own read. Typed
  // unknown because the core cannot import Kit's App.Locals (web-only,
  // generated) and an index-signature bag would reject that interface; the
  // merge below narrows through one documented cast.
  locals?: unknown;
}

export interface HookDispatchDeps {
  appUrl: string;
  featuredImageHosts?: string;
  honoFetch: (request: Request) => Promise<Response>;
  resolve: (event: HookEventLike) => Promise<Response>;
  // Optional manifest override for tests. The hook never passes this: it
  // always uses the shipped ROUTE_MANIFEST, so there is no swappable owner
  // seam in production wiring to mutate to always-Kit.
  manifest?: OwnedRoute[];
  // Optional read-only session bridge. Runs only after a Kit
  // ownership decision and merges its decision into event.locals before
  // resolve, so Kit loads share one session decision. Absent by default:
  // without it the dispatch behaves exactly as before.
  sessionFor?: (event: HookEventLike) => Promise<KitLocals>;
  // Access-log sink for member-read Kit routes. Absent or null refuses the read.
  accessSink?: () => Promise<AccessSink | null>;
}

// Production Kit decoration, owned by the core so the tested path is the
// production path: the renderer marker (proves Kit answered), the Hono-parity
// security headers, the text/html charset fix and the staging X-Robots-Tag.
// web/src/hooks.server.ts is a pure env binding that supplies appUrl and
// featuredImageHosts; no test needs to import SvelteKit code to pin this.
function decorateKitResponse(
  response: Response,
  event: HookEventLike,
  appUrl: string,
  featuredImageHosts?: string,
): void {
  response.headers.set(KIT_RENDERER_HEADER, KIT_RENDERER_VALUE);
  for (const [name, value] of securityHeadersFor(
    { path: event.url.pathname, method: event.request.method },
    featuredImageHosts,
  )) {
    response.headers.set(name, value);
  }
  const contentType = response.headers.get("content-type") ?? "";
  // Kit sends a bare `text/html`; Hono's c.html() names the charset.
  if (contentType === "text/html") response.headers.set("Content-Type", "text/html; charset=UTF-8");
  if (contentType.includes("text/html")) {
    const tag = robotsTagFor(appUrl, event.url.hostname);
    if (tag) response.headers.set("X-Robots-Tag", tag);
  }
}

// Same-origin parity for the Kit branch (src/same-origin.ts twin, framework-free).
// Exact method + path exemptions only, never prefixes: agent ingress, the CSP
// sink and the MCP endpoint authenticate/validate independently. Mirrors the
// Hono middleware byte-for-byte: unsafe methods only, explicit Origin wins
// (including "null"/malformed), Sec-Fetch-Site same-origin is a fallback only
// when Origin is absent and only when the request origin is APP_URL, invalid
// config fails closed. Reads headers + URL only, never the body.
export function isSameOriginAllowed(request: Request, appUrl: string): boolean {
  const method = request.method.toUpperCase();
  let path: string;
  try {
    path = new URL(request.url).pathname;
  } catch {
    return false;
  }
  if (!UNSAFE_METHODS.some((m) => m === method)) return true;
  if (SAME_ORIGIN_EXEMPTIONS.some(({ method: em, path: ep }) => em === method && ep === path)) {
    return true;
  }
  let expected: string | undefined;
  try {
    const url = new URL(appUrl);
    if (url.protocol === "https:" || url.protocol === "http:") expected = url.origin;
  } catch {
    /* Invalid configuration fails closed, never trusts the request host. */
  }
  if (expected === undefined) return false;
  const origin = request.headers.get("origin") ?? undefined;
  if (origin !== undefined) return origin === expected;
  if (request.headers.get("sec-fetch-site") !== "same-origin") return false;
  try {
    return new URL(request.url).origin === expected;
  } catch {
    return false;
  }
}

// Kit 403 twin of Hono's sameOrigin refusal: identical JSON envelope +
// no-store private, plus the Kit marker and full security headers (Hono's
// refusal leaves hardened because secureHeaders runs outer; Kit must too).
function sameOriginRefusal(
  event: HookEventLike,
  appUrl: string,
  featuredImageHosts?: string,
): Response {
  const response = new Response(JSON.stringify({ error: "cross_origin" }), {
    status: 403,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, private",
    },
  });
  decorateKitResponse(response, event, appUrl, featuredImageHosts);
  return response;
}

// A member-read route renders inside the boundary. The manifest supplies the
// audit label, the bridge supplies the viewer, and a route with no declared
// read class has no declaration, so the boundary refuses it.
function renderMemberRead(
  event: HookEventLike,
  reads: MemberRead | undefined,
  deps: HookDispatchDeps,
): Promise<Response> {
  return memberReadResponse(
    { method: event.request.method, route: event.route?.id ?? "unmatched" },
    () =>
      reads && typeof reads === "object" ? { ...reads, viewer: viewerOf(event.locals) } : undefined,
    async (entry) => {
      const sink = await deps.accessSink?.();
      if (!sink) throw new Error("no access-log sink");
      return sink(entry);
    },
    () => deps.resolve(event),
  );
}

// Framework-free core of web/src/hooks.server.ts handle(): exactly one
// renderer runs, decided before resolve and before any auth/body read. A
// resolve() failure propagates and is never replayed through Hono. The
// catch-all fallback returns undecorated: it is Hono answering through Kit,
// so it must never carry the Kit marker or Kit security headers.
//
// The trust check and the owner decision are imported, not injected: the hook
// passes only env, honoFetch and resolve (plus an optional test manifest), so
// production wiring has no swappable decideOwner seam to mutate to always-Kit.
// The original Request passes through untouched (identity, body unread).
export async function dispatchHookRequest(
  event: HookEventLike,
  deps: HookDispatchDeps,
): Promise<Response> {
  if (!isTrustedHost(deps.appUrl, [event.request.headers.get("host"), event.url.host])) {
    return deps.honoFetch(event.request);
  }
  // Single Request-to-decision path: decideOwner is the production call, so
  // its method/path/query/decode coverage guards the dispatch too. Inlining
  // resolveRouteOwner here once left mutants (hard-coded GET, hard-coded
  // path, path+search) green against 32 dispatch tests.
  const route = decideRoute(event.request, deps.manifest ?? ROUTE_MANIFEST);
  if (!route) {
    return deps.honoFetch(event.request);
  }
  // Kit same-origin gate (Hono sameOrigin parity): unsafe methods need an
  // exact APP_URL Origin (or the Sec-Fetch-Site fallback when Origin is
  // absent), with only the documented machine exemptions. Refused before the
  // session bridge and before resolve, body unread, hardened like Hono.
  if (!isSameOriginAllowed(event.request, deps.appUrl)) {
    return sameOriginRefusal(event, deps.appUrl, deps.featuredImageHosts);
  }
  // Kit branch only: one read-only session decision merged into locals before
  // resolve. A bridge failure must not 500 the render — public Kit pages fail
  // closed to guest-equivalent locals, exactly as if no bridge were wired.
  // It runs outside the member-read boundary: its session read is not member data.
  if (deps.sessionFor) {
    try {
      const bridged = await deps.sessionFor(event);
      const prior = (event.locals as Record<string, unknown> | undefined) ?? {};
      event.locals = { ...prior, ...bridged };
    } catch (err) {
      console.warn("kit session bridge unavailable; rendering without locals.", {
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    }
  }
  const response =
    route.reads === "public"
      ? await deps.resolve(event)
      : await renderMemberRead(event, route.reads, deps);
  if (event.route?.id === HONO_FALLBACK_ROUTE_ID) return response;
  decorateKitResponse(response, event, deps.appUrl, deps.featuredImageHosts);
  return response;
}
