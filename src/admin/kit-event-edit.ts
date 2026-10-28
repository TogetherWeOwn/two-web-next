// Kit read model for GET /admin/events/:key. The edit load
// (web/src/routes/admin/events/[key]/+page.server.ts) is a thin SvelteKit
// binding around this: cloudflare:workers + SvelteKit imports stay out of the
// root test process, so the serializable view decision lives here where unit
// tests can drive it.
//
// Framework-free by construction, like src/admin/kit-featured-edit.ts: it
// shapes already-fetched rows, performs no session or audit work itself, and
// never touches cookies. The layout guard owns the guest bounce and the
// moderator 403; the hook's member-read boundary owns classification and the
// audit; the roster rows below flow through the shared listRoster keyed read,
// so a failed audit refuses the whole render and no roster byte escapes.
//
// The read mirrors the Hono handler (src/admin/routes.tsx,
// admin.events.edit): the same shared getEvent read (a missing key 404s), the
// same eventValues wall fill in the row's zone, the same bounded
// parseRosterQuery/listRoster page (ROSTER_PAGE_SIZE rows, filtered total,
// past-end pages empty with working navigation), the same status-action
// admission (publish only from draft, cancel from draft/published, RSVP
// pause/reopen only on a live published event) and the same series note. The
// fresh GET carries the Hono 422 values/errors/draft shape empty, exactly
// like the create port, so the Svelte page renders the identical error DOM
// when the write slice migrates. POST /admin/events/:key, the
// publish/cancel/RSVP-pause/RSVP-reopen siblings and the guarded
// /admin/events/:key/edit legacy redirect stay Hono-owned, so the UTC
// carriers across DST, future recurrence propagation and postcommit writeback
// keep one authority — this model carries no write, and there is deliberately
// no event delete anywhere on this resource.
import type { Db } from "../db/index";
import { isDatabaseUnavailable } from "../db/errors";
import { alertRequestError } from "../alerts";
import { eventKeyAllowed } from "../events/keys";
import {
  parseRosterQuery,
  ROSTER_PAGE_SIZE,
  ROSTER_STATUSES,
  rosterEmptyText,
  rosterRangeText,
  rosterRecovery,
  rosterUrl,
  type ListParams,
  type RosterQuery,
  type RosterSort,
  type RosterStatus,
  type SortOrder,
} from "./table-list";
import { isKnownTimezone, utcToWall } from "./validation-wall-time";
import { renderRsvpPauseReviewHtml } from "./rsvp-review";

/** The edit-form values the Hono eventValues() helper renders. */
export type KitEventEditValues = {
  title: string;
  game: string;
  description: string;
  accessibility_notes: string;
  starts_at: string;
  ends_at: string;
  timezone: string;
  location: string;
  organizer_name: string;
  join_url: string;
  join_instructions: string;
  capacity: string;
};

/** One roster row as the Hono table renders it: display name, status and the
 * ISO instant. The member identifier stays out of the view: Hono uses it only
 * as a vnode key, never as rendered text, so the Svelte page keys rows by
 * their instant and index instead. */
export type KitEventEditRosterEntry = {
  member: string;
  status: string;
  answeredAt: string;
};

/** One roster sort header, mirroring the Hono TableSortHeader copy exactly. */
export type KitEventEditSortHeader = {
  key: RosterSort;
  label: string;
  url: string;
  active: boolean;
  ariaSort: "ascending" | "descending" | "none";
  linkLabel: string;
  marker: string;
};

/** One native answer-facet option, mirroring the Hono roster select exactly. */
export type KitEventEditStatusOption = {
  value: RosterStatus;
  label: string;
  selected: boolean;
};

export type KitEventEditRosterView = {
  total: number;
  query: RosterQuery;
  entries: KitEventEditRosterEntry[];
  rangeStart: number;
  rangeEnd: number;
  /** Shared Hono/Kit range copy: matching responses, never seats or attendance. */
  rangeText: string;
  /** Native answer-facet options in Hono order: All first, then each status. */
  statusOptions: KitEventEditStatusOption[];
  hasPrev: boolean;
  hasNext: boolean;
  prevUrl: string | null;
  nextUrl: string | null;
  /** Scoped recovery, exactly like the Hono section; null while rows render. */
  clearUrl: string | null;
  firstUrl: string | null;
  /** Past-end and zero-row copy, exactly like the Hono section; null when rows render. */
  emptyText: string | null;
  sortHeaders: KitEventEditSortHeader[];
  /** The Hono-owned GET search target, with its roster anchor. */
  searchAction: string;
};

