// W8 public events routes + moderator JSON writes. Ports two-web routes/web.php event
// routes and EventPolicy: drafts 403 for non-moderators, cancelled 410 + noindex,
// /events.json needs a session, writes are moderator-only and enqueue the Discord
// write-back through the same seam as the admin panel (src/admin/writeback.ts).
import type { Context, Hono } from "hono";
import { dbFor } from "../admin/db";
import { NotFoundError, createEvent, getEvent, transitionEvent, updateEvent } from "../admin/store";
import { ValidationError, parseEventForm } from "../admin/validation";
import { dispatchWriteBack } from "../admin/writeback";
import type { Env, Session } from "../env";
import { EventGonePage, EventPage, EventsPage, PastEventsPage } from "./pages";
import { eventIcs, eventsIcsCollection, eventsRss } from "./feeds";
import { JSON_DEFAULT_LIMIT, JSON_MAX_LIMIT, getEventRow, getPublicEvent, listFeed, listJson, listPast, listUpcoming, type PublicEvent } from "./reads";

type Ctx = Context<{ Bindings: Env }>;
type App = Hono<{ Bindings: Env }>;
export type SessionReader = (c: Ctx) => Promise<Session | null>;

const KEY_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

export function eventJson(e: PublicEvent) {
  return {
    event_key: e.eventKey,
    title: e.title,
    game: e.game,
    description: e.description,
    starts_at: e.startsAt.toISOString(),
    ends_at: e.endsAt.toISOString(),
    timezone: e.timezone,
    location: e.location,
    capacity: e.capacity,
    status: e.status,
    rsvp_open: e.rsvpOpen,
    going_count: e.goingCount,
  };
}

function jsonLd(e: PublicEvent, appUrl: string): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.title,
    startDate: e.startsAt.toISOString(),
    endDate: e.endsAt.toISOString(),
    eventStatus: e.status === "cancelled" ? "https://schema.org/EventCancelled" : "https://schema.org/EventScheduled",
    location: { "@type": "VirtualLocation", url: e.location && /^https?:/.test(e.location) ? e.location : appUrl },
    ...(e.description ? { description: e.description } : {}),
    url: `${appUrl}/e/${e.eventKey}`,
  };
  // `<` escaped so a title can never close the script element.
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}

async function etagFor(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

async function sha256Etag(body: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body));
  return `"${[...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("")}"`;
}

/** Strong validator over the bytes; 304 on a matching If-None-Match. Sessionless: sets no cookie. */
async function feedResponse(c: Ctx, body: string, headers: Record<string, string>): Promise<Response> {
  const etag = await sha256Etag(body);
  const inm = c.req.header("if-none-match");
  if (inm && inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": headers["cache-control"]! } });
  }
  return new Response(body, { status: 200, headers: { ...headers, etag } });
}

