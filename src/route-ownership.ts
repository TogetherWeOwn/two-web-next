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

import { Context } from "hono";
import { deleteCookie } from "hono/cookie";
import type { AccessSink } from "./access-log";
import { isContentLeafPath, robotsTagFor, securityHeadersFor } from "./headers";
import { STAGING_APP_URL } from "./qa";
import { transformContentLeafChunk } from "./kit-content-chunk";
import type { KitLocals } from "./kit-session";
import { type MemberRead, memberReadResponse } from "./member-reads";
import { JOIN_RESULT_COOKIE, deleteOpts } from "./return-journey";
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

// The archive page, events list, hot-zone heatmaps, member board and the
// about/faq leaves render natively; privacy/rules/join/recovery/profile reads
// and admin routes stay on Hono until their enablement is reviewed. Returning
// an enabled entry to `enabled: false` restores Hono ownership as the rollback.
// Production (the Hono Worker) sees no traffic change for a
// disabled path; the preview Worker moves a Kit-owned path back to Hono by
// design — that is the rollback. Add one entry per migrated route, enabled
// only when its Kit handler is ready to own the exact method/path. Only GET
// is listed per page (HEAD follows its GET entry); /join/discord and
// /join/callback stay
// Hono-owned, so the funnel keeps one OAuth authority.
// Exported so the preview parity script derives its expected renderer from the
// shipped manifest instead of hard-coding "kit": flipping enabled flips the
// gate for the right reason.
export const ROUTE_MANIFEST: OwnedRoute[] = [
  { method: "GET", path: "/", enabled: false, reads: "public" },
  { method: "GET", path: "/events/past", enabled: true, reads: "public" },
  { method: "GET", path: "/events", enabled: true, reads: "public" },
  { method: "GET", path: "/about", enabled: true, reads: "public" },
  { method: "GET", path: "/privacy", enabled: false, reads: "public" },
  { method: "GET", path: "/rules", enabled: false, reads: "public" },
  { method: "GET", path: "/faq", enabled: true, reads: "public" },
  { method: "GET", path: "/join", enabled: false, reads: "public" },
  // Moderator dashboard: member data, so the Kit branch renders
  // inside the member-read boundary with this declaration and the bridged
  // viewer. Off until the enablement review: the Hono panel answers meanwhile.
  {
    method: "GET",
    path: "/admin",
    enabled: false,
    reads: { resource: "dashboard", action: "view", route: "admin.dashboard" },
  },
  // Moderator featured list: member data, so the Kit branch renders
  // inside the member-read boundary with this declaration and the bridged
  // viewer. Off until the enablement review: the Hono panel answers meanwhile.
  // The new/edit POST siblings and the guarded /admin/featured-contents
  // legacy redirects stay Hono-owned; the manifest carries GET entries only.
  {
    method: "GET",
    path: "/admin/featured",
    enabled: false,
    reads: { resource: "featured_contents", action: "list", route: "admin.featured.index" },
  },
  // Moderator featured create form: member data, so the Kit branch renders
  // inside the member-read boundary with this declaration and the bridged
  // viewer. Same declaration as the Hono handler (admin.featured.create,
  // src/admin/routes.tsx). Only this GET migrates: POST /admin/featured
  // stays Hono-owned, so the ported form keeps submitting to the unchanged
  // create handler (parseFeaturedForm + createFeatured, 422/303) during
  // mixed mode, and the guarded /admin/featured-contents/create legacy
  // redirect stays Hono-owned. Off until the enablement review.
  {
    method: "GET",
    path: "/admin/featured/new",
    enabled: false,
    reads: { resource: "featured_contents", action: "view", route: "admin.featured.create" },
  },
  // Moderator featured edit form: member data, so the Kit branch renders
  // inside the member-read boundary with this declaration and the bridged
  // viewer. Same declaration as the Hono handler (admin.featured.edit,
  // src/admin/routes.tsx). Only this GET migrates: POST /admin/featured/:id
  // and POST /admin/featured/:id/delete stay Hono-owned, so the edit form,
  // the 422 re-render with preserved values, the 303s and the delete action
  // keep one authority until a later write slice lands, and the guarded
  // /admin/featured-contents/:id/edit legacy redirect stays Hono-owned. Off
  // until the enablement review.
  {
    method: "GET",
    path: "/admin/featured/:id",
    enabled: false,
    reads: { resource: "featured_contents", action: "view", route: "admin.featured.edit" },
  },
  // Read-only activity-log viewer: the same bounded subject/causer filters and
  // newest-first paging as the Hono panel, audited by the member-read boundary
  // with this declaration and the bridged viewer. Off until the enablement
  // review: the Hono viewer answers meanwhile.
  {
    method: "GET",
    path: "/admin/activity-log",
    enabled: false,
    reads: { resource: "activity_log", action: "list", route: "admin.activity-log.index" },
  },
  // Moderator events list: same declaration as the Hono handler
  // (admin.events.index, src/admin/routes.tsx). Only this GET migrates:
  // POST /admin/events, /new and /:key stay Hono-owned, so the create form,
  // edit form and every publish/cancel/RSVP action keep one authority until
  // their own slices land. Off until the enablement review.
  {
    method: "GET",
    path: "/admin/events",
    enabled: false,
    reads: { resource: "events", action: "list", route: "admin.events.index" },
  },
  // Moderator event-create form: same declaration as the Hono handler
  // (admin.events.create, src/admin/routes.tsx). Only this GET migrates:
  // POST /admin/events stays Hono-owned, so draft-first creation, weekly
  // recurrence (max 52), wall-time/timezone validation, body cap, throttle,
  // error aggregation, retained values and the 303 keep one authority until
  // the write slice lands. The guarded /admin/events/create legacy redirect
  // stays Hono-owned; the manifest carries this GET entry only. Off until
  // the enablement review.
  {
    method: "GET",
    path: "/admin/events/new",
    enabled: false,
    reads: { resource: "events", action: "view", route: "admin.events.create" },
  },
  // Moderator event-edit form: same declaration as the Hono handler
  // (admin.events.edit, src/admin/routes.tsx). Only this GET migrates:
  // POST /admin/events/:key, the publish/cancel/RSVP-pause/RSVP-reopen
  // siblings and the guarded /admin/events/:key/edit legacy redirect stay
  // Hono-owned, so wall-time UTC carriers, future recurrence propagation,
  // bounded roster paging and postcommit writeback keep one authority until
  // the write slice lands. Off until the enablement review.
  // The legacy /admin/events/create bookmark pins to Hono with the exact
  // disabled entry below: exact entries beat :param patterns in bestMatch,
  // so without it the :key pattern would capture /create once enabled and
  // Kit would 404 instead of Hono's redirect to /admin/events/new.
  {
    method: "GET",
    path: "/admin/events/create",
    enabled: false,
  },
  {
    method: "GET",
    path: "/admin/events/:key",
    enabled: false,
    reads: { resource: "events", action: "view", route: "admin.events.edit" },
  },
  // Join-attempts audit list: member data, so the Kit branch renders
  // inside the member-read boundary with this declaration and the bridged
  // viewer. Enabled after the enablement review; returning this entry to
  // enabled: false restores Hono ownership as the rollback.
  // Row detail links target the Kit /admin/join-attempts/:id page below.
  {
    method: "GET",
    path: "/admin/join-attempts",
    enabled: true,
    reads: { resource: "join_attempts", action: "list", route: "admin.join-attempts.index" },
  },
  // Join-attempt detail: member data, so the Kit branch renders inside the
  // member-read boundary with this declaration and the bridged viewer. Same
  // declaration as the Hono handler (admin.join-attempts.show,
  // src/admin/routes.tsx): the canonical-ID admission, the shared
  // getJoinAttempt retention-window lookup, and the outcome/source/time/trace
  // fields with safe back navigation. Enabled after the enablement review;
  // returning this entry to enabled: false restores Hono ownership as the
  // rollback.
  {
    method: "GET",
    path: "/admin/join-attempts/:id",
    enabled: true,
    reads: { resource: "join_attempts", action: "view", route: "admin.join-attempts.show" },
  },
  { method: "GET", path: "/auth/recover", enabled: false, reads: "public" },
  // Profile reads: one Svelte view/model behind both Hono handlers. Native
  // rendering stays off until edit parity reviews enablement; write siblings
  // and the retired /members directory have no entries and stay Hono-owned.
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
  // Hot-zone heatmaps: public aggregates with the same reads and cache policy
  // as the Hono handlers (src/hotzones/routes.tsx). Concrete signal paths
  // only, never a :param pattern: unknown segments must fall through to the
  // Hono 404, and each path needs its own executed parity run.
  { method: "GET", path: "/hotzones", enabled: true, reads: "public" },
  { method: "GET", path: "/hotzones/joins", enabled: true, reads: "public" },
  { method: "GET", path: "/hotzones/voice", enabled: true, reads: "public" },
  { method: "GET", path: "/hotzones/games", enabled: true, reads: "public" },
  // Member leaderboard: member data, so the Kit branch renders inside the
  // member-read boundary with this declaration and the bridged viewer. Same
  // gate order, grammar and reads as src/leaderboards/routes.tsx. Enabled
  // after the executed member-board parity journey earned the fresh
  // privacy verdict; returning this entry to enabled: false restores Hono
  // ownership as the rollback.
  {
    method: "GET",
    path: "/leaderboards/members",
    enabled: true,
    reads: { resource: "leaderboard", action: "list", route: "leaderboards.members" },
  },
  // Live event detail: the Kit read model (src/events/kit-detail.ts) mirrors
  // the served GET /e/:key handler — role checks, member-only attendee
  // disclosure, related/neighbor content and safe Event JSON-LD — audited by
  // the member-read boundary with this declaration and the bridged viewer.
  // Off until the RSVP companion passes: Hono answers meanwhile, and JSON/ICS
  // stay Hono-owned with no entries of their own.
  {
    method: "GET",
    path: "/e/:key",
    enabled: false,
    reads: { resource: "member", action: "list", route: "events.page" },
  },
];

