// Bounded public read API: GET /api/public/events, /api/public/events/:key,
// /api/public/community, /api/public/join, plus GET /openapi.json.
//
// Session-free by construction: these handlers never read a session or a
// cookie, and the cache key carries method + path + clamped paging only.
// Every representation is published-only and byte-identical for anonymous
// viewers, cookie-bearing guests and moderator sessions — that is the cache
// isolation, and test/api-public-events.test.ts pins it. The session-gated
// /events.json contract is untouched.
import type { Context, Hono } from "hono";
import { dbFor } from "../admin/db";
import { containsControlCharacters } from "../admin/validation-shared";
import { alertRequestError } from "../alerts";
import { readCounts, type Counts } from "../counts";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import { varyAccept } from "../errors";
import { stagingRobots } from "../headers";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../events/reads";
import { etagFor, matchesIfNoneMatch, publicReadGuard } from "../events/routes-shared";
import { inviteDestination } from "../invite";
import { wallDateIso, wallTimeHm } from "../islands/contracts";
import { requestRoute } from "../request-log";
import { JOIN_INTRO } from "../screens/join";
import {
  API_PUBLIC_BOUNDS,
  PUBLIC_API_GAME_MAX_LENGTH,
  PUBLIC_DATA_ERROR_NEXT,
  PUBLIC_DATA_INTERNAL_MESSAGE,
  PUBLIC_EVENT_STATUS,
  parsePublicEventId,
  type CommunitySnapshotDto,
  type JoinHandoffDto,
  type PublicApiEventCollectionDto,
  type PublicApiEventDto,
  type PublicDataErrorCode,
  type PublicDataErrorDto,
  type PublicEventId,
} from "./contracts";
import {
  apiPublicCacheGeneration,
  apiPublicCacheKey,
  findCachedClampTarget,
  readApiPublicCache,
  writeApiPublicCache,
  type ApiPublicCacheEntry,
} from "./cache";
import { getOpenApiDocument } from "./openapi";
import { parseRetryAfterSeconds } from "../jobs/retry-delay";

type Ctx = Context<{ Bindings: Env }>;

const PUBLIC_MAX_AGE = "public, max-age=60";
const TEXT = new TextEncoder();

function apiError(
  c: Ctx,
  code: PublicDataErrorCode,
  message: string,
  status: 422 | 404 | 500 | 503,
): Response {
  const body: PublicDataErrorDto = {
    error: {
      code,
      message,
      request_id: c.get("requestId"),
      next: PUBLIC_DATA_ERROR_NEXT[code],
    },
  };
  return c.json(body, status, { "cache-control": "no-store, private" });
}

/**
 * Unexpected fault on an event read: alert once with the class fingerprint
 * (the same privacy boundary as the global handler — class, never message)
 * and answer the static `internal` envelope, never branded HTML, exception
 * text, SQL or row data. Transport failures stay on the 503 path.
 */
function internalFault(c: Ctx, err: unknown): Response {
  alertRequestError(err, {
    method: c.req.method,
    route: requestRoute(c),
    requestId: c.get("requestId"),
  });
  varyAccept(c);
  return apiError(c, "internal", PUBLIC_DATA_INTERNAL_MESSAGE, 500);
}

function unavailable(c: Ctx): Response {
  return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
}

/**
 * Shared admission check for the read API: the same per-client fixed-window
 * budget as pages and feeds, before any event or database read. Returns the
 * validated Retry-After seconds when the budget is spent (usable upstream
 * values pass through, absurd ones cap at 86400, absent/unparseable values
 * fall back to 60), or null when the request is admitted. Stamps the
 * validated value on the context header too, not just the per-response one:
 * the guard chain already set a context-level Retry-After to the RAW upstream
 * value, and on routes with middleware Hono merges those stale context
 * headers over the returned response.
 */
export async function admissionRetryAfter(c: Ctx): Promise<number | null> {
  const limited = await publicReadGuard(c);
  if (!limited) return null;
  const retryAfterSeconds = parseRetryAfterSeconds(limited.headers.get("retry-after")) ?? 60;
  c.header("retry-after", String(retryAfterSeconds));
  return retryAfterSeconds;
}

/**
 * Shared admission for the read API. A 429 speaks the error envelope instead
 * of the legacy /events.json shape. The one validated value feeds both the
 * message and the response header, so they can never disagree or echo raw
 * upstream text.
 */
export async function admitted(c: Ctx): Promise<Response | null> {
  const retryAfterSeconds = await admissionRetryAfter(c);
  if (retryAfterSeconds === null) return null;
  const body: PublicDataErrorDto = {
    error: {
      code: "rate_limited",
      message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
      request_id: c.get("requestId"),
      next: PUBLIC_DATA_ERROR_NEXT.rate_limited,
    },
  };
  return c.json(body, 429, {
    "retry-after": String(retryAfterSeconds),
    "cache-control": "no-store, private",
  });
}

