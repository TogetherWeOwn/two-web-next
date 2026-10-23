// Detail event routes: GET /events/:key (JSON) and GET /e/:key (HTML).
// Split out of src/events/routes.tsx; behavior unchanged.
import { dbFor } from "../admin/db";
import {
  databaseUnavailable,
  databaseUnavailableBuffered,
  forbidden,
  NotFoundPage,
} from "../errors";
import { bufferedMemberHtml, bufferedMemberText, memberReadBoundary } from "../member-reads";
import { readJoinResult, takeJoinResult } from "../return-journey";
import { eventJsonLd, siteJsonLd } from "../seo-json-ld";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import {
  ATTENDEE_PAGE_SIZE,
  attendeePageHref,
  getEventNeighbors,
  getEventSeriesContext,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
  nextAttendeePage,
  parseAttendeePageParam,
  type EventLink,
  type EventNeighbors,
  type EventSeriesContext,
  type PublicEvent,
} from "./reads";
import { waitlistPosition } from "./waitlist";
import { recordAccess } from "../admin/store";
import { EventGonePage, EventPage } from "./pages";
import {
  dbUnavailableJson,
  eventJson,
  jsonResponse,
  jsonSession,
  publicReadGuard,
  type App,
  type SessionReader,
} from "./routes-shared";

// The per-event block stays a top-level Event (existing readers pin that
// shape) with a stable @id, organizer reference and attendance mode; the
// shared site identities travel in a second block (see pages-shared).
function jsonLd(e: PublicEvent, appUrl: string): string {
  return eventJsonLd(e, appUrl);
}

function siteIdentities(appUrl: string): string {
  return siteJsonLd(appUrl);
}