// Fixture-only manifest for the executed parity journeys (member board +
// live event detail). The shipped manifest held /leaderboards/members on Hono
// until the fresh privacy verdict, so the Playwright Kit fixture
// (ci/kit-worker-dev.mjs) could otherwise only ever compare Hono against
// Hono; the live detail entry stays disabled until the RSVP companion passes,
// so the same fixture enables it for its executed journey. The fixture sets
// KIT_PARITY_FIXTURE_MEMBER_BOARD=true and/or
// KIT_PARITY_FIXTURE_EVENT_DETAIL=true on its own generated loopback worker;
// this helper honours them only for an http loopback APP_URL, so a deployed
// Kit Worker (preview workers.dev, staging, production) can never enable
// either route through them. Returns undefined when neither flag is set, which
// leaves dispatch on the shipped manifest untouched and unmutated.
export function fixtureManifestFor(env: {
  APP_URL?: string;
  KIT_PARITY_FIXTURE_MEMBER_BOARD?: string;
  KIT_PARITY_FIXTURE_EVENT_DETAIL?: string;
}): OwnedRoute[] | undefined {
  const wantBoard = env.KIT_PARITY_FIXTURE_MEMBER_BOARD === "true";
  const wantDetail = env.KIT_PARITY_FIXTURE_EVENT_DETAIL === "true";
  if (!wantBoard && !wantDetail) return undefined;
  let app: URL;
  try {
    app = new URL(env.APP_URL ?? "");
  } catch {
    return undefined;
  }
  if (app.protocol !== "http:") return undefined;
  // URL keeps the brackets on an IPv6 hostname ("[::1]").
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(app.hostname)) return undefined;
  return ROUTE_MANIFEST.map((entry) => {
    if (wantBoard && entry.method === "GET" && entry.path === "/leaderboards/members")
      return { ...entry, enabled: true };
    if (wantDetail && entry.method === "GET" && entry.path === "/e/:key")
      return { ...entry, enabled: true };
    return entry;
  });
}