export type KitEventEditView = {
  key: string;
  title: string;
  status: string;
  values: KitEventEditValues;
  errors: Record<string, string>;
  hasErrors: boolean;
  isDraft: boolean;
  showPublish: boolean;
  showCancel: boolean;
  rsvpAction: "rsvp-pause" | "rsvp-reopen" | null;
  /** The Hono series-move hint for series parents; null for one-offs. */
  seriesNote: string | null;
  endsAt: string;
  roster: KitEventEditRosterView;
  /** Pre-rendered pause-review HTML when rsvpAction is rsvp-pause, else null;
   * the page injects it via {@html} so the client bundle carries no review
   * strings or disclosure markup (client gzip ceiling). */
  pauseReviewHtml: string | null;
};

export type KitEventEditOutcome =
  | { kind: "notFound" }
  | { kind: "unavailable" }
  | { kind: "ok"; view: KitEventEditView };

/** Structural minimum the resolver reads: the real getEvent EventRow and the
 * real listRoster RosterEntry both extend these, so the load passes the
 * shared helpers straight through. */
export type KitEventEditRow = {
  eventKey: string;
  title: string;
  game: string | null;
  description: string | null;
  /** Optional like EventRow: older in-memory fixtures omit it; live rows carry it nullable. */
  accessibilityNotes?: string | null;
  startsAt: Date;
  endsAt: Date;
  timezone: string;
  location: string | null;
  organizer_name?: string | null;
  join_url?: string | null;
  join_instructions?: string | null;
  capacity: number | null;
  status: string;
  rsvpOpen: boolean;
  recurrenceFrequency: string | null;
};

export type KitEventEditRosterRow = {
  username: string | null;
  status: string;
  answeredAt: Date;
};

export type KitEventEditDeps = {
  /** The production load always supplies APP_URL; fixture-only callers may omit it. */
  appUrl?: string;
  /** Null database answers the Hono dbOr503 503; the guard owns the rest. */
  db: Db | null;
  get: (db: Db, key: string) => Promise<KitEventEditRow | null>;
  list: (
    db: Db,
    eventKey: string,
    query: RosterQuery,
  ) => Promise<{ rows: KitEventEditRosterRow[]; total: number }>;
  now?: Date;
};

function sortHeader(eventKey: string, query: RosterQuery, key: RosterSort, label: string) {
  const active = query.sort === key;
  const next: SortOrder = active && query.order === "asc" ? "desc" : "asc";
  return {
    key,
    label,
    url: rosterUrl(eventKey, query, { sort: key, order: next, page: 1 }),
    active,
    ariaSort: (active ? (query.order === "asc" ? "ascending" : "descending") : "none") as
      | "ascending"
      | "descending"
      | "none",
    linkLabel: `Sort by ${label.toLowerCase()} ${next === "asc" ? "ascending" : "descending"}`,
    marker: active ? (query.order === "asc" ? " ↑" : " ↓") : "",
  };
}

