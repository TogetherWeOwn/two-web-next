// Shared event-state models for the SvelteKit /e/:key port.
//
// The full detail family stays Hono-owned until the read/RSVP companions
// complete, so this module owns only what the cancelled410 and missing404
// presentations need: key classification, the sessionless cancelled model
// (alternatives + ICS, never RSVP) and the missing model (suggestions).
// Framework-free: no Hono, no Svelte, no session. The future Kit load binds
// the store seams to the real reads; tests inject fakes.
//
// Gate order mirrors src/events/routes-detail.tsx: canonical redirect before
// any read, key admission before lookup, cancelled before any session read
// (there is no session read here at all), draft stays forbidden, every
// database failure is a branded 503. Published and past rows defer to the
// full-detail companion (card 25/43): collapsing them into a snapshot here
// would fork the detail contract.
import { alertRequestError, exceptionClass } from "./alerts";
import type { Db } from "./db/index";
import type { Env } from "./env";
import { canonicalEventKey, eventKeyAllowed } from "./events/keys";
import { fmt } from "./events/pages-shared";
import { safeRequestId } from "./request-log";
import type { EventLink, PublicEvent } from "./events/reads";
import type { SuggestedEvent } from "./events/suggestions";
import { eventJsonLd, siteJsonLd } from "./seo-json-ld";

export interface EventStateStore {
  dbForFn: (ctx: { env: Env }) => Promise<Db | null>;
  getEventFn: (db: Db, key: string) => Promise<PublicEvent | null>;
  relatedFn: (db: Db, event: Pick<PublicEvent, "id" | "game">) => Promise<EventLink[]>;
  suggestionsFn: (env: Env, path: string) => Promise<SuggestedEvent[]>;
}

export interface EventStateRequest {
  /** Raw :key param, exactly as routed. */
  key: string;
  /** Raw query string with its leading "?", or "". */
  search: string;
  /** Request path, for suggestion scoping. */
  path: string;
  env: Env;
  /** Called exactly once per resolution: SvelteKit throws on a double-set. */
  setHeaders: (headers: Record<string, string>) => void;
  store: EventStateStore;
  /** Optional correlation ID from the caller (validated before logging, omitted otherwise). */
  requestId?: string;
}

export interface EventGoneAlternative {
  key: string;
  title: string;
  whenText: string;
  location: string | null;
}

export interface EventGoneModel {
  title: string;
  game: string | null;
  eventKey: string;
  /** Retained answer count, rendered as history (existingResponsesText) with
   * no capacity: the cancelled schedule card's line. Carried from the
   * already-loaded event row; never a new read. */
  existingResponses: number;
  /** Per-event calendar download; the feed serves cancelled rows. */
  icsUrl: string;
  markdownAlternate: string;
  upcomingUrl: string;
  related: EventGoneAlternative[];
  jsonLd: string;
  siteJsonLd: string;
}

export interface EventMissingSuggestion {
  key: string;
  title: string;
  /** Same UTC instant rendering as the Hono 404 suggestions. */
  whenText: string;
  /** Full instant for the <time> element, as served. */
  datetime: string;
  location: string | null;
}

export interface EventMissingModel {
  suggestions: EventMissingSuggestion[];
}

export type EventStateOutcome =
  | { kind: "redirect"; location: string }
  | { kind: "gone"; model: EventGoneModel; status: 410; headers: Record<string, string> }
  | { kind: "missing"; model: EventMissingModel; status: 404; headers: Record<string, string> }
  | { kind: "forbidden"; status: 403; headers: Record<string, string> }
  | { kind: "unavailable"; status: 503; headers: Record<string, string> }
  | { kind: "live" };

const NOINDEX = "noindex, nofollow";
const NO_STORE: Record<string, string> = { "cache-control": "private, no-store" };

function missingSuggestion(s: SuggestedEvent): EventMissingSuggestion {
  return {
    key: s.key,
    title: s.title,
    whenText: `${s.startsAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    datetime: s.startsAt.toISOString(),
    location: s.location,
  };
}

export async function resolveEventState(req: EventStateRequest): Promise<EventStateOutcome> {
  const { key, search, path, env, setHeaders, store, requestId } = req;
  const appUrl = env.APP_URL;

  // One canonical key form per event: a valid key in another letter case
  // 301s to the canonical URL before any read, query preserved.
  const canonical = canonicalEventKey(key);
  if (canonical && canonical !== key) {
    setHeaders({});
    return { kind: "redirect", location: `/e/${encodeURIComponent(canonical)}${search}` };
  }

  // Key admission precedes lookup; forged keys skip the database.
  // Unknown rows share the same missing model: an unrenderable window is a
  // 404 with suggestions, never a 500 (mirrors getPublicEvent callers).
  let missing: EventMissingModel | null = null;
  if (eventKeyAllowed(key, appUrl)) {
    let db: Db | null;
    try {
      db = await store.dbForFn({ env });
    } catch (err) {
      // A code bug (no branded status) must never look like a downstream
      // outage: emit the leak-free error.alert diagnostic, mirroring the Kit
      // hot-zone boundary (src/kit-hotzones.ts). Branded throws stay silent.
      // The unavailable outcome and headers are unchanged either way.
      if (typeof (err as { status?: unknown })?.status !== "number") {
        alertRequestError(err, { method: "GET", route: "/e/:key", requestId });
      }
      const headers = { ...NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    if (!db) {
      const headers = { ...NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    let event: PublicEvent | null;
    try {
      event = await store.getEventFn(db, key);
    } catch (err) {
      if (typeof (err as { status?: unknown })?.status !== "number") {
        alertRequestError(err, { method: "GET", route: "/e/:key", requestId });
      }
      const headers = { ...NO_STORE };
      setHeaders(headers);
      return { kind: "unavailable", status: 503, headers };
    }
    if (event) {
      if (event.status === "cancelled") {
        // Viewer-independent: alternatives and the calendar entry derive
        // from public rows only, so a store outage elsewhere or a rotated
        // cookie can never turn the cancellation into a 500. A failing
        // alternatives lookup degrades to an empty list, never an outage.
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
        const headers = { ...NO_STORE, "x-robots-tag": NOINDEX };
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
      // Unauthorized drafts stay forbidden. A moderator's draft view needs a
      // session read, which this sessionless module never performs: the
      // full-detail companion owns that branch.
      if (event.status === "draft") {
        const headers: Record<string, string> = { ...NO_STORE };
        setHeaders(headers);
        return { kind: "forbidden", status: 403, headers };
      }
      // Published and past rows belong to the full-detail companion.
      setHeaders({});
      return { kind: "live" };
    }
  }
  let suggestions: SuggestedEvent[] = [];
  try {
    suggestions = await store.suggestionsFn(env, path);
  } catch {
    suggestions = [];
  }
  missing = { suggestions: suggestions.map(missingSuggestion) };
  const headers = { ...NO_STORE, "x-robots-tag": NOINDEX };
  setHeaders(headers);
  return { kind: "missing", status: 404, headers, model: missing };
}
