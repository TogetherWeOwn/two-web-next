import { Hono } from "hono";
import { alertRequestError } from "./alerts";
import type { Db } from "./db/index";
import type { Env, HeaderSession } from "./env";
import {
  ANON_EVENTS_TTL_MS,
  anonCacheGeneration,
  anonCacheSource,
  anonEventsKey,
  isAnonCacheEligible,
  readAnonCache,
  writeAnonCache,
} from "./events/anon-cache";
import {
  loadCalendarPageModel,
  resolveCalendarInput,
  type CalendarPageInput,
  type CalendarPageModel,
} from "./events/page-models.server";
import { guardRequestId, publicReadGuard, seedGuardRequestId } from "./events/routes-shared";
import type { DiscordEventsSource } from "./events/discord-transients-types";
import { inviteDestination } from "./invite";
import type { JoinResult } from "./return-journey";
import { canonicalUrl } from "./seo";

export type KitEventsGuard = (
  request: Request,
  env: Env,
  requestId?: unknown,
) => Promise<Response | null>;

const guardApp = new Hono<{ Bindings: Env }>();
guardApp.use(guardRequestId);
guardApp.all("*", async (c) => {
  const limited = await publicReadGuard(c);
  return limited ?? c.body(null, 204);
});

/**
 * Reuse the public Hono read budget for the native Kit route. The dispatch
 * passes its minted id so a 429 renders the same support reference the
 * response header carries; without one the refusal stays blank-safe.
 */
export async function kitEventsGuard(
  request: Request,
  env: Env,
  requestId?: unknown,
): Promise<Response | null> {
  const response = await guardApp.fetch(seedGuardRequestId(request, requestId), env);
  return response.status === 204 ? null : response;
}

/** Viewer bits the Kit list load needs: the header name, member chrome, draft visibility. */
export interface KitEventsSession {
  username: string;
  member: boolean;
  moderator: boolean;
}

export interface EventsDispatchOverrides {
  guard?: KitEventsGuard;
  sessionFor?: (request: Request) => Promise<KitEventsSession | null>;
  journeyFor?: (request: Request) => Promise<JoinResult | null>;
  now?: number;
  requestId?: unknown;
}

const ISLAND_NAME = "events-calendar";
const TOO_LONG_MARKER = "x-two-events-too-long";
const CACHEABLE_MARKER = "x-two-events-cacheable";

function calendarInputOf(url: URL): CalendarPageInput {
  return resolveCalendarInput({
    q: url.searchParams.get("q"),
    game: url.searchParams.get("game"),
    view: url.searchParams.get("view"),
    past: url.searchParams.get("past"),
    page: url.searchParams.get("page"),
    event: url.searchParams.get("event"),
    month: url.searchParams.get("month"),
  });
}