export function registerDetailRoutes(
  app: App,
  readSession: SessionReader,
  readFragmentSession: SessionReader,
): void {
  app.get("/events/:key", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
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
          // Same per-isolate, DB-source-scoped cached guest snapshot as
          // ordinary 404s: one fill per TTL, never one Postgres
          // transaction per probe.
          return bufferedMemberHtml(
            c,
            <NotFoundPage suggestions={await cachedNotFoundSuggestions(c.env, c.req.path)} />,
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
          if (!db) return databaseUnavailableBuffered(c);
          const e = await getPublicEvent(db, key);
          if (!e) return notFound();
          if (e.status === "cancelled") {
            c.header("x-robots-tag", "noindex, nofollow");
            // The live page personalizes on the session and the one-shot join
            // confirmation, so it is never share-cached (main W16) and always
            // varies on the cookie (TOG-10356 finding 5). The cancelled page is
            // viewer-independent: it renders before any session read, so a
            // store outage or a rotated cookie can never turn the static
            // cancellation into a 500 (TOG-10356 review). The alternatives
            // lookup degrades to an empty list when it fails (mirroring the
            // Kit gone model), so a related-read outage keeps the 410 with its
            // calendar download instead of becoming a 500.
            c.header("cache-control", "private, no-store");
            let related: EventLink[] = [];
            try {
              related = await listRelatedEvents(db, e);
            } catch {
              related = [];
            }
            return bufferedMemberHtml(
              c,
              <EventGonePage
                e={e}
                related={related}
                jsonLd={jsonLd(e, c.env.APP_URL)}
                siteJsonLd={siteIdentities(c.env.APP_URL)}
              />,
              410,
            );
          }
          // Non-rotating fragment read: the attendees-live island re-reads
          // this page after the member's own RSVP while the reloadable page
          // view (and any in-flight write response) still holds the current
          // bearer. Rotation mints single-use tokens, so a rotating fragment
          // read racing the reload would leave exactly one winner and render
          // the loser as a guest. Same x-two-island contract as the
          // events-calendar fragment (routes-calendar.tsx).
          const session =
            c.req.header("x-two-island") === "attendees-live"
              ? await readFragmentSession(c)
              : await readSession(c);
          viewer = session?.id ?? null;
          if (e.status === "draft" && !session?.moderator) return forbidden(c);
          if (e.status === "draft" || e.status === "past")
            c.header("x-robots-tag", "noindex, nofollow");
          // One-shot join confirmation (legacy join_result flash): the event
          // page is a join-CTA landing (`/join?next=/e/<key>`), so it consumes
          // and renders the banner exactly once like /, /join and /profile.
          // Read inside the boundary (audited reads defer consumption), then
          // consume only after the boundary allows a visible response.
          const joinResult = await readJoinResult(c);
          const member = session?.member === true;
          // Bounded member attendee window: the requested page plus the first
          // row of the next page (lookahead, never rendered) that powers Next.
          // Both go through the keyed read, so every retrieved identity —
          // lookahead included — is audited before any private bytes release.
          const attendeePage = parseAttendeePageParam(c.req.query("attendees"));
          // Decorative reads fail open: a flaky neighbors/related lookup
          // settles to its empty shape instead of 503ing the whole page.
          // The page already renders both shapes (a lone event has null
          // neighbors; an event with no siblings has an empty related
          // rail), and both reads stay nonSensitive published-only, so no
          // private bytes release and no audit row is skipped. Viewer reads
          // below stay closed: their throws still refuse.
          const neighborsSettled = getEventNeighbors(db, e).then(
            (neighbors) => neighbors,
            (): EventNeighbors => ({ previous: null, next: null }),
          );
          const relatedSettled = listRelatedEvents(db, e).then(
            (related) => related,
            (): EventLink[] => [],
          );
          const seriesSettled = getEventSeriesContext(db, e).then(
            (series) => series,
            (): EventSeriesContext | null => null,
          );
          const [neighbors, related, series, attendees, position, answer] = await Promise.all([
            neighborsSettled,
            relatedSettled,
            seriesSettled,
            session?.member ? listGoingAttendees(db, e.id, attendeePage) : Promise.resolve([]),
            session ? waitlistPosition(db, e.id, session.id) : Promise.resolve(null),
            session && member ? getViewerRsvp(db, e.id, session.id) : Promise.resolve(null),
          ]);
          // One-row lookahead probe that powers Next, only from a full page:
          // a partial page cannot have a successor, so the probe (and its
          // audit subject) is skipped there.
          const attendeeLookahead =
            session?.member && attendees.length === ATTENDEE_PAGE_SIZE
              ? await listGoingAttendees(db, e.id, nextAttendeePage(attendeePage), 1)
              : [];
          // An empty past-end page links back to page one (the bare URL):
          // page N-1 may itself be empty, stranding the viewer on empty
          // pages. Guests never render this section, so the value is inert
          // for them.
          const attendeesPaging = {
            page: attendeePage,
            prevHref:
              attendeePage > 1
                ? attendeePageHref(e.eventKey, attendees.length === 0 ? 1 : attendeePage - 1)
                : null,
            nextHref:
              attendeeLookahead.length > 0 ? attendeePageHref(e.eventKey, attendeePage + 1) : null,
          };
          const returnTo = c.req.path + new URL(c.req.url).search;
          return bufferedMemberHtml(
            c,
            <EventPage
              e={e}
              neighbors={neighbors}
              related={related}
              series={series}
              attendees={attendees}
              attendeesPaging={attendeesPaging}
              appUrl={c.env.APP_URL}
              jsonLd={jsonLd(e, c.env.APP_URL)}
              siteJsonLd={siteIdentities(c.env.APP_URL)}
              session={session}
              joinResult={joinResult}
              waitlistPosition={position}
              member={member}
              answer={answer}
              returnTo={returnTo}
              attendeePage={attendeePage}
              // Drafts have no Markdown view: the session-free .md route 403s
              // for every viewer, so only link it where it answers 200.
              markdownAlternate={e.status === "draft" ? undefined : `/e/${e.eventKey}.md`}
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
