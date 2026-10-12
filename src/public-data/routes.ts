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
import { readCounts } from "../counts";
import { isDatabaseUnavailable } from "../db/errors";
import type { Env } from "../env";
import { getPublicApiEvent, listPublicApiEvents, type PublicApiEvent } from "../events/reads";
import { etagFor, publicReadGuard } from "../events/routes-shared";
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
 * as pages and feeds, before any event or database read. A 429 keeps the
 * shared Retry-After but speaks the new error envelope instead of the legacy
 * /events.json shape.
 */
async function admitted(c: Ctx): Promise<Response | null> {
  const limited = await publicReadGuard(c);
  if (!limited) return null;
  const retryAfter = limited.headers.get("retry-after") ?? "60";
  const body: PublicDataErrorDto = {
    error: {
      code: "rate_limited",
      message: `Too many requests. Try again in ${retryAfter} seconds.`,
    },
  };
  return c.json(body, 429, {
    "retry-after": retryAfter,
    "cache-control": "no-store, private",
  });
}

/** Legacy event-JSON key order, with a nullable going count. */
function serializeEvent(e: PublicApiEvent): PublicApiEventDto {
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
 * Fits a collection inside the byte cap by halving the longest description
 * until the wrapped body fits. Shortened descriptions end in …; rows are
 * never dropped, so paging stays stable. Always terminates: a one-character
 * description collapses to empty.
 */
function fitByteBudget(
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
    if (!longest?.description) return body;
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
  if (c.req.header("if-none-match") === entry.headers.etag) {
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
  if (c.req.header("if-none-match") === etag) {
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
    const data = rows.map(serializeEvent);
    const payload: PublicApiEventCollectionDto = {
      data,
      page: clamped,
      limit,
      meta: {
        current_page: clamped,
        per_page: limit,
        total,
        last_page: Math.max(1, Math.ceil(total / limit)),
      },
    };
    return servePublicJson(
      c,
      key,
      fitByteBudget(data, API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => ({
        ...payload,
        data: trimmed,
      })),
    );
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
    return servePublicJson(
      c,
      key,
      fitByteBudget([dto!], API_PUBLIC_BOUNDS.maxBodyBytes, (trimmed) => trimmed[0]),
    );
  });

  app.get("/api/public/community", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const key = apiPublicCacheKey("GET", "/api/public/community", "");
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // readCounts never throws: missing collectors degrade to nulls, never 0.
    const counts = await readCounts(c.env);
    const payload: CommunitySnapshotDto = {
      member_count: counts.memberCount,
      online_count: counts.onlineCount,
      ranks: counts.ranks.map((rank) => ({
        key: rank.key,
        label: rank.label,
        member_count: rank.memberCount,
      })),
    };
    return servePublicJson(c, key, payload);
  });

  app.get("/api/public/join", async (c) => {
    const refused = await admitted(c);
    if (refused) return refused;
    const key = apiPublicCacheKey("GET", "/api/public/join", "");
    const hit = readApiPublicCache(key);
    if (hit) return cachedEntry(c, hit);
    // Database-free like the /join leaf: the handoff is env config only.
    const payload: JoinHandoffDto = {
      intro: JOIN_INTRO,
      invite_url: inviteDestination(c.env.DISCORD_INVITE_URL),
    };
    return servePublicJson(c, key, payload);
  });

  // Static discovery document, database-free like robots.txt: no admission,
  // no session, unchanged bytes per APP_URL with a long edge TTL.
  app.get("/openapi.json", (c) => {
    c.header("cache-control", "public, max-age=3600");
    return c.json(getOpenApiDocument(c.env.APP_URL));
  });
}
