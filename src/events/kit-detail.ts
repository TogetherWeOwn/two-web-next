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
import { alertRequestError, exceptionClass } from "../alerts";
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
import { safeRequestId } from "../request-log";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { eventJsonLd, siteJsonLd } from "../seo-json-ld";
import {
  formatElapsedDuration,
  formatEventWhen,
  isEditedEvent,
  isValidZone,
  updatedStampLabel,
} from "./date-format";
import { directionsUrl, googleCalendarUrl, isWireInstant } from "./feeds";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { fmt } from "./pages-shared";
import { eventLinkAvailability } from "./link-availability";
import {
  ATTENDEE_PAGE_SIZE,
  getEventNeighbors,
  getEventSeriesContext,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
  nextAttendeePage,
  parseAttendeePageParam,
  type EventAttendee,
  type EventLink,
  type EventNeighbors,
  type EventSeriesContext,
  type PublicEvent,
  type SeriesEventRef,
  type ViewerRsvp,
} from "./reads";
import type { SuggestedEvent } from "./suggestions";
import { archiveContext } from "./archive-context";
import { archiveEventHref } from "./attendee-paths";
import { archiveReturnLink } from "./archive-links";
import { waitlistPosition } from "./waitlist";

export interface KitEventDetailStore {
  dbForFn: (ctx: { env: Env }) => Promise<Db | null>;
  getEventFn: (db: Db, key: string) => Promise<PublicEvent | null>;
  neighborsFn: (db: Db, event: Pick<PublicEvent, "id">) => Promise<EventNeighbors>;
  relatedFn: (db: Db, event: Pick<PublicEvent, "id" | "game">) => Promise<EventLink[]>;
  /** Series run read. Optional so existing fakes keep compiling: the resolver
   * falls back to the shared read, which skips standalone events with zero
   * queries and fails open everywhere else. */
  seriesFn?: (db: Db, event: SeriesEventRef) => Promise<EventSeriesContext | null>;
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
  /** Optional correlation ID from the caller (validated before logging, omitted otherwise). */
  requestId?: string;
}

export interface KitEventDetailLink {
  key: string;
  title: string;
  whenText: string;
  datetime: string;
  location: string | null;
  /** Destination's game; null renders no game line on the preview. */
  game: string | null;
  /** Destination's availability verdict at the render instant
   * (`eventLinkAvailability`); null renders no state line. */
  availability: string | null;
}

/** Series run context for the detail view: the hosts behind the run plus the
 * adjacent published/past nights. Null for standalone or oversized imported
 * runs, which render with no series markup on either renderer. */
export interface KitEventDetailSeries {
  hosts: string[];
  previous: KitEventDetailLink | null;
  next: KitEventDetailLink | null;
}