/** Legacy event-JSON key order, with a nullable going count. */
export function serializeEvent(e: PublicApiEvent): PublicApiEventDto {
  const wall = (d: Date) => `${wallDateIso(d, e.timezone)} ${wallTimeHm(d, e.timezone)}`;
  return {
    event_key: e.eventKey as PublicEventId,
    title: e.title,
    game: e.game,
    description: e.description,
    starts_at: e.startsAt.toISOString(),
    ends_at: e.endsAt.toISOString(),
    starts_at_local: wall(e.startsAt),
    ends_at_local: wall(e.endsAt),
    timezone: e.timezone,
    location: e.location,
    capacity: e.capacity,
    going_count: e.goingCount,
    // Attributable `going_count` can read a free seat a nameless row already
    // holds, so the occupancy aggregate ships beside it for spots/full math.
    // Both degrade to null (never 0) when the rollup is unavailable.
    going_occupancy: e.goingOccupancy ?? e.goingCount,
    status: PUBLIC_EVENT_STATUS,
    rsvp_open: e.rsvpOpen,
    synced_to_discord: e.discordEventId !== null,
  };
}

/**
 * Collection envelope: rows are never dropped, so paging stays stable.
 * Shared with the MCP tools so the REST and MCP envelopes cannot drift.
 */
export function serializeEventCollection(
  data: PublicApiEventDto[],
  total: number,
  page: number,
  limit: number,
): PublicApiEventCollectionDto {
  return {
    data,
    page,
    limit,
    meta: {
      current_page: page,
      per_page: limit,
      total,
      last_page: Math.max(1, Math.ceil(total / limit)),
    },
  };
}

/**
 * Community snapshot projection. Shared with the MCP tools so the REST and
 * MCP representations cannot drift: null counts when collectors are down,
 * never 0.
 */
export function serializeCommunity(counts: Counts): CommunitySnapshotDto {
  return {
    member_count: counts.memberCount,
    online_count: counts.onlineCount,
    ranks: counts.ranks.map((rank) => ({
      key: rank.key,
      label: rank.label,
      member_count: rank.memberCount,
    })),
  };
}

/**
 * Discord join handoff. Shared with the MCP tools; database-free like the
 * /join leaf, env config only.
 */
export function serializeJoin(env: Env): JoinHandoffDto {
  return {
    intro: JOIN_INTRO,
    invite_url: inviteDestination(env.DISCORD_INVITE_URL),
  };
}

/**
 * Irreducible byte-cap overflow: the event representation still exceeds
 * maxBytes after every trimmable description is exhausted. Callers map this
 * to the existing static unavailable envelope; the message stays generic so
 * it can never leak row content.
 */
export class EventByteCapExceededError extends Error {
  constructor() {
    super("Event representation exceeds the public byte cap.");
    this.name = "EventByteCapExceededError";
  }
}

/**
 * Fits a collection inside the byte cap by halving the longest description
 * until the wrapped body fits. Shortened descriptions end in …; rows are
 * never dropped, so paging stays stable. Always terminates: a one-character
 * description collapses to empty. Throws EventByteCapExceededError when no
 * description remains but the body still exceeds the cap — irreducible
 * metadata (title/game/location) must refuse, never return oversized.
 */
export function fitByteBudget(
  rows: PublicApiEventDto[],
  maxBytes: number,
  wrap: (rows: PublicApiEventDto[]) => unknown,
): string {
  let body = JSON.stringify(wrap(rows));
  for (;;) {
    if (TEXT.encode(body).length <= maxBytes) return body;
    let longest: PublicApiEventDto | null = null;
    for (const row of rows) {
      if (
        row.description &&
        (!longest?.description || row.description.length > longest.description.length)
      )
        longest = row;
    }
    if (!longest?.description) throw new EventByteCapExceededError();
    // Cut on code points, not UTF-16 units: slicing astral characters
    // (emoji, some CJK) mid-pair emits a lone surrogate that strict JSON
    // decoders reject. Array.from splits on whole code points.
    const codePoints = Array.from(longest.description);
    longest.description =
      codePoints.length <= 1
        ? ""
        : `${codePoints.slice(0, Math.ceil(codePoints.length / 2) - 1).join("")}…`;
    body = JSON.stringify(wrap(rows));
  }
}

/**
 * Remaining TTL, rounded down: a hit served 59 s after the write tells the
 * downstream cache `max-age=1`, never a fresh full window, so downstream
 * freshness can never extend past the original expiry. A sub-second
 * remainder — or a hit that crosses expiry between the cache read and this
 * second clock sample — answers `max-age=0`: immediately stale, revalidate.
 */
function remainingMaxAge(expiresAt: number, now: number): number {
  return Math.max(0, Math.floor((expiresAt - now) / 1000));
}

