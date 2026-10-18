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
import { readCounts, type Counts } from "../counts";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../events/reads";
import { etagFor, matchesIfNoneMatch, publicReadGuard } from "../events/routes-shared";
import { inviteDestination } from "../invite";
import { wallDateIso, wallTimeHm } from "../islands/contracts";
import { JOIN_INTRO } from "../screens/join";
import {
  API_PUBLIC_BOUNDS,
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
  apiPublicCacheKey,
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
  status: 422 | 404 | 503,
): Response {
  const body: PublicDataErrorDto = { error: { code, message } };
  return c.json(body, status, { "cache-control": "no-store, private" });
}

/**
 * Shared admission for the read API: the same per-client fixed-window budget
 * as pages and feeds, before any event or database read. A 429 validates the
 * upstream Retry-After through the shared `parseRetryAfterSeconds` parser —
 * usable values pass through (absurd ones cap at 86400), absent/unparseable
 * values fall back to 60 — and speaks the new error envelope instead of the
 * legacy /events.json shape. The one validated value feeds both the message
 * and the response header, so they can never disagree or echo raw upstream
 * text.
 */
export async function admitted(c: Ctx): Promise<Response | null> {
  const limited = await publicReadGuard(c);
  if (!limited) return null;
  const retryAfterSeconds = parseRetryAfterSeconds(limited.headers.get("retry-after")) ?? 60;
  const body: PublicDataErrorDto = {
    error: {
      code: "rate_limited",
      message: `Too many requests. Try again in ${retryAfterSeconds} seconds.`,
    },
  };
  // Stamp the context header too, not just the per-response one: the guard
  // chain already set a context-level Retry-After to the RAW upstream value,
  // and on routes with middleware Hono merges those stale context headers
  // over the returned response. Without this the MCP 429 header echoes raw
  // upstream text while the body carries the validated value.
  c.header("retry-after", String(retryAfterSeconds));
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

function cachedEntry(c: Ctx, entry: ApiPublicCacheEntry): Response {
  if (matchesIfNoneMatch(c.req.header("if-none-match"), entry.headers.etag!)) {
    return c.body(null, 304, {
      etag: entry.headers.etag!,
      "cache-control": entry.headers["cache-control"]!,
    });
  }
  return c.body(entry.body, 200, entry.headers);
}

async function servePublicJson(c: Ctx, cacheKey: string, value: unknown): Promise<Response> {
  const body = typeof value === "string" ? value : JSON.stringify(value);
  const etag = await etagFor(body);
  const headers = {
    "content-type": "application/json; charset=UTF-8",
    "cache-control": PUBLIC_MAX_AGE,
    etag,
  };
  writeApiPublicCache(cacheKey, { status: 200, headers, body });
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { etag, "cache-control": PUBLIC_MAX_AGE });
  }
  return c.body(body, 200, headers);
}

function parseLimit(raw: string): number {
  return /^[+-]?\d+$/.test(raw)
    ? Math.max(1, Math.min(Number(raw), API_PUBLIC_BOUNDS.maxPageSize))
    : API_PUBLIC_BOUNDS.defaultPageSize;
}

export function registerPublicApiRoutes(app: Hono<{ Bindings: Env }>): void {
  app.get("/api/public/events", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const limit = parseLimit(c.req.query("per_page") ?? c.req.query("limit") ?? "");
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const key = apiPublicCacheKey("GET", "/api/public/events", `?limit=${limit}&page=${page}`);
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    const db = await dbFor(c);
    if (!db) return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    // A refused socket reads as the 503 envelope; programming errors stay 500s.
    const listed = await listPublicApiEvents(db, {
      limit,
      offset: (page - 1) * limit,
    }).catch((err: unknown) => {
      if (!isDatabaseUnavailable(err)) throw err;
      return null;
    });
    if (!listed) return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    const { rows, total, page: clamped } = listed;
    const payload = serializeEventCollection(rows.map(serializeEvent), total, clamped, limit);
    let body: string;
    try {
      body = fitByteBudget(payload.data, API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => ({
        ...payload,
        data: trimmed,
      }));
    } catch (err) {
      if (err instanceof EventByteCapExceededError)
        return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
      throw err;
    }
    // Final guard: an oversized success is never cached or served.
    if (TEXT.encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes)
      return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    return servePublicJson(c, key, body);
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
    const db = await dbFor(c);
    if (!db) return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    let row;
    try {
      row = await getPublicApiEvent(db, raw);
    } catch (err) {
      if (!isDatabaseUnavailable(err)) throw err;
      return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    }
    if (!row) return apiError(c, "not_found", "No published event with that key.", 404);
    const [dto] = [serializeEvent(row)];
    let body: string;
    try {
      body = fitByteBudget([dto!], API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => trimmed[0]);
    } catch (err) {
      if (err instanceof EventByteCapExceededError)
        return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
      throw err;
    }
    // Final guard: an oversized success is never cached or served.
    if (TEXT.encode(body).length > API_PUBLIC_BOUNDS.maxBodyBytes)
      return apiError(c, "unavailable", "Event data is temporarily unavailable.", 503);
    return servePublicJson(c, key, body);
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
  app.get("/openapi.json", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.json(getOpenApiDocument(c.env.APP_URL));
  });
}
