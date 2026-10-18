// Feeds/sitemap event routes: GET /events.rss, GET /events.ics and
// GET /events/:file.ics. Split out of src/events/routes.tsx; unchanged.
import { dbFor } from "../admin/db";
import { isDatabaseUnavailable } from "../db/errors";
import { databaseUnavailable, notFoundHandler } from "../errors";
import { eventsIcsCollection, eventsRss } from "./feeds";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { getEventRow, listFeed } from "./reads";
import {
  eventsUnavailable,
  matchesIfNoneMatch,
  publicReadGuard,
  type App,
  type Ctx,
  type SessionReader,
} from "./routes-shared";

async function sha256Etag(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Strong validator over the bytes; preserve queued headers, but never read or issue a session here. */
async function feedResponse(
  c: Ctx,
  body: string,
  headers: Record<string, string>,
): Promise<Response> {
  const etag = await sha256Etag(body);
  if (matchesIfNoneMatch(c.req.header("if-none-match"), etag)) {
    return c.body(null, 304, { etag, "cache-control": headers["cache-control"]! });
  }
  return c.body(body, 200, { ...headers, etag });
}

export function registerFeedRoutes(app: App, readSession: SessionReader): void {
  app.get("/events.rss", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const rows = await listFeed(db, ["published"]);
    const built = rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), new Date(0));
    return feedResponse(c, eventsRss(rows, c.env.APP_URL, built), {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "max-age=300, public",
    });
  });

  app.get("/events.ics", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const rows = await listFeed(db, ["published", "cancelled"]);
    return feedResponse(c, eventsIcsCollection(rows, c.env.APP_URL), {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="events.ics"',
      "cache-control": "max-age=300, public",
    });
  });

  // Same view policy as /e/:key: drafts are moderator-only; cancelled/past download fine.
  // Missing keys use the branded 404 (suggestions + noindex), never bare plaintext.
  app.get("/events/:file{.+\\.ics}", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const key = c.req.param("file").slice(0, -4);
    // One canonical key form per event, mirroring /e/:key: a valid key in
    // another letter case 301s to the canonical URL before any read.
    // Seed/demo keys and unparsable keys keep their current path (forged
    // keys still refuse, unknown keys still 404).
    const canonical = canonicalEventKey(key);
    if (canonical && canonical !== key) {
      const search = new URL(c.req.url).search;
      return c.redirect(`/events/${encodeURIComponent(canonical)}.ics${search}`, 301);
    }
    if (!eventKeyAllowed(key, c.env.APP_URL)) {
      c.header("x-robots-tag", "noindex, nofollow");
      return notFoundHandler(c);
    }
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const e = await getEventRow(db, key);
    if (!e) {
      c.header("x-robots-tag", "noindex, nofollow");
      return notFoundHandler(c);
    }
    if (e.status === "draft") {
      let session;
      try {
        session = await readSession(c);
      } catch (err) {
        // Rotation errors arrive already normalized (classified outage or
        // plain Error) and answer 503, never a silent guest; rotate resolving
        // false (row ineligible) already returned null and stays the 403
        // guest refusal below. Named non-outage exceptions are genuine
        // programming errors, not outages, so they rethrow to 500 like home.
        // Class-only log: driver messages can carry DSN fragments.
        if (err instanceof Error && err.name !== "Error" && !isDatabaseUnavailable(err)) throw err;
        console.error("draft ICS could not resolve the session; refusing.", {
          exception: err instanceof Error ? err.constructor.name : "unknown",
        });
        return databaseUnavailable(c);
      }
      if (!session?.moderator) return c.text("Forbidden", 403);
    }
    // A sequence-poison row degrades like the collection (skipped with a
    // logged count, serving an event-less calendar) instead of 503ing. Valid
    // rows render byte-identically to eventIcs.
    return feedResponse(c, eventsIcsCollection([e], c.env.APP_URL), {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${e.eventKey}.ics"`,
      "cache-control": "max-age=300, private",
    });
  });
}