// Staging Kit starts with every route on Hono. The reviewed deploy workflow
// may enable only the archive and static page families, while all other routes
// stay Hono-owned even when the shared manifest enables them for preview/local
// parity. The staging hostname or any rollout flag selects this restrictive
// manifest, even with a misconfigured APP_URL. Only the exact staging APP_URL
// can enable a family; absent, malformed and unknown flags keep it disabled.
export function stagingManifestFor(
  env: {
    APP_URL?: string;
    KIT_ROUTE_ARCHIVE?: string;
    KIT_ROUTE_STATIC?: string;
  },
  routes: OwnedRoute[] = ROUTE_MANIFEST,
): OwnedRoute[] | undefined {
  let app: URL | undefined;
  try {
    app = new URL(env.APP_URL ?? "");
  } catch {
    // With rollout flags present an invalid URL must not select the preview manifest.
    app = undefined;
  }
  const hasRolloutFlags = env.KIT_ROUTE_ARCHIVE !== undefined || env.KIT_ROUTE_STATIC !== undefined;
  if (app?.hostname !== new URL(STAGING_APP_URL).hostname && !hasRolloutFlags) return undefined;

  const archiveEnabled = env.APP_URL === STAGING_APP_URL && env.KIT_ROUTE_ARCHIVE === "true";
  // Static pages are the second cumulative rollout stage; they cannot precede
  // the archive family even if a Worker variable is set out of band.
  const staticEnabled = archiveEnabled && env.KIT_ROUTE_STATIC === "true";
  return routes.map((entry) => {
    const familyEnabled =
      (entry.method === "GET" && entry.path === "/events/past" && archiveEnabled) ||
      (entry.method === "GET" &&
        (entry.path === "/about" || entry.path === "/faq") &&
        staticEnabled);
    return { ...entry, enabled: entry.enabled && familyEnabled };
  });
}

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