export async function resolveKitEventEdit(
  rawKey: string,
  rawQuery: ListParams,
  deps: KitEventEditDeps,
): Promise<KitEventEditOutcome> {
  if (!rawKey || (deps.appUrl !== undefined && !eventKeyAllowed(rawKey, deps.appUrl))) {
    return { kind: "notFound" };
  }
  if (!deps.db) return { kind: "unavailable" };
  let row: KitEventEditRow | null;
  try {
    row = await deps.get(deps.db, rawKey);
  } catch (err) {
    // A classified outage answers the shared 503 (the Hono guard's
    // memberReadBoundary turns the read's rethrown outage into the
    // databaseUnavailable envelope; SvelteKit would otherwise render its 500
    // error page for the uncaught rejection). A code bug emits the leak-free
    // error.alert diagnostic first so it never looks like a downstream
    // outage, mirroring src/admin/kit-activity-log.ts, then still throws.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    alertRequestError(err, { method: "GET", route: "/admin/events/:key" });
    throw err;
  }
  if (!row) return { kind: "notFound" };
  const query = parseRosterQuery(rawQuery);
  let roster: { rows: KitEventEditRosterRow[]; total: number };
  try {
    roster = await deps.list(deps.db, row.eventKey, query);
  } catch (err) {
    // Same stable route as the get leg above: one fingerprint per load, so
    // the 5-minute mute dedupes repeats across both legs.
    if (isDatabaseUnavailable(err)) return { kind: "unavailable" };
    alertRequestError(err, { method: "GET", route: "/admin/events/:key" });
    throw err;
  }
  const now = deps.now ?? new Date();
  const entries = roster.rows.map((r) => ({
    member: r.username?.trim() || "Unknown member",
    status: r.status,
    answeredAt: r.answeredAt.toISOString(),
  }));
  const rangeStart = entries.length > 0 ? (query.page - 1) * ROSTER_PAGE_SIZE + 1 : 0;
  const rangeEnd = entries.length > 0 ? (query.page - 1) * ROSTER_PAGE_SIZE + entries.length : 0;
  const hasPrev = query.page > 1;
  const hasNext = query.page * ROSTER_PAGE_SIZE < roster.total;
  const endFinite = Number.isFinite(row.endsAt.getTime());
  const rsvpAction: "rsvp-pause" | "rsvp-reopen" | null =
    row.status === "published" && endFinite && row.endsAt > now
      ? row.rsvpOpen
        ? "rsvp-pause"
        : "rsvp-reopen"
      : null;
  const recovery = rosterRecovery(row.eventKey, query, entries.length, roster.total);
  // Same guard as the Hono edit fill: a corrupt zone or unrenderable instant
  // stays visible for correction but is never formatted.
  const knownTimezone = isKnownTimezone(row.timezone);
  const startFinite = Number.isFinite(row.startsAt.getTime());
  return {
    kind: "ok",
    view: {
      key: row.eventKey,
      title: row.title,
      status: row.status,
      values: {
        title: row.title,
        game: row.game ?? "",
        description: row.description ?? "",
        accessibility_notes: row.accessibilityNotes ?? "",
        // Wall text in the row's zone — what the moderator typed is what they
        // see; the stored instant is preserved by the Hono UTC carriers.
        starts_at: knownTimezone && startFinite ? utcToWall(row.startsAt, row.timezone) : "",
        ends_at: knownTimezone && endFinite ? utcToWall(row.endsAt, row.timezone) : "",
        timezone: row.timezone,
        location: row.location ?? "",
        organizer_name: row.organizer_name ?? "",
        join_url: row.join_url ?? "",
        join_instructions: row.join_instructions ?? "",
        capacity: row.capacity === null ? "" : String(row.capacity),
      },
      errors: {},
      hasErrors: false,
      isDraft: false,
      showPublish: row.status === "draft",
      showCancel: row.status === "draft" || row.status === "published",
      rsvpAction,
      seriesNote: row.recurrenceFrequency
        ? `Part of a ${row.recurrenceFrequency} series. Moving this event moves the not-yet-started occurrences by the same amount.`
        : null,
      endsAt: endFinite ? row.endsAt.toISOString() : "",
      roster: {
        total: roster.total,
        query,
        entries,
        rangeStart,
        rangeEnd,
        rangeText: rosterRangeText(rangeStart, rangeEnd, roster.total),
        statusOptions: ROSTER_STATUSES.map((o) => ({
          value: o.value,
          label: o.label,
          selected: o.value === query.status,
        })),
        hasPrev,
        hasNext,
        prevUrl: hasPrev ? rosterUrl(row.eventKey, query, { page: query.page - 1 }) : null,
        nextUrl: hasNext ? rosterUrl(row.eventKey, query, { page: query.page + 1 }) : null,
        clearUrl: recovery.clearUrl,
        firstUrl: recovery.firstUrl,
        emptyText:
          entries.length === 0
            ? roster.total > 0
              ? "No RSVPs on this page."
              : rosterEmptyText(query)
            : null,
        sortHeaders: [
          sortHeader(row.eventKey, query, "status", "Status"),
          sortHeader(row.eventKey, query, "answered", "Answered"),
        ],
        // The Hono edit action, unencoded like the Hono page's own form target.
        searchAction: `/admin/events/${row.eventKey}#rsvp-roster`,
      },
      pauseReviewHtml:
        rsvpAction === "rsvp-pause" ? renderRsvpPauseReviewHtml(row.title, row.eventKey) : null,
    },
  };
}