export function registerEventRoutes(app: App, readSession: SessionReader): void {
  const unavailable = (c: Ctx) => c.text("Events temporarily unavailable", 503);

  app.get("/events", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    c.header("cache-control", "public, max-age=60");
    return c.html(<EventsPage rows={await listUpcoming(db)} appUrl={c.env.APP_URL} />);
  });

  app.get("/events/past", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const { rows, hasMore, totalPages } = await listPast(db, page);
    c.header("cache-control", "public, max-age=300");
    return c.html(<PastEventsPage rows={rows} page={page} hasMore={hasMore} totalPages={totalPages} appUrl={c.env.APP_URL} />);
  });

  app.get("/events.json", async (c) => {
    const session = await readSession(c);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, JSON_MAX_LIMIT) : JSON_DEFAULT_LIMIT;
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const rows = await listJson(db, { limit, offset: (page - 1) * limit, includeDrafts: session.moderator });
    const body = JSON.stringify({ data: rows.map(eventJson), page, limit });
    const etag = await etagFor(body);
    c.header("cache-control", "private, no-cache");
    c.header("etag", etag);
    if (c.req.header("if-none-match") === etag) return c.body(null, 304);
    return c.body(body, 200, { "content-type": "application/json; charset=UTF-8" });
  });

  app.get("/events.rss", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const rows = await listFeed(db, ["published"]);
    const built = rows.reduce((m, r) => (r.updatedAt > m ? r.updatedAt : m), new Date(0));
    return feedResponse(c, eventsRss(rows, c.env.APP_URL, rows.length ? built : new Date()), {
      "content-type": "application/rss+xml; charset=utf-8",
      "cache-control": "max-age=300, public",
    });
  });

  app.get("/events.ics", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const rows = await listFeed(db, ["published", "cancelled"]);
    return feedResponse(c, eventsIcsCollection(rows, c.env.APP_URL), {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="events.ics"',
      "cache-control": "max-age=300, public",
    });
  });

  // Same view policy as /e/:key: drafts are moderator-only; cancelled/past download fine.
  app.get("/events/:file{.+\\.ics}", async (c) => {
    const key = c.req.param("file").slice(0, -4);
    if (!KEY_RE.test(key)) return c.notFound();
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const e = await getEventRow(db, key);
    if (!e) return c.notFound();
    if (e.status === "draft") {
      const session = await readSession(c);
      if (!session?.moderator) return c.text("Forbidden", 403);
    }
    return feedResponse(c, eventIcs(e, c.env.APP_URL), {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${e.eventKey}.ics"`,
      "cache-control": "max-age=300, private",
    });
  });

  app.get("/e/:key", async (c) => {
    const key = c.req.param("key");
    if (!KEY_RE.test(key)) return c.notFound();
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const e = await getPublicEvent(db, key);
    if (!e) return c.notFound();
    if (e.status === "draft") {
      const session = await readSession(c);
      if (!session?.moderator) return c.text("Forbidden", 403);
      c.header("cache-control", "private, no-store");
    } else if (e.status === "cancelled") {
      c.header("x-robots-tag", "noindex");
      return c.html(<EventGonePage />, 410);
    } else {
      c.header("cache-control", "public, max-age=60");
    }
    return c.html(<EventPage e={e} appUrl={c.env.APP_URL} jsonLd={jsonLd(e, c.env.APP_URL)} />);
  });

  // ---- moderator writes (JSON) ------------------------------------------------
  // Same origin rule as /logout: SameSite=Lax already blocks cross-site sends.
  async function moderator(c: Ctx): Promise<Session | Response> {
    const origin = c.req.header("origin");
    if (origin && origin !== c.env.APP_URL) return c.text("Forbidden", 403);
    const session = await readSession(c);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    if (!session.moderator) return c.json({ error: "forbidden" }, 403);
    return session;
  }

  async function body(c: Ctx): Promise<Record<string, unknown>> {
    const ct = c.req.header("content-type") ?? "";
    if (ct.includes("application/json")) {
      const j = await c.req.json().catch(() => null);
      return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    }
    return (await c.req.parseBody()) as Record<string, unknown>;
  }

  const invalid = (c: Ctx, err: ValidationError) => c.json({ error: "invalid", fields: err.fields }, 422);

  app.post("/events", async (c) => {
    const who = await moderator(c);
    if (who instanceof Response) return who;
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    try {
      const { row } = await createEvent(db, { id: who.id, username: who.username }, parseEventForm(await body(c)));
      return c.json({ data: eventJson({ ...row, goingCount: 0 }) }, 201);
    } catch (err) {
      if (err instanceof ValidationError) return invalid(c, err);
      throw err;
    }
  });

  app.patch("/events/:key", async (c) => {
    const who = await moderator(c);
    if (who instanceof Response) return who;
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    const key = c.req.param("key");
    const existing = await getEvent(db, key);
    if (!existing) return c.json({ error: "not_found" }, 404);
    // PATCH: unspecified fields keep their stored value.
    const patch = await body(c);
    const merged = {
      title: existing.title,
      game: existing.game,
      description: existing.description,
      timezone: existing.timezone,
      location: existing.location,
      capacity: existing.capacity,
      ...patch,
    } as Record<string, unknown>;
    const tz = String(merged.timezone);
    const wall = (d: Date) => new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "short" }).format(d);
    merged.starts_at ??= wall(existing.startsAt);
    merged.ends_at ??= wall(existing.endsAt);
    try {
      const input = parseEventForm(merged, {
        startsAtUtc: existing.startsAt.toISOString(),
        endsAtUtc: existing.endsAt.toISOString(),
      });
      const { row, writeBack } = await updateEvent(db, { id: who.id, username: who.username }, key, input);
      if (writeBack) await dispatchWriteBack(c.env, writeBack);
      return c.json({ data: eventJson({ ...row, goingCount: 0 }) });
    } catch (err) {
      if (err instanceof ValidationError) return invalid(c, err);
      if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
      throw err;
    }
  });

  for (const action of ["publish", "cancel"] as const) {
    app.post(`/events/:key/${action}`, async (c) => {
      const who = await moderator(c);
      if (who instanceof Response) return who;
      const db = await dbFor(c);
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      try {
        const { row, writeBack } = await transitionEvent(
          db,
          { id: who.id, username: who.username },
          c.req.param("key"),
          action === "publish" ? "published" : "cancelled",
        );
        if (writeBack) await dispatchWriteBack(c.env, writeBack);
        return c.json({ data: eventJson({ ...row, goingCount: 0 }) });
      } catch (err) {
        if (err instanceof ValidationError) return invalid(c, err);
        if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
        throw err;
      }
    });
  }
}
