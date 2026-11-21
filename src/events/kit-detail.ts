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
import { timeStaleAt } from "../../lib/time-freshness-clock";
import { dbFor } from "../admin/db";
import { savedEventReview } from "../admin/event-saved-review";
import {
  renderEventPublishedNoticeHtml,
  renderSavedEventReviewHtml,
} from "../admin/pages/event-form-review";
import { alertRequestError, exceptionClass } from "../alerts";
import type { Db } from "../db/index";
import type { Env } from "../env";
import { RSVP_COPY, type RsvpClosedReason } from "../islands/contracts";
import type { KitRequestSession } from "../kit-session";
import { eventGoneModel } from "../kit-event-states";
import type {
  EventGoneModel,
  EventMissingModel,
  EventMissingSuggestion,
} from "../kit-event-states";
import { MAX_RETURN_DESTINATION_BYTES } from "../join/service";
import { kitPublicReadGuard } from "../kit-past-events";
import { declareMemberResult } from "../member-reads";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import { safeRequestId } from "../request-log";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { eventJsonLd, siteJsonLd } from "../seo-json-ld";
import { withEventDetailHtml, type EventDetailHtml } from "./detail-leaves";
import {
  cardTimeLabel,
  effectiveZone,
  formatDetailWhen,
  formatElapsedDuration,
  instantIso,
  isValidZone,
} from "./date-format";
import { directionsUrl, googleCalendarUrl, isWireInstant } from "./feeds";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import { eventLinkAvailability } from "./link-availability";
import { isOngoing } from "./ongoing";
import {
  ATTENDEE_PAGE_SIZE,
  getEventForModeratorReview,
  getEventNeighbors,
  getEventSeriesContext,
  getPublicEvent,
  getViewerRsvp,
  isRenderableEventWindow,
  listGoingAttendees,
  listRelatedEvents,
  nextAttendeePage,
  parseAttendeePageParam,
  type EventAttendee,
  type EventLink,
  type EventNeighbors,
  type EventSeriesContext,
  type PublicEvent,
  type ViewerRsvp,
} from "./reads";
import type { SuggestedEvent } from "./suggestions";
import { archiveContext } from "./archive-context";
import { archiveEventHref, authReturnHref } from "./attendee-paths";
import { archiveReturnLink } from "./archive-links";
import { waitlistPosition } from "./waitlist";

