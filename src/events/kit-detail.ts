// Kit read model for the live GET /e/:key detail: published, past and
// moderator draft rows with member-only attendee disclosure.
//
// SvelteKit-free so the root suite pins it without a SvelteKit transform: the
// future +page.server.ts load maps these outcomes onto redirect()/error() and
// runs inside the hook's memberReadResponse boundary, which audits the
// declared attendee subjects before any bytes leave. The manifest entry stays
// disabled until the RSVP companion (card 26/43) passes, so Hono keeps
// serving; GET /events/:key JSON and the ICS feed stay Hono-owned with no
// manifest entries and no JSON here. The gone/missing outcomes carry the
// #838 state models (src/kit-event-states.ts) so the route-level error page
// renders the branded presentations with the served statuses, never the
// generic shell.
//
// Gate order mirrors src/events/routes-detail.tsx: canonical redirect before
// any read, key admission before lookup, cancelled before any session-gated
// read, draft stays forbidden without the moderator bit, an indeterminate
// session is unavailable (never a false logout, never a guest render of
// member state), and every database failure is a 503 before bytes.
import { dbFor } from "../admin/db";
import type { Db } from "../db/index";
import type { Env } from "../env";
import type { RsvpClosedReason } from "../islands/contracts";
import type { KitRequestSession } from "../kit-session";
import type {
  EventGoneModel,
  EventMissingModel,
  EventMissingSuggestion,
} from "../kit-event-states";
import { kitPublicReadGuard } from "../kit-past-events";
import { declareMemberResult } from "../member-reads";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { eventJsonLd, siteJsonLd } from "../seo-json-ld";
import { isValidZone } from "./date-format";
import { googleCalendarUrl, isWireInstant } from "./feeds";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { fmt } from "./pages-shared";
import {
  ATTENDEE_PAGE_SIZE,
  attendeePageHref,
  getEventNeighbors,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
  nextAttendeePage,
  parseAttendeePageParam,
  type EventAttendee,
  type EventLink,
  type EventNeighbors,
  type PublicEvent,
  type ViewerRsvp,
} from "./reads";
import type { SuggestedEvent } from "./suggestions";
import { waitlistPosition } from "./waitlist";

export interface KitEventDetailStore {
  dbForFn: (ctx: { env: Env }) => Promise<Db | null>;
  getEventFn: (db: Db, key: string) => Promise<PublicEvent | null>;
  neighborsFn: (db: Db, event: Pick<PublicEvent, "id">) => Promise<EventNeighbors>;
  relatedFn: (db: Db, event: Pick<PublicEvent, "id" | "game">) => Promise<EventLink[]>;
  /** Bounded attendee window for one native page: the page plus the first row
   * of the next page (lookahead, never rendered) that powers Next. */
  attendeesFn: (db: Db, eventId: number, page: number) => Promise<EventAttendee[]>;
  viewerRsvpFn: (db: Db, eventId: number, userId: string) => Promise<ViewerRsvp | null>;
  waitlistFn: (db: Db, eventId: number, userId: string | null) => Promise<number | null>;
  suggestionsFn: (env: Env, path: string) => Promise<SuggestedEvent[]>;
}

export interface KitEventDetailRequest {
  /** Raw :key param, exactly as routed. */
  key: string;
  /** Raw query string with its leading "?", or "". */
  search: string;
  /** Request path, for suggestion scoping. */
  path: string;
  env: Env;
  /** Bridged session from locals: unknown is an outage, never a logout. */
  session: KitRequestSession;
  /** Bridged flash peek: the load deletes the cookie on the 200 GET that
   * renders the banner (eventDetailConsumesFlash), so a Kit read never replays it. */
  joinResult: JoinResult | null;
  /** Called exactly once per resolution: SvelteKit throws on a double-set. */
  setHeaders: (headers: Record<string, string>) => void;
  store: KitEventDetailStore;
}

export interface KitEventDetailLink {
  key: string;
  title: string;
  whenText: string;
  datetime: string;
  location: string | null;
}

