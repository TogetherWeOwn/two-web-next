// JSON/ETag responses for the event collection and individual events.
import { dbFor } from "../admin/db";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { getPublicEvent, JSON_DEFAULT_LIMIT, JSON_MAX_LIMIT, listJson } from "./reads";
import { waitlistPosition } from "./waitlist";
import type { PublicEventCollectionDto } from "../public-data/contracts";
import {
  publicEventJson,
  dbUnavailableJson,
  eventJson,
  jsonResponse,
  jsonSession,
  type App,
  type Ctx,
  type SessionReader,
  publicReadGuard,
} from "./routes-shared";

export async function eventDetailJson(
  c: Ctx,
  readKey: () => string,
  readFragmentSession: SessionReader,
): Promise<Response> {
  const limited = await publicReadGuard(c);
  if (limited) return limited;
  const key = readKey();
  // Canonicalize ULIDs before session or event reads. Demo keys and
  // unrecognized keys continue to the usual session gate and key check.
  const canonical = canonicalEventKey(key);
  if (canonical && canonical !== key) {
    const search = new URL(c.req.url).search;
    return c.redirect(`/events/${encodeURIComponent(canonical)}${search}`, 301);
  }
  const session = await jsonSession(c, readFragmentSession);
  if (session instanceof Response) return session;
  if (!eventKeyAllowed(key, c.env.APP_URL)) return c.json({ error: "not_found" }, 404);
  const db = await dbFor(c);
  if (!db) return dbUnavailableJson(c);
  const e = await getPublicEvent(db, key);
  if (!e) return c.json({ error: "not_found" }, 404);
  if (e.status === "draft" && !session.moderator) return c.json({ error: "forbidden" }, 403);
  if (e.status === "cancelled")
    return c.json(
      {
        reason: "event_cancelled",
        message: "This event was cancelled.",
        event_key: e.eventKey,
        status: e.status,
      },
      410,
    );
  if (e.status === "draft") c.header("x-robots-tag", "noindex, nofollow");
  const position = await waitlistPosition(db, e.id, session.id);
  return jsonResponse(c, { data: { ...eventJson(e), waitlist_position: position } });
}

export function registerJsonRoutes(app: App, readFragmentSession: SessionReader): void {
  app.get("/events.json", async (c) => {
    // Same shared budget as the sibling pages and feeds, before session and
    // event-store reads. Admitted guests keep the 401; exhausted callers get
    // the shared 429 with no session or DB work.
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const session = await jsonSession(c, readFragmentSession);
    if (session instanceof Response) return session;
    const db = await dbFor(c);
    if (!db) return dbUnavailableJson(c);
    const limitRaw = c.req.query("per_page") ?? c.req.query("limit") ?? "";
    const limit = /^[+-]?\d+$/.test(limitRaw)
      ? Math.max(1, Math.min(Number(limitRaw), JSON_MAX_LIMIT))
      : JSON_DEFAULT_LIMIT;
    const pageRaw = c.req.query("page") ?? "1";
    // Strict like parseAttendeePageParam and the admin table viewers: the full
    // string must be a positive integer (parseInt would accept "2x" as 2).
    // Missing, malformed, nonpositive, fractional, padded or hex values fall
    // back to page 1; listJson still clamps valid past-end pages to the last.
    const page = /^[1-9]\d*$/.test(pageRaw) ? Number(pageRaw) : 1;
    const eventKeyRaw = c.req.query("event_key");
    if (eventKeyRaw !== undefined && !eventKeyAllowed(eventKeyRaw, c.env.APP_URL))
      return c.json({ error: "invalid_event_key" }, 422);
    // ULIDs are stored uppercase: resolve an admitted alias in another letter
    // case to the canonical key before lookup. Seed keys are already canonical
    // (canonicalEventKey is null), so they pass through unchanged.
    const eventKey =
      eventKeyRaw === undefined ? undefined : (canonicalEventKey(eventKeyRaw) ?? eventKeyRaw);
    // listJson bounds the scan to the last page (the COUNT runs first), so
    // the response echoes the clamped page rather than the raw request.
    const {
      rows,
      total,
      page: clamped,
    } = await listJson(db, {
      limit,
      offset: (page - 1) * limit,
      eventKey,
    });
    const data = rows.map(publicEventJson);
    const response: PublicEventCollectionDto = {
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
    return jsonResponse(c, response);
  });
}