export interface KitEventDetailStore {
  dbForFn: (ctx: { env: Env }) => Promise<Db | null>;
  getEventFn: (db: Db, key: string) => Promise<PublicEvent | null>;
  /** Selected only after moderator review admission; legacy fakes can reuse their read. */
  getReviewEventFn?: (db: Db, key: string) => Promise<PublicEvent | null>;
  neighborsFn: (db: Db, event: Pick<PublicEvent, "id">, now?: Date) => Promise<EventNeighbors>;
  relatedFn: (db: Db, event: Pick<PublicEvent, "id" | "game">, now?: Date) => Promise<EventLink[]>;
  /** Series run read. Optional so existing fakes keep compiling: the resolver
   * falls back to the shared read, which skips standalone events with zero
   * queries and fails open everywhere else. */
  seriesFn?: typeof getEventSeriesContext;
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
  /** Display snapshot only; never used by the session or write paths. */
  now?: Date;
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

export interface KitSeatCard {
  heading: string | null;
  tag: { tone: "warn"; text: string } | null;
  note: string | null;
}

/** Only event-level gates belong here; the RSVP island owns viewer state. */
export function kitSeatCard(
  closed: RsvpClosedReason | null,
  member: boolean,
  open: boolean,
  review: boolean,
): KitSeatCard {
  if (review) return { heading: null, tag: null, note: null };
  if (closed) return { heading: "RSVPs closed", tag: null, note: null };
  const tag = open ? null : { tone: "warn" as const, text: "Paused" };
  if (member) return { heading: "Your RSVP", tag, note: null };
  return {
    heading: "Log in to RSVP",
    tag,
    note: open ? "You'll come straight back here." : RSVP_COPY.paused,
  };
}

export { kitEventFacts } from "./kit-event-facts";

export interface KitEventDetailModel {
  seatCard: KitSeatCard;
  /** Escaped server-only member presentation; created after disclosure declaration. */
  detailHtml: EventDetailHtml;
  /** Moderator-only escaped leaves; the member rendering is shared unchanged. */
  review?: { banner: string; actions: string; rsvp: string };
  publishedNotice?: string;
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
  /** Verified host display name; null when unset. */
  organizerName: string | null;
  /** Public joining link; null when unset. */
  joinUrl: string | null;
  /** Joining instructions; null when unset. */
  joinInstructions: string | null;
  status: string;
  isDraft: boolean;
  isPast: boolean;
  /** Server snapshot at the render instant (`isOngoing`): the "Happening now"
   * interval. Never a client clock; RSVP verdicts are unaffected. Optional
   * so a pre-existing fixture without the flag reads as not ongoing. */
  isOngoing?: boolean;
  /** Elapsed at the server render instant, even if a review cannot format its dates. */
  isEnded: boolean;
  lifecycle: { date: string; endTime: string } | null;
  endedNext: { key: string; date: string } | null;
  liveTime?: { asOf: string; staleAt: string };
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
  viewerAuthenticated: boolean;
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
    getReviewEventFn: (db, key) => getEventForModeratorReview(db, key),
    neighborsFn: getEventNeighbors,
    relatedFn: listRelatedEvents,
    seriesFn: getEventSeriesContext,
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

function toLink(link: EventLink, now: Date, zone: string): KitEventDetailLink {
  return {
    key: link.eventKey,
    title: link.title,
    whenText: `${cardTimeLabel(link.startsAt, zone)} ${zone}`,
    datetime: link.startsAt.toISOString(),
    location: link.location,
    game: link.game || null,
    availability: eventLinkAvailability(link, now),
  };
}

function detailLifecycle(event: PublicEvent, timeZone: string): KitEventDetailModel["lifecycle"] {
  if (!instantIso(event.startsAt) || !instantIso(event.endsAt)) return null;
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  const clock = new Intl.DateTimeFormat("en-GB", { timeZone, timeStyle: "short" });
  const startDate = date.format(event.startsAt);
  const endDate = date.format(event.endsAt);
  const endTime = clock.format(event.endsAt);
  return {
    date: startDate,
    endTime: startDate === endDate ? endTime : `${endDate}, ${endTime}`,
  };
}

function endedNext(next: EventLink | null | undefined): KitEventDetailModel["endedNext"] {
  if (!next) return null;
  return {
    key: next.eventKey,
    date: new Intl.DateTimeFormat("en-GB", {
      timeZone: isValidZone(next.timezone) ? next.timezone : "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
    }).format(next.startsAt),
  };
}

function liveDetailTime(event: PublicEvent, now: Date): KitEventDetailModel["liveTime"] {
  if (!isOngoing(event, now)) return undefined;
  const staleAt = timeStaleAt("live", +now, +event.startsAt, +event.endsAt);
  if (staleAt === null || !Number.isFinite(staleAt)) return undefined;
  return { asOf: now.toISOString(), staleAt: new Date(staleAt).toISOString() };
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
  const now = req.now ?? new Date();

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
    const wantsReview = new URLSearchParams(search).get("review") === "1";
    if (wantsReview && (session.status === "unknown" || !session.session?.moderator)) {
      const status = session.status === "unknown" ? 503 : 403;
      const headers = { "cache-control": NO_STORE, "x-robots-tag": NOINDEX };
      setHeaders(headers);
      return status === 503
        ? { kind: "unavailable", status, headers }
        : { kind: "forbidden", status, headers };
    }
    let event: PublicEvent | null;
    try {
      event = wantsReview
        ? await (store.getReviewEventFn ?? store.getEventFn)(db, key)
        : await store.getEventFn(db, key);
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
      if (event.status === "cancelled" && !wantsReview) {
        let related: EventLink[] = [];
        try {
          related = await store.relatedFn(db, event, now);
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
        let upcoming: EventLink | null = null;
        try {
          const acceptKey = (key: string) =>
            eventKeyAllowed(key, appUrl) && (canonicalEventKey(key) ?? key) === key;
          const readSeries = store.seriesFn ?? getEventSeriesContext;
          upcoming = (await readSeries(db, event, now, acceptKey))?.upcoming ?? null;
        } catch (err) {
          console.warn("Event next date unavailable; serving cancellation without it.", {
            request_id: safeRequestId(requestId),
            exception: exceptionClass(err),
          });
        }
        const headers = { "cache-control": NO_STORE, "x-robots-tag": NOINDEX };
        setHeaders(headers);
        return {
          kind: "gone",
          status: 410,
          headers,
          model: eventGoneModel(event, related, appUrl, upcoming),
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
      const neighborsSettled = store.neighborsFn(db, event, now).then(
        (neighbors) => neighbors,
        (): EventNeighbors => ({ previous: null, next: null }),
      );
      const relatedSettled = store.relatedFn(db, event, now).then(
        (related) => related,
        (): EventLink[] => [],
      );
      const ended =
        (event.status === "past" || event.status === "published") && event.endsAt <= now;
      const seriesSettled = (store.seriesFn ?? getEventSeriesContext)(
        db,
        event,
        ended ? now : undefined,
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
                wantsReview,
              )
            : null,
        nextHref:
          attendeeRows.length > ATTENDEE_PAGE_SIZE
            ? archiveEventHref(event.eventKey, archive, attendeePage + 1, wantsReview)
            : null,
      };
      // RSVP closure is decided once here, on the server render instant, with
      // the RsvpButton twin's verdict (src/events/rsvp-button.tsx): draft,
      // past for non-published rows, or past when endsAt is at or before now.
      // Cancelled returns the gone outcome above, so it never reaches this
      // model. The view renders this verdict verbatim.
      const rsvpClosed: RsvpClosedReason | null =
        event.status === "draft"
          ? "draft"
          : event.status !== "published" || event.endsAt <= now
            ? "past"
            : null;
      const pagePath = `/e/${event.eventKey}`;
      const pageCanonical = canonicalUrl(appUrl, pagePath);
      const review = wantsReview ? savedEventReview(event, now, search) : null;
      // Share the server C4 block's effective zone across discovery links.
      // This is the current event's configured zone, not a viewer preference.
      const zoneLabel = effectiveZone(event.timezone);
      const liveTime = liveDetailTime(event, now);
      const nextInRecord = ended ? endedNext(series?.upcoming) : null;
      const canLink = (link: EventLink) =>
        !ended || (link.eventKey !== nextInRecord?.key && isRenderableEventWindow(link));
      const discoveryLink = (link: EventLink | null) =>
        link && canLink(link) ? toLink(link, now, zoneLabel) : null;
      const robots = review || event.status === "draft" || event.status === "past" ? NOINDEX : null;
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
        model: withEventDetailHtml({
          ...(viewer?.moderator &&
          event.status === "published" &&
          !review &&
          new URLSearchParams(search).get("published") === "1"
            ? { publishedNotice: renderEventPublishedNoticeHtml() }
            : {}),
          ...(review
            ? {
                review: {
                  banner: renderSavedEventReviewHtml(review),
                  actions: renderSavedEventReviewHtml(review, "actions"),
                  rsvp: renderSavedEventReviewHtml(review, "rsvp"),
                },
              }
            : {}),
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
          organizerName: event.organizer_name ?? null,
          joinUrl: event.join_url ?? null,
          joinInstructions: event.join_instructions ?? null,
          status: event.status,
          isDraft: event.status === "draft",
          isPast: event.status === "past",
          isOngoing: Boolean(liveTime),
          isEnded: ended,
          lifecycle: ended ? detailLifecycle(event, zoneLabel) : null,
          endedNext: nextInRecord,
          ...(liveTime ? { liveTime } : {}),
          goingCount: event.goingCount,
          goingOccupancy: event.goingOccupancy,
          capacity: event.capacity,
          rsvpOpen: event.rsvpOpen,
          rsvpClosed,
          seatCard: kitSeatCard(rsvpClosed, member, event.rsvpOpen, Boolean(review)),
          canonical: pageCanonical,
          path: pagePath,
          // Keep validated roster/archive state only, never raw query text.
          attendeesRefreshHref: archiveEventHref(
            event.eventKey,
            archive,
            attendeePage,
            wantsReview,
          ),
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
          whenText: formatDetailWhen(event.startsAt, event.timezone),
          endsWhenText: formatDetailWhen(event.endsAt, event.timezone),
          durationText: formatElapsedDuration(event.endsAt.getTime() - event.startsAt.getTime()),
          zoneLabel,
          timeDatetime: instantIso(event.startsAt),
          attendees,
          attendeesPaging,
          answer,
          waitlistPosition: position,
          neighbors: {
            previous: discoveryLink(neighbors.previous),
            next:
              ended && neighbors.next && series?.memberIds?.includes(neighbors.next.id)
                ? null
                : discoveryLink(neighbors.next),
          },
          related: related.filter(canLink).map((link) => toLink(link, now, zoneLabel)),
          series: series
            ? {
                hosts: series.hosts,
                previous: discoveryLink(series.previous),
                next: ended ? null : discoveryLink(series.next),
              }
            : null,
          showJoinPitch: !viewer,
          // The sign-in return keeps normalized archive/attendee context
          // bounded to auth's byte cap, never the raw query string; the
          // join pitch and related-join links use the bare page path.
          joinReturnTo: authReturnHref(
            event.eventKey,
            archive,
            attendeePage,
            MAX_RETURN_DESTINATION_BYTES,
          ),
          joinResult,
          viewerAuthenticated: viewer != null,
          viewerMember: member,
          viewerModerator: viewer?.moderator === true,
          viewerUsername: viewer?.username ?? null,
          endsAt: instantIso(event.endsAt),
          jsonLd: eventJsonLd(event, appUrl),
          siteJsonLd: siteJsonLd(appUrl),
        }),
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