export interface KitEventDetailModel {
  eventKey: string;
  title: string;
  game: string | null;
  /** Raw organizer copy: the About section renders only when set. */
  description: string | null;
  /** Meta/share copy: the served fallback when the event has no description. */
  shareDescription: string;
  location: string | null;
  status: string;
  isDraft: boolean;
  isPast: boolean;
  goingCount: number;
  /** Seat occupancy for full/spots/CTA; required so a missed wiring fails typecheck. */
  goingOccupancy: number;
  capacity: number | null;
  rsvpOpen: boolean;
  /** Server-decided RSVP closure at render: the RsvpButton twin's verdict
   * (draft, or past for non-published rows and endsAt at or before the
   * server instant), or null when the control stays open. The view renders
   * this verbatim and never compares endsAt to the viewer clock. Cancelled
   * rows return the gone outcome, so "cancelled" never appears here. */
  rsvpClosed: RsvpClosedReason | null;
  /** Absolute canonical URL: the share/copy target and the JSON-LD @id. */
  canonical: string;
  /** Rooted page path, e.g. `/e/<key>`: the join return destination. */
  path: string;
  /** Validated roster-refresh href: the bare page path on page 1,
   * `?attendees=N` on a valid N > 1, never raw query text. */
  attendeesRefreshHref: string;
  /** Meta robots + x-robots-tag value for draft/past rows; null when indexable. */
  robots: string | null;
  /** Rooted .md alternate path; drafts have no Markdown view. */
  markdownAlternate?: string;
  icsUrl: string;
  /** Google Calendar deep link; null when the window is not ICS-wire-formattable. */
  googleCalendarUrl: string | null;
  /** Copy-link target: identical to the canonical URL by construction. */
  copyLink: string;
  /** Server-formatted wall time in the event zone, ISO fallback. */
  whenText: string;
  /** Server-formatted scheduled end in the event zone, ISO fallback. */
  endsWhenText: string;
  /** Effective display zone (UTC when the stored zone is unknown). */
  zoneLabel: string;
  /** Machine instant for the <time> element, as served. */
  timeDatetime: string;
  /** Member-only projection: always [] for anonymous viewers. */
  attendees: EventAttendee[];
  /** Native attendee page window for the rendered page, mirroring Hono. */
  attendeesPaging: { page: number; prevHref: string | null; nextHref: string | null };
  /** The caller's own RSVP row only; null for guests and non-members. */
  answer: ViewerRsvp | null;
  waitlistPosition: number | null;
  neighbors: { previous: KitEventDetailLink | null; next: KitEventDetailLink | null };
  related: KitEventDetailLink[];
  /** Guests-only join pitch; signed-in viewers never see it. */
  showJoinPitch: boolean;
  joinReturnTo: string;
  joinResult: JoinResult | null;
  viewerMember: boolean;
  viewerModerator: boolean;
  /** Signed-in display name for the header sign-out form; null for guests. */
  viewerUsername: string | null;
  /** Machine end instant, as served. Closure no longer derives from this in
   * the view — see rsvpClosed. */
  endsAt: string;
  jsonLd: string;
  siteJsonLd: string;
}

export interface KitEventDetailMissing {
  suggestions: EventMissingSuggestion[];
}

export type KitEventDetailOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "gone"; model: EventGoneModel; status: 410; headers: Record<string, string> }
  | { kind: "missing"; model: KitEventDetailMissing; status: 404; headers: Record<string, string> }
  | { kind: "forbidden"; status: 403; headers: Record<string, string> }
  | { kind: "unavailable"; status: 503; headers: Record<string, string> }
  | { kind: "ok"; model: KitEventDetailModel; status: 200; headers: Record<string, string> };

/** Branded-error body the Kit load throws for non-ok detail outcomes. The
 * route-level error page renders the carried state model, so the status stays
 * served (410/404) with the #838 presentation instead of the generic shell. */
export interface EventDetailErrorBody {
  message: string;
  gone?: EventGoneModel;
  missing?: EventMissingModel;
}

/** Map a gone/missing outcome onto the status and error body the Kit load
 * throws. Pure so the root suite pins the outcome-to-error mapping without
 * importing SvelteKit code (the load file itself needs the SvelteKit
 * transform): every gone/missing outcome must carry its branded model, and
 * nothing else maps here. */
export function eventDetailErrorPayload(
  outcome: Extract<KitEventDetailOutcome, { kind: "gone" | "missing" }>,
): { status: 410 | 404; body: EventDetailErrorBody } {
  if (outcome.kind === "gone") {
    return { status: 410, body: { message: "This event was cancelled.", gone: outcome.model } };
  }
  return { status: 404, body: { message: "Not found", missing: outcome.model } };
}

