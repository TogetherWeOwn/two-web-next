import { Hono } from "hono";
import { alertRequestError } from "./alerts";
import type { Db } from "./db/index";
import type { Env } from "./env";
import {
  ANON_PAST_TTL_MS,
  anonCacheGeneration,
  anonCacheSource,
  anonPastKey,
  isAnonCacheEligible,
  readAnonCache,
  writeAnonCache,
} from "./events/anon-cache";
import { normalizePastPage } from "./events/reads";
import type { PublicEvent } from "./events/reads";
import { resolveCalendarInput } from "./events/page-models.server";
import { searchContext, type SearchSegment } from "./events/search-context";
import { matchGame, matchQuery, resolveArchiveGameFilter } from "./events/search-log";
import { publicReadGuard } from "./events/routes-shared";

export type KitPublicReadGuard = (request: Request, env: Env) => Promise<Response | null>;

const guardApp = new Hono<{ Bindings: Env }>();
guardApp.all("*", async (c) => {
  const limited = await publicReadGuard(c);
  return limited ?? c.body(null, 204);
});

/** Reuse the public Hono read budget for the native Kit route. */
export async function kitPublicReadGuard(request: Request, env: Env): Promise<Response | null> {
  const response = await guardApp.fetch(request, env);
  return response.status === 204 ? null : response;
}

/** Apply the Hono archive's guard and anonymous HTML cache around Kit SSR. */
export async function dispatchPastArchiveRequest(
  request: Request,
  env: Env,
  resolve: () => Promise<Response>,
  guard: KitPublicReadGuard = kitPublicReadGuard,
  now: number = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  const input = resolveCalendarInput({
    q: url.searchParams.get("q"),
    game: url.searchParams.get("game"),
    games: url.searchParams.getAll("game"),
    qs: url.searchParams.getAll("q"),
  });
  // The loader rejects raw oversized/refused input before reads, even on a warm cache.
  if (input.queryTooLong || input.gameTooLong || input.gameRefused || input.queryConflicting)
    return resolve();
  const limited = await guard(request, env);
  if (limited) return limited;
  // Kit data requests still execute the read guard/load but their JSON payload
  // is not the HTML representation cached by Hono.
  const htmlRequest = url.pathname === "/events/past";
  const page = normalizePastPage(Number.parseInt(url.searchParams.get("page") ?? "1", 10));
  const eligible =
    htmlRequest &&
    isAnonCacheEligible({
      method: request.method,
      hasCookie: request.headers.has("cookie"),
      hasSession: false,
      searching: input.searching,
      flashed: false,
      filtering: matchGame(input.game) !== null,
    });
  const source = eligible ? anonCacheSource(env) : null;
  const key = eligible ? anonPastKey(request.method, page) : null;
  if (source && key) {
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
  const cacheable = response.headers.get("x-two-past-cacheable") === "true";
  const headers = new Headers(response.headers);
  headers.delete("x-two-past-cacheable");
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
          cacheControl: cleanResponse.headers.get("cache-control") ?? "public, max-age=300",
          vary: cleanResponse.headers.get("vary"),
          body,
        },
        ANON_PAST_TTL_MS,
        now,
      );
    }
  }

  return cleanResponse;
}

// Framework-free core of web/src/routes/events/past/+page.server.ts load().
// The SvelteKit module is a thin binding over this helper so the root Vitest
// suite can pin every branch without transforming SvelteKit code: rows mean
// cacheable, empty means served-but-uncacheable (events age into the archive
// as time passes, so caching emptiness would pin "never ran"), and every
// database failure is a branded 503 with private, no-store. Exactly one
// setHeaders call per path: SvelteKit throws `header_already_set` on a
// double-set, so the caller must not set headers again on a throw.
export type PastArchiveListPast<Row = never> = (
  db: Db,
  page: number,
  now?: Date,
  q?: string | null,
  game?: string | null,
) => Promise<{ rows: Row[]; hasMore: boolean; totalPages: number }>;

export type PastArchiveListGames = (
  db: Db,
  now?: Date,
  requestedGame?: string | null,
) => Promise<{ games: string[]; omitted: boolean; selectedGame?: string | null }>;

export interface PastArchiveLoadArgs<Row = never> {
  env: Env;
  pageParam: string | null;
  queryParam?: string | null;
  gameParam?: string | null;
  gameValues?: readonly string[] | null;
  qValues?: readonly string[] | null;
  setHeaders: (headers: Record<string, string>) => void;
  dbForFn: (c: { env: Env }) => Promise<Db | null>;
  listPastFn: PastArchiveListPast<Row>;
  /** Archive-visible suggestions; the binding always passes the live read. */
  listArchiveGamesFn?: PastArchiveListGames;
  /** Optional correlation ID from the caller (validated inside the alert, omitted otherwise). */
  requestId?: string;
}

/** Branded-outage marker: the Kit binding maps every throw to error(503). */
export function pastArchiveUnavailable(): Error & { status: number } {
  return Object.assign(new Error("Events temporarily unavailable"), { status: 503 });
}