// SvelteKit resolve options the core forwards for content leaves only.
// Structural on purpose (no Kit import): transformPageChunk receives the
// rendered HTML and returns its replacement. Every other route resolves
// without options, exactly as before, so existing resolve stubs stay valid.
export interface KitResolveOptions {
  transformPageChunk?: (input: { html: string }) => string;
}

export interface HookDispatchDeps {
  appUrl: string;
  // Staging-only rollout controls. The staging APP_URL selects a fail-closed
  // manifest that admits only these reviewed families; unset or malformed
  // values keep every route on Hono. Preview/local parity stays unchanged.
  kitRouteArchive?: string;
  kitRouteStatic?: string;
  featuredImageHosts?: string;
  honoFetch: (request: Request) => Promise<Response>;
  resolve: (event: HookEventLike, opts?: KitResolveOptions) => Promise<Response>;
  // Optional manifest override for tests. Production wiring never passes
  // one: the hook forwards only the loopback parity-fixture flag below and
  // the core alone turns flag + appUrl into the fixture route choice.
  manifest?: OwnedRoute[];
  // Loopback Kit parity fixture flags, forwarded from env by the hook as
  // plain booleans (KIT_PARITY_FIXTURE_MEMBER_BOARD / _EVENT_DETAIL ===
  // "true"). Honoured only through fixtureManifestFor: exact flags plus an
  // http loopback appUrl, so a deployed Worker can never enable either route
  // through them. Absent or false leaves the shipped ROUTE_MANIFEST untouched.
  fixtureMemberBoard?: boolean;
  // Live event-detail fixture flag for the RSVP companion's executed journey:
  // same loopback-only honouring as the board flag above. The shipped detail
  // entry stays disabled; the fixture worker alone enables it.
  fixtureEventDetail?: boolean;
  // Optional read-only session bridge. Runs only after a Kit
  // ownership decision and merges its decision into event.locals before
  // resolve, so Kit loads share one session decision. Absent by default:
  // without it the dispatch behaves exactly as before.
  sessionFor?: (event: HookEventLike) => Promise<KitLocals>;
  // The member-document proof is supplied only after audit release and full-HTML
  // classification below; callers without it retain the moderator admin scope.
  authStatusCookieFor?: (
    event: HookEventLike,
    releasedMemberDocument?: boolean,
  ) => Promise<string | null>;
  // Optional sliding-session renewal for the native Kit event detail. Runs
  // only after the member-read boundary releases a successful GET (see
  // releasedEventDetailRenewsSession): a refused, failed, throttled or
  // redirected read never reaches it, so the bearer stays live for the
  // retry. Absent by default: without it the dispatch behaves exactly as
  // before.
  eventDetailRotationFor?: (event: HookEventLike) => Promise<string | null>;
  // Access-log sink for member-read Kit routes. Absent or null refuses the read.
  accessSink?: () => Promise<AccessSink | null>;
  // Post-release hook for member-read routes: runs only after the boundary
  // released the buffered response, outside its capture (see
  // memberReadResponse). The member board uses it to write its anonymous
  // board-view log, which is not a member read and must neither run inside
  // the capture nor be refused by it. Absent by default.
  afterMemberRead?: (event: HookEventLike, response: Response) => Promise<void>;
  // Native archive guard/cache around Kit SSR. The hook binds env into this
  // (request, render) => dispatchPastArchiveRequest(request, env, render); the
  // core decides WHEN it runs, so the route-id branch is pinned here instead
  // of in web/src/hooks.server.ts. Absent by default: without it the dispatch
  // behaves exactly as before.
  pastArchive?: (request: Request, render: () => Promise<Response>) => Promise<Response>;
  // Native events-list guard/cache around the Kit endpoint render. Same binding shape as the
  // archive; the list entry ships disabled, so production never reaches this
  // branch until the companion card enables it.
  eventsPage?: (request: Request, render: () => Promise<Response>) => Promise<Response>;
  // Native event-detail throttle around the Kit member-read render. Same
  // binding shape as the archive/list wrappers: the hook binds env into this
  // (request, render) => dispatchEventDetailRequest(request, env, render); the
  // core decides WHEN it runs, so the route-id branch is pinned here instead
  // of in web/src/hooks.server.ts. Absent by default: without it the dispatch
  // behaves exactly as before.
  eventDetail?: (request: Request, render: () => Promise<Response>) => Promise<Response>;
  // Native hot-zone read budget around Kit SSR. Same binding shape as the
  // archive/list wrappers: the hook binds env into this
  // (request, render) => dispatchHotzonesRequest(request, env, render); the
  // core decides WHEN it runs, so the route-id branch is pinned here instead
  // of in web/src/hooks.server.ts. Absent by default: without it the dispatch
  // behaves exactly as before.
  hotzones?: (request: Request, render: () => Promise<Response>) => Promise<Response>;
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
// Hono-identical path decode for the exemption match. Hono's guard and router
// both see getPath() (hono/utils/url in the pinned Hono: decodeURI with a
// %25 pre-escape, falling back to decoding only the valid %XX runs), so the
// twin decodes the same way. decodeURI on purpose: reserved escapes such as
// %2F stay encoded on Hono too, and decodeURIComponent would diverge.
function decodeTwinPath(path: string): string {
  const preescaped = path.includes("%25") ? path.replace(/%25/g, "%2525") : path;
  try {
    return decodeURI(preescaped);
  } catch {
    return preescaped.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
}

export function isSameOriginAllowed(request: Request, appUrl: string): boolean {
  const method = request.method.toUpperCase();
  let path: string;
  try {
    path = decodeTwinPath(new URL(request.url).pathname);
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
  onRelease?: (response: Response) => void,
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
    (response) => {
      onRelease?.(response);
      return deps.afterMemberRead?.(event, response) ?? Promise.resolve();
    },
  );
}

// Profile destinations are the Kit twin of Hono's post-boundary takeJoinResult
// (src/profiles/routes-gate.ts): expire the one-shot join flash only after the
// member-read boundary has released a successful HTML GET. The peek in
// readReturnJourney stays read-only, so a refused, failed, HEAD, or non-HTML
// response leaves the pending cookie untouched. Hono's deleteCookie supplies
// the zero max-age expiry with return-journey deleteOpts (path /, Secure,
// HttpOnly, SameSite Lax). No secret, new lifetime, or new cookie.
function releasedProfileConsumesJoinFlash(
  route: OwnedRoute,
  event: HookEventLike,
  response: Response,
): boolean {
  if (route.path !== "/profile" && route.path !== "/members/:user") return false;
  if (event.request.method !== "GET") return false;
  if (response.status !== 200) return false;
  if (!response.headers.get("content-type")?.includes("text/html")) return false;
  const flash = (event.locals as Partial<KitLocals> | undefined)?.joinResult;
  return flash === "added" || flash === "already_member";
}

// Sliding renewal for the native Kit event detail: the post-release twin of
// Hono's readSession rotation (src/index.tsx re-stamps the 120-minute window
// on every authenticated page view). Only a released successful HTML GET with
// an authenticated bridge decision renews: the 200 page and the draft 403
// (Hono reads the session before the draft check, so it rotates there too).
// Redirects, 404s, the viewer-independent 410, throttles and outages return
// in Hono before any session read, so they never renew here either. The
// attendees-live fragment is excluded like Hono's non-rotating fragment read
// (src/events/routes-detail.tsx): a rotating fragment racing the reload would
// leave exactly one winner and render the loser as a guest. Not in the
// loader: that would rotate before the audit can refuse, stranding the
// session when the refusal throws the rendered response away.
function releasedEventDetailRenewsSession(
  route: OwnedRoute,
  event: HookEventLike,
  response: Response,
): boolean {
  if (route.path !== "/e/:key") return false;
  if (event.request.method !== "GET") return false;
  if (response.status !== 200 && response.status !== 403) return false;
  if (!response.headers.get("content-type")?.includes("text/html")) return false;
  if (event.request.headers.get("x-two-island") === "attendees-live") return false;
  const locals = event.locals as Partial<KitLocals> | undefined;
  return locals?.status === "authenticated";
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
  const route = decideRoute(
    event.request,
    deps.manifest ??
      fixtureManifestFor({
        APP_URL: deps.appUrl,
        KIT_PARITY_FIXTURE_MEMBER_BOARD: deps.fixtureMemberBoard ? "true" : undefined,
        KIT_PARITY_FIXTURE_EVENT_DETAIL: deps.fixtureEventDetail ? "true" : undefined,
      }) ??
      stagingManifestFor({
        APP_URL: deps.appUrl,
        KIT_ROUTE_ARCHIVE: deps.kitRouteArchive,
        KIT_ROUTE_STATIC: deps.kitRouteStatic,
      }) ??
      ROUTE_MANIFEST,
  );
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
  // Deferred as a closure because the live detail wrapper runs before it (see
  // below): the bridge still precedes every render, but a throttled detail
  // client never reaches it.
  const bridgeSession = async (): Promise<void> => {
    if (!deps.sessionFor) return;
    try {
      const bridged = await deps.sessionFor(event);
      const prior = (event.locals as Record<string, unknown> | undefined) ?? {};
      event.locals = { ...prior, ...bridged };
    } catch (err) {
      console.warn("kit session bridge unavailable; rendering without locals.", {
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    }
  };
  // Native archive and list reads share the Hono guard and anonymous cache.
  // The route id owns the branch (SvelteKit sets it before handle runs); the
  // manifest owns the Kit half above, so an unowned path never reaches either
  // wrapper.
  const isPastArchivePage = event.route?.id === "/events/past";
  const isEventsListPage = event.route?.id === "/events";
  // Hot-zone heatmaps: the index plus the per-signal route. Concrete manifest
  // paths only (see ROUTE_MANIFEST): unknown segments never reach this branch.
  const isHotzonesPage =
    event.route?.id === "/hotzones" || event.route?.id === "/hotzones/[signal]";
  // The live detail is a member read, so it renders inside the boundary; the
  // shared public-read budget runs before the session bridge through the
  // detail wrapper, exactly as the served handler throttles before any read.
  // A limited client gets its 429 without costing a Postgres session read;
  // the bridge and the member-read render run inside the wrapper for the
  // clients the budget allows through.
  const isEventDetailPage = event.route?.id === "/e/[key]";
  let response: Response;
  let releasedMemberResponse: Response | undefined;
  if (route.reads !== "public") {
    // Narrowed once for the deferred render: the closure below would lose the
    // branch narrowing on route.reads.
    const reads = route.reads;
    if (isEventDetailPage && deps.eventDetail) {
      response = await deps.eventDetail(event.request, async () => {
        await bridgeSession();
        return renderMemberRead(event, reads, deps);
      });
    } else {
      await bridgeSession();
      response = await renderMemberRead(event, reads, deps, (released) => {
        releasedMemberResponse = released;
      });
    }
  } else if (isPastArchivePage && deps.pastArchive) {
    response = await deps.pastArchive(event.request, () => deps.resolve(event));
  } else if (isEventsListPage && deps.eventsPage) {
    response = await deps.eventsPage(event.request, () => deps.resolve(event));
  } else if (isHotzonesPage && deps.hotzones) {
    response = await deps.hotzones(event.request, () => deps.resolve(event));
  } else if (isContentLeafPath(route.path)) {
    // Content leaves keep #808's zero-stylesheet contract on the served
    // worker: the root layout's Tailwind asset is stripped after resolve and
    // <body> gains the Hono body class, so the inlined leaf block owns the
    // canvas with no render-blocking request. Gated on the manifest path
    // (not the URL), so only Kit-owned leaves take it; disabled leaves never
    // reach resolve. Every other public route resolves untouched.
    response = await deps.resolve(event, {
      transformPageChunk: ({ html }) => transformContentLeafChunk(html),
    });
  } else {
    response = await deps.resolve(event);
  }
  if (event.route?.id === HONO_FALLBACK_ROUTE_ID) return response;
  const locals = event.locals as Partial<KitLocals> | undefined;
  if (
    deps.authStatusCookieFor &&
    event.request.method === "GET" &&
    response.status === 200 &&
    response.headers.get("content-type")?.includes("text/html") &&
    locals?.status === "authenticated"
  ) {
    // Match the owned manifest entry, not an arbitrary member-looking URL.
    // Only the exact buffered response released by the audit boundary qualifies.
    let memberDocument = false;
    if (
      response === releasedMemberResponse &&
      locals.session?.member === true &&
      ["/leaderboards/members", "/profile", "/members/:user"].includes(route.path)
    ) {
      const html = await response.clone().text();
      memberDocument =
        /<!doctype html>/i.test(html) && /<html[\s>]/i.test(html) && html.includes("</body>");
      if (memberDocument) {
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        response = new Response(
          /<script\b[^>]*src="\/islands\/auth-status\.js"[^>]*>/.test(html)
            ? html
            : html.replace(
                "</body>",
                '<script src="/islands/auth-status.js" defer data-testid="auth-tab-sync"></script></body>',
              ),
          { status: response.status, headers },
        );
      }
    }
    // Preserve admin fragment cookies separately; the new member scope requires
    // a full document and does not alter the existing admin controller.
    const adminDocument = /^\/admin(?:\/|$)/.test(event.url.pathname) && locals.session?.moderator;
    try {
      const cookie =
        memberDocument || adminDocument
          ? await deps.authStatusCookieFor(event, memberDocument)
          : null;
      if (cookie) {
        const headers = new Headers(response.headers);
        headers.append("set-cookie", cookie);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch (err) {
      console.warn("kit auth-status probe unavailable; rendering without probe cookie.", {
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    }
  }
  // Sliding renewal for the released Kit event detail, at the same
  // post-response position as the probe append above. A rotation that loses
  // its race resolves to no cookie (the next read retries with a live
  // bearer); a rotation store failure warns and likewise renews nothing —
  // the already-rendered member page still stands, and the old row stays
  // live because rotate is one atomic statement.
  if (deps.eventDetailRotationFor && releasedEventDetailRenewsSession(route, event, response)) {
    try {
      const cookie = await deps.eventDetailRotationFor(event);
      if (cookie) {
        const headers = new Headers(response.headers);
        headers.append("set-cookie", cookie);
        response = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers,
        });
      }
    } catch (err) {
      console.warn("kit event-detail rotation unavailable; rendering without renewal.", {
        exception: (err as Error)?.constructor?.name ?? "unknown",
      });
    }
  }
  // After the released response exists, and only for the two profile paths.
  // Not in the loader: that would expire the flash before the audit can refuse.
  if (releasedProfileConsumesJoinFlash(route, event, response)) {
    const c = new Context(event.request);
    c.res = response;
    deleteCookie(c, JOIN_RESULT_COOKIE, deleteOpts);
    response = c.res;
  }
  decorateKitResponse(response, event, deps.appUrl, deps.featuredImageHosts);
  return response;
}
