// Kit read model for the live GET /e/:key detail: published, past and
// moderator draft rows with member-only attendee disclosure.
//
// Framework-free so the root suite pins it without a SvelteKit transform: the
// future +page.server.ts load maps these outcomes onto redirect()/error() and
// runs inside the hook's memberReadResponse boundary, which audits the
// declared attendee subjects before any bytes leave. The manifest entry stays
// disabled until the RSVP companion (card 26/43) passes, so Hono keeps
// serving; GET /events/:key JSON and the ICS feed stay Hono-owned with no
// manifest entries and no JSON here.
//
// Gate order mirrors src/events/routes-detail.tsx: canonical redirect before
// any read, key admission before lookup, cancelled before any session-gated
// read, draft stays forbidden without the moderator bit, an indeterminate
// session is unavailable (never a false logout, never a guest render of
// member state), and every database failure is a 503 before bytes.
import { dbFor } from "../admin/db";
import type { Db } from "../db/index";
import type { Env } from "../env";
import type { KitRequestSession } from "../kit-session";
import { declareMemberResult } from "../member-reads";
import { cachedNotFoundSuggestions } from "../not-found-suggestions";
import type { JoinResult } from "../return-journey";
import { canonicalUrl } from "../seo";
import { eventJsonLd, siteJsonLd } from "../seo-json-ld";
import { isValidZone } from "./date-format";
import { googleCalendarUrl } from "./feeds";
import { canonicalEventKey, eventKeyAllowed } from "./keys";
import {
  getEventNeighbors,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
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
  attendeesFn: (db: Db, eventId: number) => Promise<EventAttendee[]>;
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
  /** Read-only flash: consumption stays Hono-side, so a Kit read replays it. */
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
  capacity: number | null;
  rsvpOpen: boolean;
  /** Absolute canonical URL: the share/copy target and the JSON-LD @id. */
  canonical: string;
  /** Rooted page path, e.g. `/e/<key>`: the join return destination. */
  path: string;
  /** Meta robots + x-robots-tag value for draft/past rows; null when indexable. */
  robots: string | null;
  /** Rooted .md alternate path; drafts have no Markdown view. */
  markdownAlternate?: string;
  icsUrl: string;
  googleCalendarUrl: string;
  /** Copy-link target: identical to the canonical URL by construction. */
  copyLink: string;
  /** Server-formatted wall time in the event zone, ISO fallback. */
  whenText: string;
  /** Effective display zone (UTC when the stored zone is unknown). */
  zoneLabel: string;
  /** Machine instant for the <time> element, as served. */
  timeDatetime: string;
  /** Member-only projection: always [] for anonymous viewers. */
  attendees: EventAttendee[];
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
  /** Machine end instant: the view closes RSVP for ended rows, as served. */
  endsAt: string;
  jsonLd: string;
  siteJsonLd: string;
}

export interface KitEventDetailMissing {
  suggestions: { key: string; title: string; whenText: string; datetime: string }[];
}

export type KitEventDetailOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "gone"; status: 410; headers: Record<string, string> }
  | { kind: "missing"; model: KitEventDetailMissing; status: 404; headers: Record<string, string> }
  | { kind: "forbidden"; status: 403; headers: Record<string, string> }
  | { kind: "unavailable"; status: 503; headers: Record<string, string> }
  | { kind: "ok"; model: KitEventDetailModel; status: 200; headers: Record<string, string> };

const NOINDEX = "noindex, nofollow";
const NO_STORE = "private, no-store";

/** Production store wiring for the Kit load: the Hono handler's twin. */
export function kitEventDetailStore(env: Env): KitEventDetailStore {
  return {
    dbForFn: ({ env: bound }) => dbFor({ env: bound }),
    getEventFn: (db, key) => getPublicEvent(db, key),
    neighborsFn: (db, event) => getEventNeighbors(db, event),
    relatedFn: (db, event) => listRelatedEvents(db, event),
    attendeesFn: (db, eventId) => listGoingAttendees(db, eventId),
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
      // turn the static cancellation into a 500. The sessionless states module
      // owns the gone presentation; this resolver only classifies.
      if (event.status === "cancelled") {
        const headers = { "cache-control": NO_STORE, "x-robots-tag": NOINDEX };
        setHeaders(headers);
        return { kind: "gone", status: 410, headers };
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
      // Member-only projections, mirroring the served Promise.all: attendees
      // and the viewer's own answer never run for anonymous viewers, so an
      // anonymous capture holds no subjects and releases with no audit row.
      const [neighbors, related, attendees, position, answer] = await Promise.all([
        store.neighborsFn(db, event),
        store.relatedFn(db, event),
        member ? store.attendeesFn(db, event.id) : Promise.resolve([]),
        viewer ? store.waitlistFn(db, event.id, viewer.userId) : Promise.resolve(null),
        viewer && member ? store.viewerRsvpFn(db, event.id, viewer.userId) : Promise.resolve(null),
      ]);
      // Declare the retrieved attendee owners so the hook boundary audits
      // exactly the disclosed subjects. Non-SQL fakes declare nothing on
      // their own; the SQL reads declare through the observed adapter and
      // this set-merge is idempotent. Guests declare nothing.
      if (member) declareMemberResult(attendees.map((attendee) => attendee.id));
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
          capacity: event.capacity,
          rsvpOpen: event.rsvpOpen,
          canonical: pageCanonical,
          path: pagePath,
          robots,
          // Drafts have no Markdown view: the session-free .md route 403s for
          // every viewer, so only link it where it answers 200.
          ...(event.status === "draft" ? {} : { markdownAlternate: `/e/${event.eventKey}.md` }),
          icsUrl: `/events/${event.eventKey}.ics`,
          googleCalendarUrl: googleCalendarUrl(event),
          copyLink: pageCanonical,
          whenText: formatEventWhen(event.startsAt, event.timezone),
          zoneLabel: isValidZone(event.timezone) ? event.timezone : "UTC",
          timeDatetime: event.startsAt.toISOString(),
          attendees,
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
      suggestions: suggestions.map((suggestion) => ({
        key: suggestion.key,
        title: suggestion.title,
        whenText: `${suggestion.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
        datetime: suggestion.startsAt.toISOString(),
      })),
    },
  };
}