function cachedEntry(c: Ctx, entry: ApiPublicCacheEntry): Response {
  const cacheControl = entry.headers["cache-control"]!.replace(
    /max-age=\d+/,
    `max-age=${remainingMaxAge(entry.expiresAt, Date.now())}`,
  );
  if (matchesIfNoneMatch(c.req.header("if-none-match"), entry.headers.etag!)) {
    return c.body(null, 304, {
      etag: entry.headers.etag!,
      "cache-control": cacheControl,
    });
  }
  // Fresh object: the stored headers stay untouched for the next hit.
  return c.body(entry.body, 200, { ...entry.headers, "cache-control": cacheControl });
}

async function servePublicJson(
  c: Ctx,
  cacheKey: string,
  value: unknown,
  expectedGeneration?: number,
): Promise<Response> {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const etag = await etagFor(body);
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": PUBLIC_MAX_AGE,
    etag,
  };
  const settled = writeApiPublicCache(
    cacheKey,
    { status: 200, headers, body },
    Date.now(),
    expectedGeneration,
  );
  // Overtaken by a retire: answer our own bytes, but never as reusable —
  // a full max-age here would keep pre-mutation bytes fresh downstream.
  if (!settled) headers["cache-control"] = "public, max-age=0, must-revalidate";
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { etag, "cache-control": headers["cache-control"] });
  }
  return c.body(body, 200, headers);
}

/**
 * Invalid and unknown games share the canonical empty page, but never occupy
 * per-input entries in the shared 64-entry cache. Downstream caching and
 * ETag/304 still apply, unless retirement overtook a database-backed read.
 */
async function emptyEventCollection(c: Ctx, expectedGeneration?: number): Promise<Response> {
  const body = JSON.stringify(
    serializeEventCollection([], 0, 1, API_PUBLIC_BOUNDS.defaultPageSize),
  );
  const etag = await etagFor(body);
  const cacheControl =
    expectedGeneration !== undefined && expectedGeneration !== apiPublicCacheGeneration()
      ? "public, max-age=0, must-revalidate"
      : PUBLIC_MAX_AGE;
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { etag, "cache-control": cacheControl });
  }
  return c.body(body, 200, {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": cacheControl,
    etag,
  });
}

function parseLimit(raw: string): number {
  return /^[+-]?\d+$/.test(raw)
    ? Math.max(1, Math.min(Number(raw), API_PUBLIC_BOUNDS.maxPageSize))
    : API_PUBLIC_BOUNDS.defaultPageSize;
}

/**
 * Raw page with the documented ceiling applied before any key or offset is
 * built. Missing values, values without an integer prefix and sub-1 values
 * fall back to 1 (never a 422); huge or unsafe integers cap at maxPage so the
 * offset stays a safe integer. Lenient `parseInt` parsing is preserved:
 * "2abc" and "2.9" still read as 2, with optional sign and leading whitespace.
 */
function parsePage(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 1) return 1;
  if (!Number.isSafeInteger(n) || n > API_PUBLIC_BOUNDS.maxPage) return API_PUBLIC_BOUNDS.maxPage;
  return n;
}