/** One-shot flash rule for the Kit load: delete the join_result cookie only
 * on the GET that renders the banner. Any other method or outcome leaves the
 * pending flash for the next full load, exactly as the served handler consumes
 * only after its boundary allows a 200 response. */
export function eventDetailConsumesFlash(outcome: KitEventDetailOutcome, method: string): boolean {
  return method === "GET" && outcome.kind === "ok" && outcome.model.joinResult !== null;
}

/** Throttle-first dispatch around the Kit detail render, mirroring the served
 * GET /e/:key handler (src/events/routes-detail.tsx): the shared public-read
 * budget runs before any read, and a limited client gets the Hono 429 with its
 * no-store, private headers instead of the page. The hook binds env into this
 * (request, render) => dispatchEventDetailRequest(request, env, render); the
 * core decides WHEN it runs, so the route-id branch is pinned in
 * src/route-ownership.ts instead of in web/src/hooks.server.ts. */
export async function dispatchEventDetailRequest(
  request: Request,
  env: Env,
  render: () => Promise<Response>,
  guard: (request: Request, env: Env) => Promise<Response | null> = kitPublicReadGuard,
): Promise<Response> {
  const limited = await guard(request, env);
  if (limited) return limited;
  return render();
}

const NOINDEX = "noindex, nofollow";
const NO_STORE = "private, no-store";

/** Production store wiring for the Kit load: the Hono handler's twin. */
export function kitEventDetailStore(env: Env): KitEventDetailStore {
  return {
    dbForFn: ({ env: bound }) => dbFor({ env: bound }),
    getEventFn: (db, key) => getPublicEvent(db, key),
    neighborsFn: (db, event) => getEventNeighbors(db, event),
    relatedFn: (db, event) => listRelatedEvents(db, event),
    attendeesFn: async (db, eventId, page) => {
      // Same bounded window as the served handler: the requested page plus
      // the first row of the next page (lookahead, never rendered) that
      // powers Next. The probe runs only from a full page — a partial page
      // cannot have a successor. The resolver declares every retrieved
      // owner, lookahead included, so the hook boundary audits exactly the
      // disclosed subjects.
      const rows = await listGoingAttendees(db, eventId, page);
      const lookahead =
        rows.length === ATTENDEE_PAGE_SIZE
          ? await listGoingAttendees(db, eventId, nextAttendeePage(page), 1)
          : [];
      return [...rows, ...lookahead];
    },
    viewerRsvpFn: (db, eventId, userId) => getViewerRsvp(db, eventId, userId),
    waitlistFn: (db, eventId, userId) =>
      // The waitlist read keys on the session user; without one there is no
      // position, exactly as the served handler passes null for guests.
      userId ? waitlistPosition(db, eventId, userId) : Promise.resolve(null),
    suggestionsFn: (bound, path) => cachedNotFoundSuggestions(bound, path),
  };
}

/** Hero wall time: the served page's long-offset format, ISO on a bad zone. */
export function formatEventWhen(startsAt: Date, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: timezone,
      timeZoneName: "longOffset",
    }).format(startsAt);
  } catch {
    return startsAt.toISOString();
  }
}

function toLink(link: EventLink): KitEventDetailLink {
  // Discovery instants use the served long-offset detail format (the hero
  // format), not the calendar grid format.
  return {
    key: link.eventKey,
    title: link.title,
    whenText: formatEventWhen(link.startsAt, link.timezone),
    datetime: link.startsAt.toISOString(),
    location: link.location,
  };
}