// A code bug (no branded status) must never look like a downstream outage:
// emit the leak-free error.alert diagnostic before mapping to the branded
// 503, mirroring the Kit hot-zone boundary (src/kit-hotzones.ts). Branded
// throws pass through with the same outage headers and no new alert, so the
// binding maps them once. Headers and bodies are byte-stable either way:
// the binding ignores the thrown message.
function reportPastArchiveLoadFailure(
  err: unknown,
  setHeaders: (headers: Record<string, string>) => void,
  requestId?: string,
): never {
  const headers = { "cache-control": "private, no-store" };
  if (typeof (err as { status?: unknown })?.status === "number") {
    setHeaders(headers);
    throw err;
  }
  alertRequestError(err, { method: "GET", route: "/events/past", requestId });
  setHeaders(headers);
  throw pastArchiveUnavailable();
}

export async function loadPastArchivePage<Row>({
  env,
  pageParam,
  queryParam,
  gameParam,
  gameValues,
  qValues,
  setHeaders,
  dbForFn,
  listPastFn,
  listArchiveGamesFn = async () => ({ games: [], omitted: false }),
  requestId,
}: PastArchiveLoadArgs<Row>): Promise<{
  rows: Row[];
  page: number;
  hasMore: boolean;
  totalPages: number;
  appUrl: string;
  q: string;
  games: string[];
  game: string;
  gamesOmitted: boolean;
}> {
  const input = resolveCalendarInput({
    q: queryParam,
    game: gameParam,
    games: gameValues,
    qs: qValues,
  });
  if (input.queryTooLong) {
    setHeaders({ "cache-control": "private, no-store" });
    throw Object.assign(new Error("Search query too long"), { status: 422 });
  }
  if (input.gameTooLong || input.gameRefused || input.queryConflicting) {
    setHeaders({ "cache-control": "private, no-store" });
    throw Object.assign(new Error("Invalid archive game filter"), { status: 400 });
  }
  const q = matchQuery(input.q);
  const filtering = matchGame(input.game) !== null;
  let db: Db | null;
  try {
    db = await dbForFn({ env });
  } catch (err) {
    reportPastArchiveLoadFailure(err, setHeaders, requestId);
  }
  if (!db) {
    setHeaders({ "cache-control": "private, no-store" });
    throw pastArchiveUnavailable();
  }
  const page = normalizePastPage(Number.parseInt(pageParam ?? "1", 10));
  try {
    const now = new Date();
    const {
      games,
      omitted: gamesOmitted,
      selectedGame,
    } = await listArchiveGamesFn(db, now, input.game);
    const gameFilter = resolveArchiveGameFilter(games, input.game, selectedGame);
    // Suggestions and rows share one cutoff. `now` is always bound by the
    // past predicate; omitting it would create a second cutoff inside listPast.
    const { rows, hasMore, totalPages } = gameFilter
      ? await listPastFn(db, page, now, q, gameFilter)
      : q
        ? await listPastFn(db, page, now, q)
        : await listPastFn(db, page, now);
    const unfiltered = !input.searching && !filtering;
    setHeaders({
      "cache-control": unfiltered ? "public, max-age=300" : "private, no-store",
      "x-two-past-cacheable": String(unfiltered && rows.length > 0),
      // Browsing renders are public and shared, like the Hono twin: name the
      // Cookie variance so shared caches key anonymous and signed-in shells
      // apart. Searching/filtered renders stay private no-store with no Vary.
      ...(unfiltered ? { vary: "Cookie" } : {}),
    });
    return {
      rows,
      page,
      hasMore,
      totalPages,
      appUrl: env.APP_URL,
      q: q ?? "",
      games,
      game: gameFilter ?? "",
      gamesOmitted,
    };
  } catch (err) {
    reportPastArchiveLoadFailure(err, setHeaders, requestId);
  }
}

/**
 * The anonymous-safe slice of a past-archive row: the fields the archive
 * card renders (key/title/time/zone/location/game/counts/capacity) plus the
 * occupancy aggregate and the public-by-design Discord event id. Kit
 * serializes load data into `__data.json` for anonymous clients even with
 * `csr=false`, so the past load returns this projection, never the full
 * row: the authorship snowflake (`createdBy`, a moderator Discord id kept
 * for retention), descriptions, organizer names and sync internals never
 * leave the server on this logged-out, indexed page. The exceptions are
 * query-only, present only for a nonblank search: the bounded description
 * passage (`passage`, at most 320 code points, only when the row has a
 * description) and the full-title literal segments (`titleSpans`) that the
 * archive card renders with semantic marks. Both derive from the already
 * public title or a bounded excerpt, never member data, and keep the
 * segment authority server-side so the client ships no search code.
 * Mirrors the join
 * precedent (`toPublicWidgetSnapshot`) and the home teaser (`HomeEvent`).
 */
export type PastArchiveEvent = Pick<
  PublicEvent,
  | "eventKey"
  | "title"
  | "startsAt"
  | "timezone"
  | "location"
  | "game"
  | "goingCount"
  | "goingOccupancy"
  | "capacity"
  | "discordEventId"
> & { passage?: SearchSegment[]; titleSpans?: SearchSegment[] };

/** Project a past-archive row to its anonymous-safe slice. */
export function toPublicPastArchiveRow(row: PublicEvent, q?: string): PastArchiveEvent {
  const projected: PastArchiveEvent = {
    eventKey: row.eventKey,
    title: row.title,
    startsAt: row.startsAt,
    timezone: row.timezone,
    location: row.location,
    game: row.game,
    goingCount: row.goingCount,
    goingOccupancy: row.goingOccupancy,
    capacity: row.capacity,
    discordEventId: row.discordEventId,
  };
  if (q && row.description) projected.passage = searchContext(row.description, q, true);
  if (q) projected.titleSpans = searchContext(row.title, q);
  return projected;
}