export function registerPublicApiRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/public/events", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    // Optional `game` facet: absent reads unfiltered (byte-identical CONTROL);
    // present trims and bounds here, matches case-insensitively exact in the
    // reader as a bound parameter. Present-but-blank, oversized and unknown
    // degrade to the empty page, never a 422 and never unfiltered. The raw
    // value is never reflected in a body, message or header.
    const rawGame = c.req.query("game");
    let game: string | null = null;
    let gameKey: string | null = null;
    if (rawGame !== undefined) {
      const trimmed = rawGame.trim();
      if (
        trimmed === "" ||
        [...trimmed].length > PUBLIC_API_GAME_MAX_LENGTH ||
        containsControlCharacters(trimmed)
      ) {
        return emptyEventCollection(c);
      }
      game = trimmed;
      // Cache by the lowercased form so `Chess` and `chess` share one entry;
      // the reader lowercases again for the SQL binding.
      gameKey = trimmed.toLowerCase();
    }
    const limit = parseLimit(c.req.query("per_page") ?? c.req.query("limit") ?? "");
    const page = parsePage(c.req.query("page") ?? "1");
    const canonicalQuery = gameKey
      ? `?limit=${limit}&page=${page}&game=${encodeURIComponent(gameKey)}`
      : `?limit=${limit}&page=${page}`;
    const key = apiPublicCacheKey("GET", "/api/public/events", canonicalQuery);
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // Out-of-range replay: only an entry at its own last page proves a clamp,
    // so never combine metadata and bytes from different cached snapshots.
    // The game isolates clamps: each game's past-the-end page replays only its
    // own last page.
    const clampTarget = findCachedClampTarget(limit, page, gameKey);
    if (clampTarget !== null && clampTarget !== page) {
      const clampedQuery = gameKey
        ? `?limit=${limit}&page=${clampTarget}&game=${encodeURIComponent(gameKey)}`
        : `?limit=${limit}&page=${clampTarget}`;
      const clampedHit = readApiPublicCache(
        apiPublicCacheKey("GET", "/api/public/events", clampedQuery),
      );
      if (clampedHit) return cachedEntry(c, clampedHit);
    }
    // Fence: a retire that lands while this read is in flight refuses the
    // settle below, so pre-retire bytes never refill the retired entry.
    const generation = apiPublicCacheGeneration();
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    // A refused socket reads as the 503 envelope; query, serializer and
    // budget faults answer the static 500 envelope, never the branded page.
    let body: string;
    let clamped: number = page;
    try {
      const listed = await listPublicApiEvents(
        db,
        game === null
          ? { limit, offset: (page - 1) * limit }
          : { limit, offset: (page - 1) * limit, game },
      );
      if (!listed) return unavailable(c);
      clamped = listed.page;
      const { rows, total } = listed;
      // A filtered total of zero answers the canonical default empty page,
      // ignoring the requested paging: unknown and hostile games degrade to
      // one representation, never a 422 and never unfiltered rows.
      if (game !== null && total === 0) return await emptyEventCollection(c, generation);
      const payload = serializeEventCollection(rows.map(serializeEvent), total, clamped, limit);
      try {
        body = fitByteBudget(payload.data, API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => ({
          ...payload,
          data: trimmed,
        }));
      } catch (err) {
        if (err instanceof EventByteCapExceededError) return unavailable(c);
        throw err;
      }
    } catch (err) {
      if (isDatabaseUnavailable(err)) return unavailable(c);
      return internalFault(c, err);
    }
    // Final guard: an oversized success is never cached or served.
    if (TEXT.encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes) return unavailable(c);
    // Store under the clamped page the database answered, never the raw alias:
    // N past-the-end pages occupy one entry and cannot evict page 1. Filtered
    // entries carry the game so games never share bytes.
    const storeQuery = gameKey
      ? `?limit=${limit}&page=${clamped}&game=${encodeURIComponent(gameKey)}`
      : `?limit=${limit}&page=${clamped}`;
    const storeKey = apiPublicCacheKey("GET", "/api/public/events", storeQuery);
    return servePublicJson(c, storeKey, body, generation);
  });

  app.get("/api/public/events/:key", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const raw = c.req.param("key");
    // Static message: the rejected key is never reflected.
    if (!parsePublicEventId(raw))
      return apiError(c, "invalid_request", "That event key is not valid.", 422);
    const key = apiPublicCacheKey("GET", c.req.path, "");
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // Fence: same as the collection route — a retire that lands mid-read
    // refuses the settle, so a deferred 200 never resurrects a retired entry.
    const generation = apiPublicCacheGeneration();
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    // A refused socket reads as the 503 envelope; query, serializer and
    // budget faults answer the static 500 envelope, never the branded page.
    let body: string;
    try {
      const row = await getPublicApiEvent(db, raw);
      if (!row) return apiError(c, "not_found", "No published event with that key.", 404);
      const [dto] = [serializeEvent(row)];
      try {
        body = fitByteBudget([dto!], API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => trimmed[0]);
      } catch (err) {
        if (err instanceof EventByteCapExceededError) return unavailable(c);
        throw err;
      }
    } catch (err) {
      if (isDatabaseUnavailable(err)) return unavailable(c);
      return internalFault(c, err);
    }
    // Final guard: an oversized success is never cached or served.
    if (TEXT.encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes) return unavailable(c);
    return servePublicJson(c, key, body, generation);
  });

  app.get("/api/public/community", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const key = apiPublicCacheKey("GET", "/api/public/community", "");
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // readCounts never throws: missing collectors degrade to nulls, never 0.
    const payload = serializeCommunity(await readCounts(c.env));
    return servePublicJson(c, key, payload);
  });

  app.get("/api/public/join", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const key = apiPublicCacheKey("GET", "/api/public/join", "");
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // Database-free like the /join leaf: the handoff is env config only.
    return servePublicJson(c, key, serializeJoin(c.env));
  });

  // Static discovery document, database-free like robots.txt: no admission,
  // no session, unchanged bytes per APP_URL with a long edge TTL.
  app.get("/openapi.json", async (c) => {
    const body = JSON.stringify(getOpenApiDocument(c.env.APP_URL));
    const etag = await etagFor(body);
    c.header("cache-control", "public, max-age=3600");
    c.header("etag", etag);
    const robots = stagingRobots(c);
    if (robots) c.header("x-robots-tag", robots);
    if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) return c.body(null, 304);
    return c.body(body, 200, { "content-type": "application/json" });
  });
}