export async function resolveKitEventDetail(
  req: KitEventDetailRequest,
): Promise<KitEventDetailOutcome> {
  const { key, search, path, env, session, joinResult, setHeaders, store } = req;
  const appUrl = env.APP_URL;

  // One canonical key form per event: a valid key in another letter case 301s
  // to the canonical URL before any read, query preserved.
  const canonical = canonicalEventKey(key);
  if (canonical && canonical !== key) {
    setHeaders({});
    return { kind: "redirect", location: `/e/${encodeURIComponent(canonical)}${search}` };
  }

  // Key admission precedes lookup; forged keys skip the database. Unknown rows
  // share the same missing model with cached guest suggestions.
  if (eventKeyAllowed(key, appUrl)) {
    let db: Db | null;
    try {
      db = await store.dbForFn({ env });
    } catch {
      const headers = { "cache-control": NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    if (!db) {
      const headers = { "cache-control": NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    let event: PublicEvent | null;
    try {
      event = await store.getEventFn(db, key);
    } catch {
      const headers = { "cache-control": NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    if (event) {
      // Cancelled before any session-gated read: the 410 stays
      // viewer-independent, so a store outage or a rotated cookie can never
      // turn the static cancellation into a 500. The outcome carries the #838
      // gone model (same alternatives/ICS/JSON-LD contract as
      // resolveEventState), so the route-level error page renders the branded
      // cancellation instead of the generic shell. A failing alternatives
      // lookup degrades to an empty list, never an outage.
      if (event.status === "cancelled") {
        let related: EventLink[] = [];
        try {
          related = await store.relatedFn(db, event);
        } catch {
          related = [];
        }
        const headers = { "cache-control": NO_STORE, "x-robots-tag": NOINDEX };
        setHeaders(headers);
        return {
          kind: "gone",
          status: 410,
          headers,
          model: {
            title: event.title,
            game: event.game,
            eventKey: event.eventKey,
            icsUrl: `/events/${event.eventKey}.ics`,
            markdownAlternate: `/e/${event.eventKey}.md`,
            upcomingUrl: "/events",
            related: related.map((link) => ({
              key: link.eventKey,
              title: link.title,
              whenText: fmt(link.startsAt, link.timezone),
              datetime: link.startsAt.toISOString(),
              location: link.location,
            })),
            jsonLd: eventJsonLd(event, appUrl),
            siteJsonLd: siteJsonLd(appUrl),
          },
        };
      }
      // An indeterminate session is a store outage, never a logout and never
      // a guest render of member state: the served handler throws inside its
      // boundary here, which answers the outage envelope.
      if (session.status === "unknown") {
        const headers = { "cache-control": NO_STORE };
        setHeaders(headers);
        return { kind: "unavailable", status: 503, headers };
      }
      const viewer = session.session;
      if (event.status === "draft" && !viewer?.moderator) {
        const headers: Record<string, string> = {};
        setHeaders(headers);
        return { kind: "forbidden", status: 403, headers };
      }
      const member = viewer?.member === true;
      // Native attendee page from the query (?attendees=<n>), same strict
      // fallback as the served handler: malformed values stay on page 1.
      const attendeePage = parseAttendeePageParam(new URLSearchParams(search).get("attendees"));
      // Member-only projections, mirroring the served Promise.all: attendees
      // and the viewer's own answer never run for anonymous viewers, so an
      // anonymous capture holds no subjects and releases with no audit row.
      const [neighbors, related, attendeeRows, position, answer] = await Promise.all([
        store.neighborsFn(db, event),
        store.relatedFn(db, event),
        member ? store.attendeesFn(db, event.id, attendeePage) : Promise.resolve([]),
        viewer ? store.waitlistFn(db, event.id, viewer.userId) : Promise.resolve(null),
        viewer && member ? store.viewerRsvpFn(db, event.id, viewer.userId) : Promise.resolve(null),
      ]);
      // Declare the retrieved attendee owners so the hook boundary audits
      // exactly the disclosed subjects. Non-SQL fakes declare nothing on
      // their own; the SQL reads declare through the observed adapter and
      // this set-merge is idempotent. Guests declare nothing. The lookahead
      // (first row of the next page) is declared but never rendered.
      if (member) declareMemberResult(attendeeRows.map((attendee) => attendee.id));
      // Like listPast, the render keeps one page while the lookahead powers
      // Next; a partial page is never labeled as the total.
      const attendees = attendeeRows.slice(0, ATTENDEE_PAGE_SIZE);
      // An empty past-end page links back to page one (the bare URL):
      // page N-1 may itself be empty, stranding the viewer on empty pages.
      // Guests never render this section, so the value is inert for them.
      const attendeesPaging = {
        page: attendeePage,
        prevHref:
          attendeePage > 1
            ? attendeePageHref(event.eventKey, attendees.length === 0 ? 1 : attendeePage - 1)
            : null,
        nextHref:
          attendeeRows.length > ATTENDEE_PAGE_SIZE
            ? attendeePageHref(event.eventKey, attendeePage + 1)
            : null,
      };
      // RSVP closure is decided once here, on the server render instant, with
      // the RsvpButton twin's verdict (src/events/rsvp-button.tsx): draft,
      // past for non-published rows, or past when endsAt is at or before now.
      // Cancelled returns the gone outcome above, so it never reaches this
      // model. The view renders this verdict verbatim.
      const now = new Date();
      const rsvpClosed: RsvpClosedReason | null =
        event.status === "draft"
          ? "draft"
          : event.status !== "published" || event.endsAt <= now
            ? "past"
            : null;
      const pagePath = `/e/${event.eventKey}`;
      const pageCanonical = canonicalUrl(appUrl, pagePath);
      const robots = event.status === "draft" || event.status === "past" ? NOINDEX : null;
      const headers: Record<string, string> = {
        "cache-control": NO_STORE,
        vary: "Cookie",
        ...(robots ? { "x-robots-tag": robots } : {}),
      };
      setHeaders(headers);
      return {
        kind: "ok",
        status: 200,
        headers,
        model: {
          eventKey: event.eventKey,
          title: event.title,
          game: event.game,
          description: event.description,
          shareDescription: event.description || "An event at Together We Own.",
          location: event.location,
          status: event.status,
          isDraft: event.status === "draft",
          isPast: event.status === "past",
          goingCount: event.goingCount,
          goingOccupancy: event.goingOccupancy,
          capacity: event.capacity,
          rsvpOpen: event.rsvpOpen,
          rsvpClosed,
          canonical: pageCanonical,
          path: pagePath,
          // Stale-roster refresh keeps the validated attendee page (page 1
          // stays bare); never the raw query, so foreign params and malformed
          // values fall back to the bare event path.
          attendeesRefreshHref: attendeePageHref(event.eventKey, attendeePage),
          robots,
          // Drafts have no Markdown view: the session-free .md route 403s for
          // every viewer, so only link it where it answers 200.
          ...(event.status === "draft" ? {} : { markdownAlternate: `/e/${event.eventKey}.md` }),
          icsUrl: `/events/${event.eventKey}.ics`,
          // Finite but non-wire years stay a readable page: only the Google
          // Calendar deep link (an ICS instant pair) is omitted, mirroring Hono.
          googleCalendarUrl:
            isWireInstant(event.startsAt) && isWireInstant(event.endsAt)
              ? googleCalendarUrl(event)
              : null,
          copyLink: pageCanonical,
          whenText: formatEventWhen(event.startsAt, event.timezone),
          endsWhenText: formatEventWhen(event.endsAt, event.timezone),
          zoneLabel: isValidZone(event.timezone) ? event.timezone : "UTC",
          timeDatetime: event.startsAt.toISOString(),
          attendees,
          attendeesPaging,
          answer,
          waitlistPosition: position,
          neighbors: {
            previous: neighbors.previous ? toLink(neighbors.previous) : null,
            next: neighbors.next ? toLink(neighbors.next) : null,
          },
          related: related.map(toLink),
          showJoinPitch: !viewer,
          // The sign-in return keeps the query string, exactly as served;
          // the join pitch and related-join links use the bare page path.
          joinReturnTo: `${pagePath}${search}`,
          joinResult,
          viewerMember: member,
          viewerModerator: viewer?.moderator === true,
          viewerUsername: viewer?.username ?? null,
          endsAt: event.endsAt.toISOString(),
          jsonLd: eventJsonLd(event, appUrl),
          siteJsonLd: siteJsonLd(appUrl),
        },
      };
    }
  }
  let suggestions: SuggestedEvent[] = [];
  try {
    suggestions = await store.suggestionsFn(env, path);
  } catch {
    suggestions = [];
  }
  const headers = { "x-robots-tag": NOINDEX };
  setHeaders(headers);
  return {
    kind: "missing",
    status: 404,
    headers,
    model: {
      // Same suggestion shape as the #838 missing model (location included),
      // so the route-level error page renders the recovery section with the
      // served per-suggestion detail.
      suggestions: suggestions.map((suggestion) => ({
        key: suggestion.key,
        title: suggestion.title,
        whenText: `${suggestion.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
        datetime: suggestion.startsAt.toISOString(),
        location: suggestion.location,
      })),
    },
  };
}