export interface KitEventDetailModel {
  eventKey: string;
  title: string;
  game: string | null;
  /** Raw organizer copy: the About section renders only when set. */
  description: string | null;
  /** Meta/share copy: the served fallback when the event has no description. */
  shareDescription: string;
  /** Trimmed accessibility notes; null when the event has none. The section
   * renders only when set, mirroring the served detail page. */
  accessibilityNotes: string | null;
  location: string | null;
  /** Maps search URL for the venue; null when no venue is set. The view
   * renders this verbatim and never builds URLs from location itself. */
  directionsUrl: string | null;
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
  /** Navigation-only archive return, absent on direct visits. */
  archiveReturn?: { href: string; label: string } | null;
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
  /** Server-formatted elapsed commitment; absent for an unusable interval. */
  durationText?: string | null;
  /** Effective display zone (UTC when the stored zone is unknown). */
  zoneLabel: string;
  /** Machine instant for the <time> element, as served. */
  timeDatetime: string;
  /** Edited-event stamp: the shared human date plus the machine instant, or
   * null on fresh rows. Derived from the already-read event row — no new
   * store call. Optional like `durationText` so partial model fixtures
   * (which never set it) still typecheck; the resolver always sets it. */
  updatedStamp?: { text: string; datetime: string } | null;
  /** Member-only projection: always [] for anonymous viewers. */
  attendees: EventAttendee[];
  /** Native attendee page window for the rendered page, mirroring Hono. */
  attendeesPaging: { page: number; prevHref: string | null; nextHref: string | null };
  /** The caller's own RSVP row only; null for guests and non-members. */
  answer: ViewerRsvp | null;
  waitlistPosition: number | null;
  neighbors: { previous: KitEventDetailLink | null; next: KitEventDetailLink | null };
  related: KitEventDetailLink[];
  series: KitEventDetailSeries | null;
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
 * (request, render, requestId) => dispatchEventDetailRequest(...); the core
 * decides WHEN it runs, so the route-id branch is pinned in
 * src/route-ownership.ts instead of in web/src/hooks.server.ts. */
export async function dispatchEventDetailRequest(
  request: Request,
  env: Env,
  render: () => Promise<Response>,
  guard: (
    request: Request,
    env: Env,
    requestId?: unknown,
  ) => Promise<Response | null> = kitPublicReadGuard,
  requestId?: unknown,
): Promise<Response> {
  const limited = await guard(request, env, requestId);
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
    seriesFn: (db, event) => getEventSeriesContext(db, event),
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

// Preserve the read-model export used by existing Kit callers.
export { formatEventWhen } from "./date-format";

function toLink(link: EventLink, now: Date): KitEventDetailLink {
  // Discovery instants use the served long-offset detail format (the hero
  // format), not the calendar grid format.
  return {
    key: link.eventKey,
    title: link.title,
    whenText: formatEventWhen(link.startsAt, link.timezone),
    datetime: link.startsAt.toISOString(),
    location: link.location,
    game: link.game || null,
    availability: eventLinkAvailability(link, now),
  };
}

// A code bug (no branded status) must never look like a downstream outage:
// emit the leak-free error.alert diagnostic before answering the unavailable
// outcome, mirroring the Kit hot-zone boundary (src/kit-hotzones.ts) and the
// event-states twin (src/kit-event-states.ts). Branded throws stay silent.
// The unavailable outcome and headers are unchanged either way. One shared
// helper covers both read legs, so a single branded test pins the
// classification.
function reportDetailLoadFailure(err: unknown, requestId: string | undefined): void {
  if (typeof (err as { status?: unknown })?.status !== "number") {
    alertRequestError(err, { method: "GET", route: "/e/:key", requestId });
  }
}

export async function resolveKitEventDetail(
  req: KitEventDetailRequest,
): Promise<KitEventDetailOutcome> {
  const { key, search, path, env, session, joinResult, setHeaders, store, requestId } = req;
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
    } catch (err) {
      reportDetailLoadFailure(err, requestId);
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
    } catch (err) {
      reportDetailLoadFailure(err, requestId);
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
        } catch (err) {
          // The cancelled page still serves with an empty alternatives list;
          // warn once with the exception class so the degrade is visible.
          // Class only, never the message: it can carry SQL or wire detail.
          console.warn("Event alternatives unavailable; serving the empty list.", {
            request_id: safeRequestId(requestId),
            exception: exceptionClass(err),
          });
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
            existingResponses: event.goingCount,
            icsUrl: `/events/${event.eventKey}.ics`,
            markdownAlternate: `/e/${event.eventKey}.md`,
            upcomingUrl: "/events",
            related: related.map((link) => ({
              key: link.eventKey,
              title: link.title,
              whenText: fmt(link.startsAt, link.timezone),
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
        const headers: Record<string, string> = { "cache-control": NO_STORE };
        setHeaders(headers);
        return { kind: "forbidden", status: 403, headers };
      }
      const member = viewer?.member === true;
      // Native attendee page from the query (?attendees=<n>), same strict
      // fallback as the served handler: malformed values stay on page 1.
      const attendeePage = parseAttendeePageParam(new URLSearchParams(search).get("attendees"));
      const archive = archiveContext(search);
      // Member-only projections, mirroring the served Promise.all: attendees
      // and the viewer's own answer never run for anonymous viewers, so an
      // anonymous capture holds no subjects and releases with no audit row.
      // Decorative reads fail open like the served twin: a throwing
      // neighbors/related store settles to its empty shape instead of
      // rejecting the whole model. Both reads stay nonSensitive
      // published-only, so no audit row is skipped; viewer reads below stay
      // closed and their throws still reject.
      const neighborsSettled = store.neighborsFn(db, event).then(
        (neighbors) => neighbors,
        (): EventNeighbors => ({ previous: null, next: null }),
      );
      const relatedSettled = store.relatedFn(db, event).then(
        (related) => related,
        (): EventLink[] => [],
      );
      const seriesSettled = (
        store.seriesFn ? store.seriesFn(db, event) : getEventSeriesContext(db, event)
      ).then(
        (series) => series,
        (): EventSeriesContext | null => null,
      );
      const [neighbors, related, series, attendeeRows, position, answer] = await Promise.all([
        neighborsSettled,
        relatedSettled,
        seriesSettled,
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
            ? archiveEventHref(
                event.eventKey,
                archive,
                attendees.length === 0 ? 1 : attendeePage - 1,
              )
            : null,
        nextHref:
          attendeeRows.length > ATTENDEE_PAGE_SIZE
            ? archiveEventHref(event.eventKey, archive, attendeePage + 1)
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
          // Trimmed notes, null when absent or blank: the served detail
          // page's section rule (src/events/pages-detail.tsx).
          accessibilityNotes: event.accessibilityNotes?.trim() || null,
          location: event.location,
          directionsUrl: event.location ? directionsUrl(event.location) : null,
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
          // Keep validated roster/archive state only, never raw query text.
          attendeesRefreshHref: archiveEventHref(event.eventKey, archive, attendeePage),
          archiveReturn: archiveReturnLink(archive),
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
          durationText: formatElapsedDuration(event.endsAt.getTime() - event.startsAt.getTime()),
          zoneLabel: isValidZone(event.timezone) ? event.timezone : "UTC",
          timeDatetime: event.startsAt.toISOString(),
          updatedStamp: isEditedEvent(event.createdAt, event.updatedAt)
            ? {
                text: updatedStampLabel(event.updatedAt, event.timezone),
                datetime: event.updatedAt.toISOString(),
              }
            : null,
          attendees,
          attendeesPaging,
          answer,
          waitlistPosition: position,
          neighbors: {
            previous: neighbors.previous ? toLink(neighbors.previous, now) : null,
            next: neighbors.next ? toLink(neighbors.next, now) : null,
          },
          related: related.map((link) => toLink(link, now)),
          series: series
            ? {
                hosts: series.hosts,
                previous: series.previous ? toLink(series.previous, now) : null,
                next: series.next ? toLink(series.next, now) : null,
              }
            : null,
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
  const headers = { "cache-control": NO_STORE, "x-robots-tag": NOINDEX };
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