/** Rewrite a too-long render to the Hono 422 contract: notice markup, no echo. */
function rewriteTooLong(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(TOO_LONG_MARKER);
  headers.delete(CACHEABLE_MARKER);
  return new Response(response.body, {
    status: 422,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Apply the Hono list route's guard and anonymous HTML cache around the Kit endpoint render.
 *
 * Mirrors GET /events (src/events/routes-calendar.tsx): the shared public-read
 * budget runs before any read, only a cookieless session-free search-free
 * flash-free render serves or settles shared bytes (island fragments key
 * separately), Kit data requests never settle as HTML, and a render overtaken
 * by a retire mid-flight never settles. Overlong searches skip the guard and
 * the cache like Hono (422 before admission) and rewrite to 422 on the way
 * out; the load marks them so the notice markup still renders.
 */
export async function dispatchEventsRequest(
  request: Request,
  env: Env,
  resolve: () => Promise<Response>,
  overrides: EventsDispatchOverrides = {},
): Promise<Response> {
  const {
    guard = kitEventsGuard,
    sessionFor = async () => null,
    journeyFor = async () => null,
    now = Date.now(),
    requestId,
  } = overrides;
  const url = new URL(request.url);
  const input = calendarInputOf(url);
  if (input.queryTooLong) return rewriteTooLong(await resolve());

  const limited = await guard(request, env, requestId);
  if (limited) return limited;

  // Kit data requests still execute the read guard/load but their JSON payload
  // is not the HTML representation cached by Hono.
  const htmlRequest = url.pathname === "/events";
  const island = request.headers.get("x-two-island") === ISLAND_NAME;
  // Any Cookie header already excludes the shared cache, and a session needs
  // its cookie: skip the store read for cookie-bearing requests so every
  // signed-in view avoids an extra client plus query (the load re-reads).
  const session = request.headers.has("cookie") ? null : await sessionFor(request);
  // Island swaps keep their pending flash value like Hono: only full renders
  // peek at it, so a fragment never eats the banner it cannot display.
  const flashed = island ? null : await journeyFor(request);
  const eligible =
    htmlRequest &&
    isAnonCacheEligible({
      method: request.method,
      hasCookie: request.headers.has("cookie"),
      hasSession: session !== null,
      searching: input.searching,
      flashed: flashed !== null,
    });
  const source = eligible ? anonCacheSource(env) : null;
  let key: string | null = null;
  if (source) {
    let pathAndSearch = "/events";
    try {
      pathAndSearch = url.pathname + url.search;
    } catch {
      pathAndSearch = "/events";
    }
    key = anonEventsKey(request.method, pathAndSearch, island);
    const hit = readAnonCache(key, source, now);
    if (hit) {
      const headers = new Headers({ "cache-control": hit.cacheControl });
      headers.set(
        "cache-control",
        hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
      );
      // The entry stores no content type and a string body defaults to
      // text/plain; name the cached HTML exactly as Hono's c.html() does so
      // repeat guests render the page instead of its source.
      headers.set("content-type", "text/html; charset=UTF-8");
      if (hit.vary) headers.set("vary", hit.vary);
      return new Response(hit.body, { status: hit.status, headers });
    }
  }

  const generation = source ? anonCacheGeneration() : 0;
  const response = await resolve();
  if (response.headers.get(TOO_LONG_MARKER) === "true") return rewriteTooLong(response);
  const cacheable = response.headers.get(CACHEABLE_MARKER) === "true";
  const headers = new Headers(response.headers);
  headers.delete(CACHEABLE_MARKER);
  const cleanResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });

  if (source && key && cacheable && cleanResponse.status === 200) {
    // Buffer the candidate before the final generation comparison: a retire
    // that lands while clone().text() is in flight must stop the stale bytes
    // from settling. The compare-and-write below is synchronous, so it stays
    // atomic within the isolate.
    const body = await cleanResponse.clone().text();
    if (anonCacheGeneration() === generation) {
      writeAnonCache(
        key,
        source,
        {
          status: cleanResponse.status,
          cacheControl: cleanResponse.headers.get("cache-control") ?? "public, max-age=60",
          vary: cleanResponse.headers.get("vary"),
          body,
        },
        ANON_EVENTS_TTL_MS,
        now,
      );
    }
  }

  return cleanResponse;
}

/** Branded-outage marker: the Kit binding maps every throw to error(503). */
export function eventsUnavailable(): Error & { status: number } {
  return Object.assign(new Error("Events temporarily unavailable"), { status: 503 });
}

// A code bug (no branded status) must never look like a downstream outage:
// emit the leak-free error.alert diagnostic before mapping to the branded
// 503, mirroring the Kit hot-zone boundary (src/kit-hotzones.ts). Branded
// throws pass through with the same outage headers and no new alert, so the
// binding maps them once. Headers and bodies are byte-stable either way:
// the binding ignores the thrown message.
function reportEventsLoadFailure(
  err: unknown,
  setHeaders: (headers: Record<string, string>) => void,
  vary: string,
  requestId: string | undefined,
  method: string,
): never {
  const headers = { "cache-control": "private, no-store", vary };
  if (typeof (err as { status?: unknown })?.status === "number") {
    setHeaders(headers);
    throw err;
  }
  alertRequestError(err, { method, route: "/events", requestId });
  setHeaders(headers);
  throw eventsUnavailable();
}

export type KitEventsModelFor = (args: {
  db: Db;
  input: CalendarPageInput;
  includeDrafts: boolean;
  discord: DiscordEventsSource;
  now: Date;
}) => Promise<CalendarPageModel>;

export interface KitEventsLoadArgs {
  env: Env;
  url: URL;
  method: string;
  island: boolean;
  request: Request;
  setHeaders: (headers: Record<string, string>) => void;
  /** Requests one-shot cookie deletion; the endpoint commits it after rendering. */
  deleteJoinCookie: () => void;
  dbForFn: (c: { env: Env }) => Promise<Db | null>;
  sessionForFn: (request: Request) => Promise<KitEventsSession | null>;
  journeyForFn: (request: Request) => Promise<JoinResult | null>;
  modelForFn?: KitEventsModelFor;
  discordForFn: (env: Env) => DiscordEventsSource;
  now?: Date;
  /** Optional correlation ID from the caller (validated inside the alert, omitted otherwise). */
  requestId?: string;
}

export interface KitEventsLoadData extends CalendarPageModel {
  /** Request instant, shared by the model and the month-grid today marker. */
  now: Date;
  member: boolean;
  moderator: boolean;
  /** Signed-in viewer for the header account area; the shell gates members. */
  session: HeaderSession | null;
  inviteUrl: string;
  appUrl: string;
  canonical: string;
  /** Rooted path the guest sign-in link carries as ?next=. */
  loginReturnTo: string;
  joinResult: JoinResult | null;
  queryTooLong: false;
}

/**
 * Framework-free core of web/src/routes/events/+server.ts GET.
 *
 * Owns the Hono query-state contract (src/events/page-models.server.ts input
 * plus src/events/routes-calendar.tsx response policy) so the root Vitest
 * suite pins every branch without transforming SvelteKit code: overlong
 * searches return a queryTooLong flag the page renders as the Hono 422 notice
 * (never echoing the query; the dispatch rewrites the status), anonymous
 * search-free flash-free renders stay publicly cacheable for the dispatch to
 * settle, and every database failure is a branded 503 with private, no-store.
 * Exactly one setHeaders call per path, collected by the endpoint until it
 * knows whether rendering succeeded; error responses always use no-store.
 *
 * Session reads are read-only (no rotation, no revocation). Flash consumption
 * is requested only for full GET renders after a successful model read, and
 * the endpoint commits deletion only after constructing the response.
 * Fragments and failed renders leave the banner for the next full load.
 */
export async function loadEventsPage(
  args: KitEventsLoadArgs,
): Promise<KitEventsLoadData | { queryTooLong: true; appUrl: string }> {
  const {
    env,
    url,
    method,
    island,
    request,
    setHeaders,
    deleteJoinCookie,
    dbForFn,
    sessionForFn,
    journeyForFn,
    modelForFn = loadCalendarPageModel,
    discordForFn,
    now = new Date(),
    requestId,
  } = args;
  const vary = "Cookie, X-Two-Island";
  const input = calendarInputOf(url);
  if (input.queryTooLong) {
    setHeaders({
      "cache-control": "no-store, private",
      vary,
      [TOO_LONG_MARKER]: "true",
    });
    // The app URL rides along so the notice page keeps the Hono canonical
    // without echoing the overlong query anywhere.
    return { queryTooLong: true as const, appUrl: env.APP_URL };
  }

  let db: Db | null;
  try {
    db = await dbForFn({ env });
  } catch (err) {
    reportEventsLoadFailure(err, setHeaders, vary, requestId, method);
  }
  if (!db) {
    setHeaders({ "cache-control": "private, no-store", vary });
    throw eventsUnavailable();
  }

  let session: KitEventsSession | null;
  try {
    session = await sessionForFn(request);
  } catch {
    session = null;
  }
  // Island fragment swaps must not consume the flash: the banner renders
  // outside the swapped zones, so a fragment would eat it without displaying
  // it — the pending value survives for the next full load.
  let joinResult: JoinResult | null = null;
  if (!island) {
    try {
      joinResult = await journeyForFn(request);
    } catch {
      joinResult = null;
    }
  }
  const hasPendingJoinResult = joinResult !== null;
  if (method !== "GET") joinResult = null;

  let model: CalendarPageModel;
  try {
    model = await modelForFn({
      db,
      input,
      includeDrafts: session?.moderator ?? false,
      discord: discordForFn(env),
      now,
    });
  } catch (err) {
    reportEventsLoadFailure(err, setHeaders, vary, requestId, method);
  }

  // Request consumption after the read succeeds, like Hono's takeJoinResult.
  // The endpoint defers the deletion until rendering succeeds as well, so a
  // branded 503 leaves the pending flash for the next full load.
  if (joinResult && method === "GET") deleteJoinCookie();

  const cacheControl =
    session || input.searching || hasPendingJoinResult ? "private, no-store" : "public, max-age=60";
  const headers: Record<string, string> = {
    "cache-control": cacheControl,
    vary,
    [CACHEABLE_MARKER]: String(cacheControl.startsWith("public")),
  };
  if (model.robots !== undefined) headers["x-robots-tag"] = model.robots;
  setHeaders(headers);

  return {
    ...model,
    now,
    member: session?.member ?? false,
    moderator: session?.moderator ?? false,
    session: session ? { username: session.username, member: session.member } : null,
    inviteUrl: inviteDestination(env.DISCORD_INVITE_URL),
    appUrl: env.APP_URL,
    canonical: canonicalUrl(env.APP_URL, "/events"),
    loginReturnTo: url.pathname + url.search,
    joinResult,
    queryTooLong: false,
  };
}
