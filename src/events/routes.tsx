// W8 public events routes + moderator JSON writes. Ports two-web routes/web.php event
// routes and EventPolicy: drafts 403 for non-moderators, cancelled 410 + noindex,
// /events.json needs a session, writes are moderator-only and enqueue the Discord
// write-back through the same seam as the admin panel (src/admin/writeback.ts).
import type { Context, Hono } from "hono";
import { dbFor } from "../admin/db";
import { NotFoundError, createEvent, getEvent, recordAccess, setRsvpOpen, transitionEvent, updateEvent } from "../admin/store";
import { memberAccessLog } from "../access-log";
import { ValidationError, parseEventForm } from "../admin/validation";
import { dispatchWriteBack } from "../admin/writeback";
import type { Env, Session } from "../env";
import { matchQuery, recordSearch } from "./search-log";
import { rateLimitExceeded } from "../errors";
import { canonicalUrl } from "../seo";
import { WRITE_THROTTLE_PER_MINUTE, throttle } from "../throttle";
import { discordEventsSource } from "./discord-transients";
import {
  RSVP_HONEY_FIELD,
  rsvpHoneyFilled,
  rsvpTrapTripped,
  calendarEmptyState,
  calendarSearching,
  dedupeTransients,
  eventSearchLogEntry,
  mergeCalendarRows,
  parseCalendarMonth,
  parseCalendarView,
  wallMonth,
  calendarZone,
  currentCalendarMonth,
} from "../islands/contracts";
import { dispatchRsvpSync, isRsvpStatus, withdrawRsvp, writeRsvp, type RsvpAnswer } from "./rsvp";
import { waitlistPosition, waitlistPositions } from "./waitlist";
import { EventGonePage, EventPage, EventsCalendarPage, PastEventsPage } from "./pages";
import { IcsSequenceRangeError, eventIcs, eventsIcsCollection, eventsRss } from "./feeds";
import { JSON_DEFAULT_LIMIT, JSON_MAX_LIMIT, getEventNeighbors, getEventRow, getPublicEvent, listCalendarPast, listFeed, listGoingAttendees, listJson, listPast, listRelatedEvents, listUpcoming, normalizePastPage, persistedDiscordIds, withGoingCount, type PublicEvent } from "./reads";

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
    url: canonicalUrl(appUrl, `/e/${e.eventKey}`),
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
  if (inm && (inm.trim() === "*" || inm.split(",").some((t) => t.trim().replace(/^W\//, "") === etag))) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": headers["cache-control"]! } });
  }
  return new Response(body, { status: 200, headers: { ...headers, etag } });
}

async function calendarFeedResponse(c: Ctx, build: () => string, headers: Record<string, string>): Promise<Response> {
  try {
    return feedResponse(c, build(), headers);
  } catch (error) {
    if (!(error instanceof IcsSequenceRangeError)) throw error;
    return c.text("Calendar revision unavailable", 503, { "cache-control": "no-store" });
  }
}

export function registerEventRoutes(app: App, readSession: SessionReader, readFragmentSession: SessionReader): void {
  const unavailable = (c: Ctx) => c.text("Events temporarily unavailable", 503);

  app.get("/events", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const session = await (c.req.header("x-two-island") === "events-calendar" ? readFragmentSession(c) : readSession(c));
    const now = new Date();

    // Resolve the URL state. A search forces the list view (a month grid that
    // may not contain the matches reads as "no results"); an unknown view
    // keeps the current one, which for a fresh URL means the default list.
    const q = c.req.query("q") ?? "";
    const match = matchQuery(q);
    const searching = match !== null;
    const view = searching ? "list" : (parseCalendarView(c.req.query("view")) ?? "list");
    const past = c.req.query("past") === "1";

    const opts = { includeDrafts: session?.moderator ?? false, search: match };
    const localUpcoming = await listUpcoming(db, now, opts);
    const localPast = await listCalendarPast(db, now, opts);

    // One resolve per request: the rows and the failure flag MUST come from the
    // same source instance (legacy render() comment) or every error reads as
    // "never scheduled". Transients are re-checked against the local clock —
    // a just-ended event cannot linger if the collector goes dark.
    const discord = discordEventsSource(c.env);
    const discordRows = await discord.upcoming(now);
    // Probe only candidate identities, without search/draft/time/pagination
    // predicates. A filtered canonical row must never become a stale transient.
    const persistedIds = await persistedDiscordIds(db, discordRows.map((t) => t.discordId));
    const term = (match ?? "").toLowerCase();
    const transients = dedupeTransients(discordRows, persistedIds).filter((t) =>
      (t.endsAt === null || t.endsAt >= now) &&
      (term === "" || t.title.toLowerCase().includes(term) || (t.description ?? "").toLowerCase().includes(term)),
    );
    const discordFailed = discord.lastReadFailed();
    const upcoming = mergeCalendarRows(localUpcoming, transients);

    const zone = calendarZone([
      ...localUpcoming.map((e) => e.timezone),
      ...localPast.map((e) => e.timezone),
    ]);
    // No month given: open on the first upcoming event's host-zone month, else
    // this month. An unparseable month is a page, never a 500.
    const month =
      parseCalendarMonth(c.req.query("month")) ??
      (upcoming[0] ? wallMonth(upcoming[0].startsAt, "discordId" in upcoming[0] ? zone : upcoming[0].timezone) : null) ??
      currentCalendarMonth(now);

    const state = { view, month, q, past };
    const emptyState = calendarEmptyState({
      searching,
      upcomingEmpty: upcoming.length === 0,
      pastEmpty: localPast.length === 0,
      readFailed: discordFailed,
    });

    // One structured line per rendered search: normalized query + visible
    // count, no identity (legacy EventSearchLogger, TOG-8400). Fail-open.
    if (searching) {
      const visibleCount = upcoming.length + localPast.length;
      await recordSearch(db, q, visibleCount);
      const entry = eventSearchLogEntry(match ?? "", visibleCount);
      if (entry) {
        try {
          console.info("event_search", JSON.stringify(entry));
        } catch {
          /* a down logger is an unrecorded search, never a broken page */
        }
      }
    }

    // Search analytics must run per request, not only on shared-cache misses.
    c.header("cache-control", session || searching ? "private, no-store" : "public, max-age=60");
    if (searching) c.header("x-robots-tag", "noindex, follow");
    c.header("vary", "Cookie, X-Two-Island");
    return c.html(
      <EventsCalendarPage
        state={state}
        upcoming={upcoming}
        past={localPast}
        zone={zone}
        now={now}
        emptyState={emptyState}
        discordFailed={discordFailed}
        member={session?.member ?? false}
        inviteUrl={c.env.DISCORD_INVITE_URL}
        appUrl={c.env.APP_URL}
      />,
    );
  });

  app.get("/events/past", async (c) => {
    const db = await dbFor(c);
    if (!db) return unavailable(c);
    const page = normalizePastPage(Number.parseInt(c.req.query("page") ?? "1", 10));
    const { rows, hasMore, totalPages } = await listPast(db, page);
    c.header("cache-control", "public, max-age=300");
    return c.html(<PastEventsPage rows={rows} page={page} hasMore={hasMore} totalPages={totalPages} appUrl={c.env.APP_URL} />);
  });

  app.get("/events.json", async (c) => {
    // Non-rotating: concurrent writes with one cookie must all authenticate.
    const session = await readFragmentSession(c);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "", 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, JSON_MAX_LIMIT) : JSON_DEFAULT_LIMIT;
    const page = Math.max(1, Number.parseInt(c.req.query("page") ?? "1", 10) || 1);
    const rows = await listJson(db, { limit, offset: (page - 1) * limit, includeDrafts: session.moderator });
    const positions = await waitlistPositions(db, rows.map((row) => row.id), session.id);
    const data = rows.map((row) => ({ ...eventJson(row), waitlist_position: positions.get(row.id) ?? null }));
    const body = JSON.stringify({ data, page, limit });
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
    return calendarFeedResponse(c, () => eventsIcsCollection(rows, c.env.APP_URL), {
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
    return calendarFeedResponse(c, () => eventIcs(e, c.env.APP_URL), {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": `attachment; filename="${e.eventKey}.ics"`,
      "cache-control": "max-age=300, private",
    });
  });

  app.get("/e/:key", memberAccessLog(async (c) => {
    const db = await dbFor(c);
    return db ? (entry) => recordAccess(db, entry) : null;
  }), async (c) => {
    const key = c.req.param("key") ?? "";
    if (!KEY_RE.test(key)) return c.notFound();
    const db = await dbFor(c);
    if (!db) return c.text("Events temporarily unavailable", 503);
    const e = await getPublicEvent(db, key);
    if (!e) return c.notFound();
    if (e.status === "cancelled") {
      c.header("x-robots-tag", "noindex, nofollow");
      return c.html(<EventGonePage e={e} jsonLd={jsonLd(e, c.env.APP_URL)} />, 410);
    }
    // The guest join pitch and waitlist position depend on the viewer; never share-cache this HTML.
    c.header("cache-control", "private, no-store");
    c.header("vary", "Cookie");
    // The injected reader uses only bindings/cookies; this route additionally
    // carries the access middleware's request-local variables.
    const session = await readSession(c as unknown as Ctx);
    if (e.status === "draft" && !session?.moderator) return c.text("Forbidden", 403);
    if (e.status === "draft" || e.status === "past") c.header("x-robots-tag", "noindex, nofollow");
    const [neighbors, related, attendees, position] = await Promise.all([
      getEventNeighbors(db, e),
      listRelatedEvents(db, e),
      session?.member ? listGoingAttendees(db, e.id) : Promise.resolve([]),
      session ? waitlistPosition(db, e.id, session.id) : Promise.resolve(null),
    ]);
    if (attendees.length > 0 && session) {
      c.set("viewerId", session.id);
      c.set("access", { resource: "member", action: "list", route: "events.page", subjects: attendees.map((attendee) => attendee.id) });
    }
    return c.html(<EventPage e={e} neighbors={neighbors} related={related} attendees={attendees} appUrl={c.env.APP_URL} jsonLd={jsonLd(e, c.env.APP_URL)} session={session} waitlistPosition={position} />);
  });

  // ---- moderator writes (JSON) ------------------------------------------------
  async function moderator(c: Ctx): Promise<Session | Response> {
    // Non-rotating: concurrent writes with one cookie must all authenticate.
    const session = await readFragmentSession(c);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    if (!session.moderator) return c.json({ error: "forbidden" }, 403);
    return session;
  }

  async function body(c: Ctx): Promise<Record<string, unknown>> {
    // Media types are case-insensitive (RFC 2045 §5.1): normalize before the
    // JSON check so `Application/Json` cannot smuggle a body past the trap.
    // Forms parse with all values preserved: duplicate keys arrive as arrays
    // (first-wins would let a filled duplicate hide behind an empty sibling).
    const ct = (c.req.header("content-type") ?? "").toLowerCase();
    if (ct.includes("application/json")) {
      const j = await c.req.json().catch(() => null);
      return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    }
    return (await c.req.parseBody({ all: true })) as Record<string, unknown>;
  }

  const invalid = (c: Ctx, err: ValidationError) => c.json({ error: "invalid", fields: err.fields }, 422);

  app.post("/events", throttle("event-write", WRITE_THROTTLE_PER_MINUTE), async (c) => {
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

  app.patch("/events/:key", throttle("event-write", WRITE_THROTTLE_PER_MINUTE), async (c) => {
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
      const { row, writeBack, childWriteBacks } = await updateEvent(db, { id: who.id, username: who.username }, key, input);
      if (writeBack) await dispatchWriteBack(c.env, writeBack);
      for (const wb of childWriteBacks) await dispatchWriteBack(c.env, wb);
      const updated = await getPublicEvent(db, row.eventKey);
      return c.json({ data: eventJson(updated!) });
    } catch (err) {
      if (err instanceof ValidationError) return invalid(c, err);
      if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
      throw err;
    }
  });

  for (const action of ["publish", "cancel", "rsvp-pause", "rsvp-reopen"] as const) {
    app.post(`/events/:key/${action}`, throttle("event-write", WRITE_THROTTLE_PER_MINUTE), async (c) => {
      const who = await moderator(c);
      if (who instanceof Response) return who;
      const db = await dbFor(c);
      if (!db) return c.json({ error: "db_unavailable" }, 503);
      try {
        const actor = { id: who.id, username: who.username };
        const key = c.req.param("key");
        const { row, writeBack } = action === "rsvp-pause" || action === "rsvp-reopen"
          ? await setRsvpOpen(db, actor, key, action === "rsvp-reopen")
          : await transitionEvent(db, actor, key, action === "publish" ? "published" : "cancelled");
        if (writeBack) await dispatchWriteBack(c.env, writeBack);
        return c.json({ data: eventJson(await withGoingCount(db, row)) });
      } catch (err) {
        if (err instanceof ValidationError) return invalid(c, err);
        if (err instanceof NotFoundError) return c.json({ error: "not_found" }, 404);
        throw err;
      }
    });
  }

  // ---- RSVP (member writes, W9) ---------------------------------------------------
  // One answer per member per event: a singular resource. PUT 201 first / 200 re-answer,
  // DELETE 204 always (quiet), any other verb 405. One shared 12/min budget per member.
  const rsvpBody = (a: RsvpAnswer) => ({ data: {
    status: a.status,
    synced_to_discord_at: a.syncedToDiscordAt?.toISOString() ?? null,
    waitlist_position: a.waitlistPosition,
  } });
  const closed = (c: Ctx, why: string) => c.json({ reason: "event_not_open", why, message: "This event is not taking RSVPs." }, 403);

  async function member(c: Ctx): Promise<Session | Response> {
    // Non-rotating: concurrent writes with one cookie must all authenticate.
    const session = await readFragmentSession(c);
    if (!session) return c.json({ error: "unauthenticated" }, 401);
    if (!session.member) return c.json({ error: "forbidden" }, 403);
    return session;
  }

  app.put("/events/:key/rsvp", async (c) => {
    c.header("cache-control", "private, no-store");
    const input = await body(c);
    // Decoy (TOG-8715): a filled honeypot answers the byte-identical first-write success
    // without touching limiter, auth or DB, and logs nothing. Present non-string
    // values count as filled (fail-closed); absent/empty inputs are genuine.
    if (rsvpTrapTripped(input)) {
      return c.json(rsvpBody({ status: isRsvpStatus(input.status) ? input.status : "going", syncedToDiscordAt: null, waitlistPosition: null }), 201);
    }
    const who = await member(c);
    if (who instanceof Response) return who;
    if (!isRsvpStatus(input.status)) return c.json({ error: "invalid", fields: { status: ["status is invalid"] } }, 422);
    // Accepted, then refused: answering for the caller instead would look like it worked.
    if (input.user_id !== undefined && String(input.user_id) !== who.id) return c.json({ error: "forbidden" }, 403);
    const key = c.req.param("key");
    if (!KEY_RE.test(key)) return c.json({ error: "not_found" }, 404);
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    // Policy, clock and budget are decided inside writeRsvp, after all blocking waits
    // (member/event/RSVP-row locks and the throttle prune), as in Laravel: a refused
    // write does not spend an attempt. No pre-lock check here — a stale read could
    // refuse a write that is open by the time the locks are held.
    const r = await writeRsvp(db, key, who.id, input.status);
    if (!r.ok) {
      if (r.reason === "limited") return rateLimitExceeded(c, r.retryAfter);
      if (r.reason === "not_found") return c.json({ error: "not_found" }, 404);
      return closed(c, r.why);
    }
    await dispatchRsvpSync(c.env, r.eventKey, r.mirrored);
    return c.json(rsvpBody(r.answer), r.created ? 201 : 200);
  });

  app.delete("/events/:key/rsvp", async (c) => {
    c.header("cache-control", "private, no-store");
    // Both sources are evaluated independently, with ALL values preserved:
    // `query()` is first-wins, so duplicates use `queries()` — an empty query
    // value must not mask a filled sibling or a filled body decoy, and a
    // non-string body value trips like a filled string.
    const queryHoney = c.req.queries(RSVP_HONEY_FIELD);
    const bodyHoney = (await body(c).catch(() => ({} as Record<string, unknown>)))[RSVP_HONEY_FIELD];
    if (rsvpHoneyFilled(queryHoney) || rsvpHoneyFilled(bodyHoney)) return c.body(null, 204);
    const who = await member(c);
    if (who instanceof Response) return who;
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
    // Only the caller's own row is reachable: the delete is keyed on the session user.
    // The budget is charged inside withdrawRsvp, atomically with the delete.
    const key = c.req.param("key");
    const r = await withdrawRsvp(db, KEY_RE.test(key) ? key : "", who.id);
    if (r.limited) return rateLimitExceeded(c, r.retryAfter);
    await dispatchRsvpSync(c.env, key, r.status);
    return c.body(null, 204);
  });

  app.all("/events/:key/rsvp", (c) => c.body(null, 405, { Allow: "PUT, DELETE" }));
}
