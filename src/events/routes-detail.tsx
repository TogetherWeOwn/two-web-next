// Detail event routes: GET /events/:key (JSON) and GET /e/:key (HTML).
// Split out of src/events/routes.tsx; behavior unchanged.
import { dbFor } from "../admin/db";
import { databaseUnavailable, NotFoundPage } from "../errors";
import { bufferedMemberHtml, bufferedMemberText, memberReadBoundary } from "../member-reads";
import { readJoinResult, takeJoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { notFoundSuggestions } from "./suggestions";
import {
  getEventNeighbors,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
  type PublicEvent,
} from "./reads";
import { waitlistPosition } from "./waitlist";
import { recordAccess } from "../admin/store";
import { EventGonePage, EventPage } from "./pages";
import {
  eventJson,
  jsonResponse,
  jsonSession,
  publicReadGuard,
  type App,
  type SessionReader,
} from "./routes-shared";

function jsonLd(e: PublicEvent, appUrl: string): string {
  const ld = {
    "@context": "https://schema.org",
    "@type": "Event",
    name: e.title,
    startDate: e.startsAt.toISOString(),
    endDate: e.endsAt.toISOString(),
    eventStatus:
      e.status === "cancelled"
        ? "https://schema.org/EventCancelled"
        : "https://schema.org/EventScheduled",
    location: {
      "@type": "VirtualLocation",
      url: e.location && /^https?:/.test(e.location) ? e.location : appUrl,
    },
    ...(e.description ? { description: e.description } : {}),
    url: canonicalUrl(appUrl, `/e/${e.eventKey}`),
  };
  // `<` escaped so a title can never close the script element.
  return JSON.stringify(ld).replace(/</g, "\\u003c");
}

export function registerDetailRoutes(
  app: App,
  readSession: SessionReader,
  readFragmentSession: SessionReader,
): void {
  app.get("/events/:key", async (c) => {
    const key = c.req.param("key");
    // One canonical key form per event, mirroring /e/:key: a valid key in
    // another letter case 301s to the canonical URL before any read.
    // Seed/demo keys and unparsable keys keep their current path (forged
    // keys still refuse, unknown keys still 404).
    const canonical = canonicalEventKey(key);
    if (canonical && canonical !== key) {
      const search = new URL(c.req.url).search;
      return c.redirect(`/events/${encodeURIComponent(canonical)}${search}`, 301);
    }
    const session = await jsonSession(c, readFragmentSession);
    if (session instanceof Response) return session;
    if (!eventKeyAllowed(key, c.env.APP_URL)) return c.json({ error: "not_found" }, 404);
    const db = await dbFor(c);
    if (!db) return c.json({ error: "db_unavailable" }, 503);
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
  });

  app.get("/e/:key", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    let viewer: string | null = null;
    // Observe the entire existing handler, not only the attendee helper. An
    // anonymous viewer can release classified public records, never member keys.
    c.header("vary", "Cookie");
    await memberReadBoundary(
      c,
      () => ({ viewer, resource: "member", action: "list", route: "events.page" }),
      async (entry) => {
        const db = await dbFor(c);
        if (!db) throw new Error("Event audit database unavailable");
        return recordAccess(db, entry);
      },
      async () => {
        const notFound = async () => {
          c.header("x-robots-tag", "noindex, nofollow");
          return bufferedMemberHtml(
            c,
            <NotFoundPage suggestions={await notFoundSuggestions(c.env)} />,
            404,
          );
        };
        const render = async () => {
          const key = c.req.param("key") ?? "";
          // One canonical key form per event: ULIDs are stored uppercase, so
          // a valid key in another letter case 301s to the canonical URL
          // before any read. Seed/demo keys and unparsable keys keep their
          // current path (forged keys refuse, unknown keys 404).
          const canonical = canonicalEventKey(key);
          if (canonical && canonical !== key) {
            c.header("location", `/e/${encodeURIComponent(canonical)}${new URL(c.req.url).search}`);
            return bufferedMemberText(c, "", 301);
          }
          if (!eventKeyAllowed(key, c.env.APP_URL)) return notFound();
          const db = await dbFor(c);
          if (!db) return bufferedMemberText(c, "Events temporarily unavailable", 503);
          const e = await getPublicEvent(db, key);
          if (!e) return notFound();
          if (e.status === "cancelled") {
            c.header("x-robots-tag", "noindex, nofollow");
            // The live page personalizes on the session and the one-shot join
            // confirmation, so it is never share-cached (main W16) and always
            // varies on the cookie (TOG-10356 finding 5). The cancelled page is
            // viewer-independent: it renders before any session read, so a
            // store outage or a rotated cookie can never turn the static
            // cancellation into a 500 (TOG-10356 review).
            c.header("cache-control", "private, no-store");
            return bufferedMemberHtml(
              c,
              <EventGonePage e={e} jsonLd={jsonLd(e, c.env.APP_URL)} />,
              410,
            );
          }
          const session = await readSession(c);
          viewer = session?.id ?? null;
          if (e.status === "draft" && !session?.moderator)
            return bufferedMemberText(c, "Forbidden", 403);
          if (e.status === "draft" || e.status === "past")
            c.header("x-robots-tag", "noindex, nofollow");
          // One-shot join confirmation (legacy join_result flash): the event
          // page is a join-CTA landing (`/join?next=/e/<key>`), so it consumes
          // and renders the banner exactly once like /, /join and /profile.
          // Read inside the boundary (audited reads defer consumption), then
          // consume only after the boundary allows a visible response.
          const joinResult = await readJoinResult(c);
          const member = session?.member === true;
          const [neighbors, related, attendees, position, answer] = await Promise.all([
            getEventNeighbors(db, e),
            listRelatedEvents(db, e),
            session?.member ? listGoingAttendees(db, e.id) : Promise.resolve([]),
            session ? waitlistPosition(db, e.id, session.id) : Promise.resolve(null),
            session && member ? getViewerRsvp(db, e.id, session.id) : Promise.resolve(null),
          ]);
          const returnTo = c.req.path + new URL(c.req.url).search;
          return bufferedMemberHtml(
            c,
            <EventPage
              e={e}
              neighbors={neighbors}
              related={related}
              attendees={attendees}
              appUrl={c.env.APP_URL}
              jsonLd={jsonLd(e, c.env.APP_URL)}
              session={session}
              joinResult={joinResult}
              waitlistPosition={position}
              member={member}
              answer={answer}
              returnTo={returnTo}
            />,
          );
        };
        await render();
      },
      databaseUnavailable,
    );
    // Consume only after the keyed boundary allows a visible response.
    if (c.res.status === 200) await takeJoinResult(c);
    return c.res;
  });
}
