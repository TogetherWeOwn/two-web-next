// JSON/ETag event routes: GET /events.json. Split out of
// src/events/routes.tsx; publishes the same bounded projection to every session.
import { dbFor } from "../admin/db";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { JSON_DEFAULT_LIMIT, JSON_MAX_LIMIT, listJson } from "./reads";
import type { PublicEventCollectionDto } from "../public-data/contracts";
import {
  publicEventJson,
  dbUnavailableJson,
  jsonResponse,
  jsonSession,
  type App,
  type SessionReader,
} from "./routes-shared";

export function registerJsonRoutes(app: App, readFragmentSession: SessionReader): void {
  app.get("/events.json", async (c) => {
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
