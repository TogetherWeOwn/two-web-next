/**
 * W10 island contracts (TOG-9689): Livewire → islands re-spec.
 *
 * There is no Livewire protocol on Workers. Each island is SSR HTML plus a
 * progressive-enhancement binder in `public/islands/*` with an explicit
 * request budget. This module is the single source of truth for mount
 * attributes, testids, endpoints and polling budgets — the SSR slices
 * (W7 member journeys, W8 events, W9 RSVP) and the binders MUST build from
 * here. The drift tests (`test/islands-*.test.ts`) pin it.
 *
 * Legacy sources (two-web, maintenance-only): `app/Livewire/*.php`,
 * `resources/views/livewire/*.blade.php`, `tests/Feature/Livewire/*`.
 */

/** SSR marks hydratable regions with this attribute, e.g. data-island="going-count". */
export const MOUNT_ATTR = "data-island";

export const ISLANDS = [
  "events-calendar",
  "past-events",
  "going-count",
  "rsvp-button",
  "member-profile",
] as const;

export type IslandName = (typeof ISLANDS)[number];

/**
 * Explicit polling contract per island. `pollMs: null` means NO polling, with
 * the reason recorded — "explicit polling contracts" includes pinning where
 * polling was deliberately not built.
 */
export const POLLING: Record<IslandName, { pollMs: number | null; reason: string }> = {
  "events-calendar": {
    pollMs: null,
    reason:
      "User-driven fetches only (month step, settled search, past drawer, retry); " +
      "at most one request in flight, abort the previous. Events change slowly; Discord is the live channel.",
  },
  "past-events": {
    pollMs: null,
    reason: "Append-only archive; page-turn fetches only, no read loop.",
  },
  "going-count": {
    pollMs: null,
    reason:
      "Event-driven refresh on the going-count-updated CustomEvent; one GET /events.json " +
      "per answered event, non-matching keys fire no request.",
  },
  "rsvp-button": {
    pollMs: null,
    reason: "Writes only against the singular RSVP resource; optimistic states, no read loop.",
  },
  "member-profile": {
    pollMs: null,
    reason: "Edit/save/cancel PATCH flow; no read loop.",
  },
};

/* ------------------------------------------------------------------ endpoints
 * Frozen URLs from the TOG-9671 URL freeze. Query-surface additions (q, month,
 * page) are proposed in the W10 spec doc; W8 finalizes them there.
 */

/** Collection JSON. Carries `going_count` per row (EventResource contract). */
export const EVENTS_JSON_URL = "/events.json";

export const pastEventsUrl = (page: number): string =>
  page > 1 ? `/events/past?page=${page}` : "/events/past";

/* ---------------------------------------------------------------- past-events */

export const PAST_EVENTS_ISLAND = "past-events";
export const PAST_EVENTS_PAGE_SIZE = 20;
export const PAST_EVENTS_TESTID = "past-events";
export const PAST_EVENTS_LIST_TESTID = "past-events-list";
export const PAST_EVENTS_EMPTY_TESTID = "past-events-empty";
export const PAST_EVENTS_OUT_OF_RANGE_TESTID = "past-events-out-of-range";
export const PAST_EVENTS_COPY = {
  empty: "No past events yet.",
  join: "Join the community and help make the next one happen.",
  failed: "Could not load that page. Your current events are still here — try the page link again.",
} as const;

export function pastEventsOutOfRangeCopy(page: number, totalPages: number): string {
  return `Page ${page} is outside the archive. There ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}.`;
}

/** Page turns read SSR HTML; the archive never fetches viewer answers. */
export function pastEventsRequest(page: number): { method: "GET"; url: string } {
  return { method: "GET", url: pastEventsUrl(page) };
}

/** Singular RSVP resource: one answer per member per event (PUT + DELETE). */
export const rsvpUrl = (eventKey: string): string => `/events/${encodeURIComponent(eventKey)}/rsvp`;

export const eventPageUrl = (eventKey: string): string => `/e/${encodeURIComponent(eventKey)}`;

/* ---------------------------------------------------------- events-calendar
 * Legacy: app/Livewire/EventsCalendar.php + events-calendar.blade.php.
 * One rowset rendered twice — list + month grid — in a single SSR pass.
 * Member actions (view toggle, month step, settled search, past drawer,
 * retry, grid day jump) re-fetch the island's page URL and patch the stable
 * zones; `?q=` is URL-bound so a search is a shareable link. Every control is
 * a real anchor, so the whole surface works without JavaScript.
 */

export const EVENTS_CALENDAR_ISLAND = "events-calendar";
export const EVENTS_CALENDAR_TESTID = "events-calendar";

/** The two views are one query rendered twice — never two components. */
export const CALENDAR_VIEWS = ["list", "calendar"] as const;
export type CalendarView = (typeof CALENDAR_VIEWS)[number];
export const CALENDAR_DEFAULT_VIEW: CalendarView = "list";

/** `view` is URL input: an unknown name returns null so the caller keeps the current view. */
export function parseCalendarView(raw: string | null | undefined): CalendarView | null {
  return raw === "list" || raw === "calendar" ? raw : null;
}

export const EVENTS_VIEW_GROUP_LABEL = "How to show the events";
export const EVENTS_VIEW_LIST_TESTID = "events-view-list";
export const EVENTS_VIEW_CALENDAR_TESTID = "events-view-calendar";
export const EVENTS_VIEW_STATUS_TESTID = "events-view-status";
export const eventsViewStatusCopy = (view: CalendarView): string =>
  view === "list" ? "Showing events as a list." : "Showing events as a calendar.";

/* Search. Server-side LIKE on title+description, term bound and wildcard-escaped;
 * a blank query is no search; any search forces the list view; matching past
 * rows render without opening the drawer. `?q=` carries the RAW input — the
 * same string the member typed — so the shared URL reproduces the view. */
export const EVENTS_SEARCH_TESTID = "events-search";
export const EVENTS_SEARCH_CLEAR_TESTID = "events-search-clear";
export const EVENTS_SEARCH_CLEAR_EMPTY_TESTID = "events-search-clear-empty";
export const EVENTS_SEARCH_STATUS_TESTID = "events-search-status";
export const EVENTS_SEARCH_DEBOUNCE_MS = 300;
export const EVENTS_SEARCH_MAX_LENGTH = 255;
export const EVENTS_SEARCH_PLACEHOLDER = "Search events…";
export const EVENTS_SEARCH_LABEL = "Search events";
export const eventsSearchHitCopy = (query: string): string => `Results for “${query}”`;
export const eventsSearchMissCopy = (query: string): string => `Nothing matches “${query}”.`;

/** Logger normalization (legacy EventSearchLogger::normalize): collapse
 * whitespace, lowercase, cap at the column width, blank means "not a search". */
export function normalizeEventSearch(raw: string | null | undefined): string | null {
  const normalized = (raw ?? "").trim().replace(/\s+/g, " ").toLowerCase();
  if (normalized === "") return null;
  return [...normalized].slice(0, EVENTS_SEARCH_MAX_LENGTH).join("");
}

/** `%`, `_` and the escape char itself, so LIKE input can only ever mean itself. */
export function escapeLikeTerm(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** One structured line per rendered search: normalized query + visible count.
 * No user id, no session, no IP, no raw input. Fail-open — logging never
 * breaks the page. The durable table (TOG-10105) swaps the sink, not this shape. */
export interface EventSearchLogEntry {
  event: "event_search";
  query: string;
  results: number;
}
export function eventSearchLogEntry(raw: string, results: number): EventSearchLogEntry | null {
  const query = normalizeEventSearch(raw);
  return query === null ? null : { event: "event_search", query, results: Math.max(0, results) };
}

/* Past drawer (legacy showPast): opens one way, stays open; searching reveals
 * past matches regardless. The drawer is an island addition — the legacy blade
 * dropped the visible trigger when the archive page shipped. */
export const EVENTS_PAST_TOGGLE_TESTID = "events-past-toggle";
export const EVENTS_PAST_TOGGLE_COPY = "Show past events";
export const EVENTS_PAST_LIST_TESTID = "events-past-list";
export const EVENTS_PAST_LIST_HEADING = "Past events";
export const EVENTS_PAST_STATUS_TESTID = "events-past-status";
export const EVENTS_PAST_STATUS_COPY = "Showing past events.";
export const EVENTS_PAST_ARCHIVE_LINK_TESTID = "events-past-archive-link";
export const EVENTS_SUBSCRIBE_TESTID = "events-subscribe";
export const EVENTS_SUBSCRIBE_URL = "/events.ics";
export const EVENTS_PAST_DRAWER_LIMIT = 20;
export const EVENTS_GAP_LIST_LIMIT = 5;

/* Skeleton + content: member-started re-renders show the skeleton and hide the
 * content — except typing in the search box, which is deliberately untargeted. */
export const EVENTS_LOADING_TESTID = "events-loading";
export const EVENTS_LOADING_COPY = "Loading events…";
export const EVENTS_LOADING_ROWS = 3;
export const EVENTS_CONTENT_TESTID = "events-content";
export const EVENTS_LIST_TESTID = "events-list";
export const EVENTS_LIST_HEADING_SR = "Upcoming events";
/** Stable status line for fragment-fetch failures; content is preserved. */
export const EVENTS_CAL_FEEDBACK = "data-cal-feedback";
export const EVENTS_CALENDAR_FETCH_FAILED = "Couldn't refresh the events — try again.";

/* Empty states: never / gap (with past list) / error (role=alert + Retry) /
 * search-miss. The error state means a read failed — it must never read as
 * "no events". */
export const EVENTS_EMPTY_NEVER_TESTID = "events-empty-never";
export const EVENTS_EMPTY_GAP_TESTID = "events-empty-gap";
export const EVENTS_EMPTY_GAP_LIST_TESTID = "events-empty-gap-list";
export const EVENTS_EMPTY_GAP_ITEM_TESTID = "events-empty-gap-item";
export const EVENTS_EMPTY_ERROR_TESTID = "events-empty-error";
export const EVENTS_EMPTY_SEARCH_TESTID = "events-empty-search";
export const EVENTS_RETRY_TESTID = "events-retry";
export const DISCORD_JOIN_TESTID = "discord-join";
export const EVENTS_EMPTY_COPY = {
  neverTitle: "Nothing on the calendar yet.",
  neverBody:
    "Game nights get posted here first. Join the Discord and you'll see them before they land on this page.",
  gapTitle: "No upcoming events — check back soon.",
  gapListHeading: "Past events",
  errorTitle: "We couldn't load the calendar.",
  errorBody: "The Discord always has the latest — come ask there.",
  retry: "Retry",
  join: "Join the Discord",
  searchMissTitle: "Nothing matches that search.",
  searchMissBody: "Titles and descriptions are what's searched — try a different word.",
  searchMissClear: "Clear the search",
  searchClear: "Clear",
  pastArchive: "Past events",
  subscribe: "Subscribe",
  discordRsvp: "RSVP in Discord",
  signIn: "Sign in with Discord",
} as const;

/* Month grid: whole weeks, Monday-first, leading/trailing neighbours flagged;
 * "today" is evaluated in the hosts' zone, not the server's or the viewer's. */
export const EVENTS_CALENDAR_SCROLL_TESTID = "events-calendar-scroll";
export const EVENTS_CALENDAR_SCROLL_LABEL = "Events calendar; scroll horizontally to see all days";
export const EVENTS_CALENDAR_GRID_TESTID = "events-calendar-grid";
export const CALENDAR_MONTH_TESTID = "calendar-month";
export const CALENDAR_MONTH_STATUS_TESTID = "calendar-month-status";
export const CALENDAR_DAY_TESTID = "calendar-day";
export const WEEKDAY_HEADINGS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
export const CALENDAR_PREV_LABEL = "Previous month";
export const CALENDAR_NEXT_LABEL = "Next month";
export const GRID_TITLE_MAX = 18;

export const EVENT_CARD_TESTID = "event-card";
export const EVENT_DRAFT_TESTID = "event-draft";
export const EVENT_CANCELLED_TESTID = "event-cancelled";
export const EVENT_DISCORD_RSVP_TESTID = "event-discord-rsvp";

const MONTH_RE = /^(\d{1,4})-(\d{1,2})$/;

/** Years 0001–9999, padding optional; year zero/bad input → caller falls back. */
export function parseCalendarMonth(raw: string | null | undefined): string | null {
  const m = raw ? MONTH_RE.exec(raw) : null;
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (year < 1 || month < 1 || month > 12) return null;
  return `${m[1]!.padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

/** Month steps saturate at 0001-01/9999-12, never emitting an unsupported URL. */
export function addCalendarMonth(month: string, delta: number): string {
  const parsed = parseCalendarMonth(month);
  if (!parsed || !Number.isInteger(delta)) return month;
  const [y, m] = parsed.split("-").map(Number);
  const total = Math.max(12, Math.min(9999 * 12 + 11, y! * 12 + (m! - 1) + delta));
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}`;
}

/** Unlike Date.UTC, setUTCFullYear constructs years 1–99 literally. */
function calendarDate(year: number, monthIndex: number, day: number): Date {
  const date = new Date(0);
  date.setUTCFullYear(year, monthIndex, day);
  return date;
}

export function calendarMonthLabel(month: string): string {
  const [y, m] = month.split("-").map(Number);
  return new Intl.DateTimeFormat("en-GB", {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(calendarDate(y!, m! - 1, 1));
}

export function isValidZone(zone: string | null | undefined): boolean {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function partsIn(
  instant: Date,
  zone: string,
  opts: Intl.DateTimeFormatOptions,
): Map<string, string> {
  const z = isValidZone(zone) ? zone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: z, ...opts }).formatToParts(instant);
  return new Map(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

/** Canonical ISO wall date, including expanded years (invalid zones read as UTC). */
export function wallDateIso(instant: Date, zone: string): string {
  const p = partsIn(instant, zone, {
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  // Intl's Gregorian year is era-relative: 1 BC is astronomical year zero.
  const year = Number(p.get("year"));
  const isoYear = p.get("era") === "BC" ? 1 - year : year;
  return calendarDate(isoYear, Number(p.get("month")) - 1, Number(p.get("day")))
    .toISOString()
    .split("T")[0]!;
}

/** "HH:mm" 24-hour wall time in `zone` (invalid zones read as UTC). */
export function wallTimeHm(instant: Date, zone: string): string {
  const p = partsIn(instant, zone, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  return `${p.get("hour")}:${p.get("minute")}`;
}

/** ISO wall month in `zone`; unsupported years remain rejectable by the parser. */
export function wallMonth(instant: Date, zone: string): string {
  return wallDateIso(instant, zone).slice(0, -3);
}

/** "Fri 4 Nov, 20:00" — the card's human time in the host zone (legacy 'D j M, H:i'). */
export function cardTimeLabel(instant: Date, zone: string): string {
  const z = isValidZone(zone) ? zone : "UTC";
  const p = partsIn(instant, z, { weekday: "short", day: "numeric", month: "short" });
  return `${p.get("weekday")} ${p.get("day")} ${p.get("month")}, ${wallTimeHm(instant, z)}`;
}

/**
 * The zone the grid's "today" is evaluated in: the modal timezone of the shown
 * rows (the community's zone in practice), validated against IANA, UTC when
 * there are no rows. Legacy calendarZone(): first modal zone wins on ties,
 * an unparseable winner falls back to the app zone rather than the runner-up.
 */
export function calendarZone(timezones: Iterable<string | null | undefined>): string {
  const counts = new Map<string, number>();
  for (const tz of timezones) {
    if (tz) counts.set(tz, (counts.get(tz) ?? 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top && isValidZone(top[0]) ? top[0] : "UTC";
}

/** Bad/absent `month` falls back to this month (UTC) — a wrong month is a page, not a 500. */
export function currentCalendarMonth(now: Date): string {
  return wallMonth(now, "UTC");
}

export interface CalendarDay<E = unknown> {
  /** ISO date; trailing neighbours after 9999-12 use the expanded year +010000. */
  iso: string;
  /** Day of month (1–31). */
  day: number;
  inMonth: boolean;
  isToday: boolean;
  events: E[];
}

/** Whole-weeks Monday-first grid for `month`; `byDay` buckets rows by their host-zone date. */
export function monthGrid<E>(
  month: string,
  todayIso: string,
  byDay: Map<string, E[]>,
): CalendarDay<E>[][] {
  const m = MONTH_RE.exec(month);
  const y = Number(m![1]);
  const mo = Number(m![2]);
  const first = calendarDate(y, mo - 1, 1).getTime();
  const last = calendarDate(y, mo, 0).getTime();
  const leadDays = (new Date(first).getUTCDay() + 6) % 7; // Monday index of the 1st
  const trailDays = 6 - ((new Date(last).getUTCDay() + 6) % 7);
  const weeks: CalendarDay<E>[][] = [];
  let week: CalendarDay<E>[] = [];
  for (let t = first - leadDays * 86_400_000; t <= last + trailDays * 86_400_000; t += 86_400_000) {
    const d = new Date(t);
    const iso = d.toISOString().split("T")[0]!;
    week.push({
      iso,
      day: d.getUTCDate(),
      inMonth: d.getUTCFullYear() === y && d.getUTCMonth() === mo - 1,
      isToday: iso === todayIso,
      events: byDay.get(iso) ?? [],
    });
    if (week.length === 7) {
      weeks.push(week);
      week = [];
    }
  }
  return weeks;
}

/** Grid cell link text: host-zone "HH:mm" + title capped at GRID_TITLE_MAX chars. */
export function gridTitle(title: string): string {
  const chars = [...title];
  return chars.length > GRID_TITLE_MAX ? `${chars.slice(0, GRID_TITLE_MAX).join("")}…` : title;
}

/* Discord-native rows (TOG-5168): display-only transients merged into the
 * upcoming list in start order — never persisted, never published, never
 * handed to the write-back. A transient card shows the Discord RSVP link and
 * no going count. */
export interface DiscordTransient {
  /** Discord scheduled-event id; also the dedupe key against discord_event_id. */
  discordId: string;
  status: "scheduled" | "active";
  title: string;
  description: string | null;
  location: string | null;
  startsAt: Date;
  /** Voice/stage events can remain scheduled/active without an announced end. */
  endsAt: Date | null;
}

/** Transient card anchor key: "discord-<id>" so grid jumps land on its card. */
export const transientEventKey = (discordId: string): string => `discord-${discordId}`;

/** Anything the calendar renders in a list/grid has at least a start instant. */
export interface CalendarEntry {
  startsAt: Date;
}

/** Persisted rows + Discord transients, one sequence in start order. */
export function mergeCalendarRows<E extends CalendarEntry>(
  rows: E[],
  transients: DiscordTransient[],
): (E | DiscordTransient)[] {
  return [...rows, ...transients].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** A Discord row whose id already exists locally would double-render — the synced row wins. */
export function dedupeTransients(
  transients: DiscordTransient[],
  persistedDiscordIds: ReadonlySet<string>,
): DiscordTransient[] {
  return transients.filter((t) => !persistedDiscordIds.has(t.discordId));
}

/* Resolved island state. `q` is the raw input; searching = trimmed non-blank.
 * `month` is always resolved (the grid is one render away via the toggle). */
export interface CalendarState {
  view: CalendarView;
  month: string;
  q: string;
  past: boolean;
}

/** Whether this state is a search (blank input is no search). */
export const calendarSearching = (s: { q: string }): boolean => s.q.trim() !== "";

/** Whether the past drawer renders (opened, or forced open by a search). */
export const calendarShowingPast = (s: CalendarState): boolean => s.past || calendarSearching(s);

/**
 * The island's shareable URL. `view`/`month` are emitted only for the calendar
 * view (the list is the default and a search forces it); `q` only when
 * non-blank; `past` only when open.
 */
export function calendarUrl(s: CalendarState): string {
  const params = new URLSearchParams();
  if (s.q.trim() !== "") params.set("q", s.q);
  if (s.past) params.set("past", "1");
  if (s.view === "calendar") {
    params.set("view", "calendar");
    params.set("month", s.month);
  }
  const qs = params.toString();
  return qs === "" ? "/events" : `/events?${qs}`;
}

/**
 * Which empty state renders — error beats everything, including a search miss
 * (a failed read must never read as "no events"); a search suppresses the
 * never/gap states (its own miss block renders instead).
 */
export type CalendarEmptyState = "never" | "gap" | "error" | null;
export function calendarEmptyState(s: {
  searching: boolean;
  upcomingEmpty: boolean;
  pastEmpty: boolean;
  readFailed: boolean;
}): CalendarEmptyState {
  if (s.upcomingEmpty && s.readFailed) return "error";
  if (s.searching) return null;
  if (s.upcomingEmpty) return s.pastEmpty ? "never" : "gap";
  return null;
}

/** One GET per member action — the SSR page URL, not a data endpoint. */
export function calendarRequest(s: CalendarState): {
  method: "GET";
  url: string;
  accept: "text/html";
} {
  return { method: "GET", url: calendarUrl(s), accept: "text/html" };
}

/* --------------------------------------------------------------- going-count
 * Legacy: app/Livewire/GoingCount.php + going-count.blade.php (TOG-7966).
 * The badge lives outside the RSVP control, so a write must refresh it.
 * Re-spec: the button island broadcasts a DOM CustomEvent; this island
 * re-reads the aggregate from the frozen collection — never trusts the
 * writer's copy.
 */

export const GOING_COUNT_ISLAND = "going-count";
export const GOING_COUNT_TESTID = "event-going-count";
export const SPOTS_LEFT_TESTID = "event-spots-left";
/** DOM CustomEvent replacing the Livewire `going-count-updated` broadcast. */
export const GOING_UPDATED_EVENT = "going-count-updated";

export type GoingViewerState = "going" | "waitlisted" | "none" | "other";

export interface GoingCountState {
  going: number;
  capacity: number | null;
  showSpotsLeft: boolean;
  announcement: GoingViewerState | null;
}

export function goingAnnouncementText(a: GoingViewerState | null): string {
  switch (a) {
    case "going":
      return "You're going.";
    case "waitlisted":
      return "You're on the waitlist.";
    case "none":
      return "RSVP removed.";
    default:
      return "";
  }
}

/** "N of M going" with a cap, "N going" without — never invents a number. */
export function goingCountText(going: number, capacity: number | null): string {
  return capacity !== null ? `${going} of ${capacity} going` : `${going} going`;
}

export function spotsLeftText(going: number, capacity: number): string {
  const left = Math.max(0, capacity - going);
  return left <= 0 ? "Full" : `${left} of ${capacity} spots left`;
}

/**
 * Server-rendered badge HTML (the event page renders this; the binder only
 * patches the [data-count]/[data-spots]/[data-announcement] nodes in place).
 * `role="status"`: updates announce politely, never as an alert. The
 * announcement node is always rendered (empty before any write) so the
 * binder has a stable target; an empty node announces nothing, so page
 * load stays quiet — same observable behavior the legacy test pins.
 * The spots-left line sits inside the mount so the binder reaches it with
 * one querySelector and patches only its own island.
 */
export function renderGoingCount(eventKey: string, s: GoingCountState): string {
  const announcement = goingAnnouncementText(s.announcement);
  const safeKey = eventKey.replace(/"/g, "&quot;");
  const spots =
    s.showSpotsLeft && s.capacity !== null
      ? ` · <span data-testid="${SPOTS_LEFT_TESTID}" data-spots>${spotsLeftText(s.going, s.capacity)}</span>`
      : "";
  return (
    `<span role="status" data-testid="${GOING_COUNT_TESTID}" ` +
    `${MOUNT_ATTR}="${GOING_COUNT_ISLAND}" data-event-key="${safeKey}" data-capacity="${s.capacity ?? ""}">` +
    `<span class="sr-only" data-announcement>${announcement}${announcement ? " " : ""}</span>` +
    `<span data-count>${goingCountText(s.going, s.capacity)}</span>${spots}</span>`
  );
}

/* -------------------------------------------------------- going-count fetch */

export interface GoingRefreshRequest {
  method: "GET";
  url: string;
  eventKey: string;
}

/** One request per answered event, filtered before collection pagination. */
export function goingRefreshRequest(eventKey: string): GoingRefreshRequest {
  return {
    method: "GET",
    url: `${EVENTS_JSON_URL}?event_key=${encodeURIComponent(eventKey)}`,
    eventKey,
  };
}

export interface EventJsonRow {
  event_key: string;
  going_count: number;
}

/** Pick this island's aggregate out of the collection; null when absent. */
export function applyGoingRefresh(rows: EventJsonRow[], eventKey: string): number | null {
  const row = rows.find((r) => r.event_key === eventKey);
  return row ? row.going_count : null;
}

/** Listener-side skip: another card's answer fires no request here. */
export function shouldRefreshGoing(detailKey: string, islandKey: string): boolean {
  return detailKey === islandKey;
}

/* --------------------------------------------------------------- rsvp-button
 * Legacy: app/Livewire/RsvpButton.php + rsvp-button.blade.php +
 * tests/Feature/Livewire/RsvpButtonTest.php, pinned at two-web main.
 * Row origins: TOG-8135 session-expiry, TOG-7976 throttle copy (CM-frozen),
 * TOG-6956 focus moves, TOG-6990 syncing-vs-failed, TOG-8715 honeypot
 * swallow, TOG-9354 419 interceptor, TOG-8725 moderator pause. Abuse
 * surface: two-web PR #431 (TOG-7297 all-clear) with the clock-ended hole
 * tracked as TOG-7419.
 *
 * Slice 2 adds the SSR form and shipped binder. Drift tests execute both.
 * Writes serialize until the response body settles; an abort cannot undo a
 * transaction, so repeated activations during saving fire no replacement.
 *
 * NOTE on re-spec §2: it lists PUT statuses as "going / waitlisted / none".
 * Legacy accepts the full RsvpStatus enum and "none" is the withdraw
 * viewerState, never a PUT body. Contract wins: the island PUT accepts the
 * full enum; TOG-9839 resolves the doc line against W9.
 */

export const RSVP_BUTTON_ISLAND = "rsvp-button";

/** Frozen testids (legacy blade `data-testid`, W8/W15 selector port targets). */
export const RSVP_GOING_TESTID = "rsvp-going";
export const RSVP_WITHDRAW_TESTID = "rsvp-withdraw";
export const RSVP_CONFIRMED_TESTID = "rsvp-confirmed";
export const RSVP_CHECK_TESTID = "rsvp-check";
export const RSVP_CLOSED_TESTID = "rsvp-closed";
export const RSVP_PAUSED_TESTID = "rsvp-paused";
export const EVENT_FULL_TESTID = "event-full";
export const WAITLIST_JOIN_TESTID = "waitlist-join";
export const WAITLIST_POSITION_TESTID = "waitlist-position";
export const WAITLIST_CLAIM_TESTID = "waitlist-claim";
export const WAITLIST_LEAVE_TESTID = "waitlist-leave";
export const RSVP_SYNCING_TESTID = "rsvp-syncing";
export const RSVP_SYNC_FAILED_TESTID = "rsvp-sync-failed";
export const RSVP_SYNCED_TESTID = "rsvp-synced";
export const RSVP_RATE_LIMITED_TESTID = "rsvp-rate-limited";
export const RSVP_FAILED_TESTID = "rsvp-failed";
export const RSVP_UNKNOWN_TESTID = "rsvp-unknown";
export const RSVP_REFRESH_TESTID = "rsvp-refresh";
export const RSVP_SESSION_EXPIRED_TESTID = "rsvp-session-expired";

/** Full legacy RsvpStatus enum: the PUT body accepts every value. */
export const RSVP_STATUSES = ["going", "maybe", "not_going", "waitlisted"] as const;

export type RsvpWriteStatus = (typeof RSVP_STATUSES)[number];

/** One request per click against the singular resource (re-spec §2). */
export interface RsvpWriteRequest {
  method: "PUT";
  url: string;
  eventKey: string;
  body: { status: RsvpWriteStatus };
}

export function rsvpWriteRequest(eventKey: string, status: RsvpWriteStatus): RsvpWriteRequest {
  return { method: "PUT", url: rsvpUrl(eventKey), eventKey, body: { status } };
}

export interface RsvpWithdrawRequest {
  method: "DELETE";
  url: string;
  eventKey: string;
}

export function rsvpWithdrawRequest(eventKey: string): RsvpWithdrawRequest {
  return { method: "DELETE", url: rsvpUrl(eventKey), eventKey };
}

/**
 * Status-code shape (legacy controller + PR #431 abuse pins): first answer
 * creates the row (201), re-answer updates it (200), withdraw is a quiet
 * 204 — including withdraw-without-a-row and withdraw-from-cancelled.
 * Status-Past PUT refuses 403 with nothing written; off-verb hits 405.
 */
export const RSVP_FIRST_WRITE_STATUS = 201;
export const RSVP_REANSWER_STATUS = 200;
export const RSVP_WITHDRAW_STATUS = 204;
export const RSVP_CLOSED_WRITE_STATUS = 403;
export const RSVP_WRONG_METHOD_STATUS = 405;

export const RSVP_ABUSE_PINS = {
  doubleSubmit: [RSVP_FIRST_WRITE_STATUS, RSVP_REANSWER_STATUS],
  crossUserDeleteVictimRowKept: RSVP_WITHDRAW_STATUS,
  methodTampering: RSVP_WRONG_METHOD_STATUS,
  withdrawWithoutRow: RSVP_WITHDRAW_STATUS,
  statusPastPut: RSVP_CLOSED_WRITE_STATUS,
  withdrawFromCancelled: RSVP_WITHDRAW_STATUS,
} as const;

/**
 * Broadcast mapping for the going-count badge (legacy `going-count-updated`
 * dispatch): Going → going, Waitlisted → waitlisted, withdraw → none,
 * every other answer (maybe / not_going) → other. Fired on every
 * successful write, up and down.
 */
export function rsvpViewerState(status: RsvpWriteStatus | "withdraw"): GoingViewerState {
  if (status === "going") return "going";
  if (status === "waitlisted") return "waitlisted";
  if (status === "withdraw") return "none";
  return "other";
}

export interface RsvpBroadcast {
  event: typeof GOING_UPDATED_EVENT;
  eventKey: string;
  viewerState: GoingViewerState;
}

export function rsvpBroadcast(eventKey: string, viewerState: GoingViewerState): RsvpBroadcast {
  return { event: GOING_UPDATED_EVENT, eventKey, viewerState };
}

/** Member-visible copy, pinned verbatim (CM-frozen rows noted). */
export const RSVP_COPY = {
  cta: "I'm in",
  saving: "Saving…",
  confirmed: "You're in",
  withdraw: "Can't make it",
  removing: "Removing…",
  full: "This one's full.",
  waitlistJoin: "Join the waitlist",
  waitlistFallback: "You're on the waitlist",
  waitlistClaim: "A seat opened up — I'm in",
  waitlistLeave: "Leave the waitlist",
  syncing: "Saved. Syncing to Discord.",
  syncFailed: "Saved. Discord sync didn't go through — your spot is still held.",
  synced: "Synced to Discord.",
  failedTitle: "That RSVP didn't save.",
  failedAction: "Try once more.",
  unknown: "We couldn't confirm your RSVP. Check the event before trying again.",
  refresh: "Refresh the event",
  paused: "RSVPs are paused for this event — check back soon.",
  sessionExpired: "Your session expired.",
  guestCta: "Log in with Discord",
} as const;

/** Closed-event copy by reason (legacy closed branch, role=status). */
export type RsvpClosedReason = "cancelled" | "draft" | "past";

export function rsvpClosedCopy(reason: RsvpClosedReason): string {
  switch (reason) {
    case "cancelled":
      return "Cancelled";
    case "draft":
      return "Not published yet";
    case "past":
      return "This one has been and gone";
  }
}

/** "Cap is N." names the cap beside the full message. */
export function rsvpFullCapCopy(capacity: number): string {
  return `Cap is ${capacity}.`;
}

/** One-based place in line, in words and digits, never colour alone. */
export function waitlistPositionCopy(position: number | null): string {
  return position === null
    ? RSVP_COPY.waitlistFallback
    : `You're on the waitlist — #${position} in line`;
}

/**
 * Announced throttle wait (TOG-7976, CM-frozen — do not reword without CM
 * sign-off). {N} is the ceiling of Retry-After, min 1; an unusable header
 * selects the "in a moment" fallback instead of a number.
 */
export function throttleWaitCopy(retryAfterSeconds: number | null): string {
  if (retryAfterSeconds === null) {
    return "Slow down — try again in a moment. Nothing changed, just wait a bit.";
  }
  const s = retryAfterSeconds === 1 ? "1 second" : `${retryAfterSeconds} seconds`;
  return `Slow down — try again in ${s}. Nothing changed, just wait a moment.`;
}

/**
 * Focus targets after the re-render swap (TOG-6956). A successful write
 * replaces the focused control, so the binder moves focus to the new state;
 * on failure the button stays put and focus stays (null). Withdraw falls
 * back down the list to whichever join control rendered.
 */
export function rsvpFocusTargets(
  outcome: "confirmed" | "waitlisted" | "withdrawn" | "failed",
): string[] | null {
  switch (outcome) {
    case "confirmed":
      return [RSVP_CONFIRMED_TESTID];
    case "waitlisted":
      return [WAITLIST_POSITION_TESTID];
    case "withdrawn":
      return [RSVP_GOING_TESTID, WAITLIST_JOIN_TESTID];
    case "failed":
      return null;
  }
}

/**
 * Guest/session-expired return path (TOG-9254/TOG-8135): the login link
 * carries the page path captured at SSR — never the update endpoint — so
 * Discord sends the member back to the page. Null for a bare link.
 */
export function loginUrl(returnTo: string | null): string {
  return returnTo ? `/join/discord?next=${encodeURIComponent(returnTo)}` : "/join/discord";
}

/** Shared write budget, both verbs, per member (legacy RsvpRateLimit). */
export const RSVP_RATE_LIMIT = { maxAttempts: 12, decaySeconds: 60 } as const;

/**
 * Abuse decoy: field no real form renders visibly; no minimum-fill
 * floor — the click island sends no form-open timestamp, so
 * there is nothing to time. A filled decoy on PUT answers the
 * byte-identical first-write success shape (201, null mirror stamp) without
 * touching limiter/auth/DB, and on DELETE the same empty 204 — nothing
 * attacker-shaped logged. The click island itself carries no trap: a bare
 * click with no inputs and a human-speed tap must never trip it. The 1000 ms
 * timing floor belongs to the profile form only (PROFILE_MIN_FILL_MS).
 */
export const RSVP_HONEY_FIELD = "website";

/**
 * Trap verdict: true when the honeypot value is filled. A present non-string
 * value counts as filled (fail-closed); absent/empty inputs are genuine
 * clicks and never trip. Arrays — duplicate query/form keys, parsed with all
 * values preserved — trip when ANY element is filled, so a filled duplicate
 * can never hide behind an empty sibling. Honeypot half of
 * profileTrapTripped, without the profile form's opened-at floor (the RSVP
 * click island carries no trap).
 */
export function rsvpHoneyFilled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(rsvpHoneyFilled);
  return typeof value === "string" ? value !== "" : value !== undefined && value !== null;
}

/** True when a PUT body carries a filled honeypot and the write must be swallowed. */
export function rsvpTrapTripped(input: Record<string, unknown>): boolean {
  return rsvpHoneyFilled(input[RSVP_HONEY_FIELD]);
}

/* ------------------------------------------------------------ member-profile
 * Legacy: app/Livewire/MemberProfile.php + member-profile.blade.php +
 * MemberProfileTest.php (TOG-8137 session-first ordering, TOG-6957 focus
 * moves, TOG-8715/TOG-9361 oracle-free trap). Server: src/profiles/routes.tsx
 * (W7, TOG-9686). Re-spec §5.
 *
 * Deviations from the legacy row list, recorded so nobody hunts for them:
 * - Rank has no W7 source yet; the view renders it only when SSR is handed
 *   one (`MemberView.rank`), never a placeholder. Joined month comes from
 *   users.created_at.
 * - The save is one PATCH /members/{id} sent as JSON with `accept:
 *   application/json`; the no-JS form posts `_method=PATCH` and gets the same
 *   outcome as a 303.
 */

export const MEMBER_PROFILE_ISLAND = "member-profile";

export const PROFILE_VIEW_TESTID = "profile-view";
export const PROFILE_AVATAR_TESTID = "profile-avatar";
export const PROFILE_NAME_TESTID = "profile-name";
export const PROFILE_RANK_TESTID = "profile-rank";
export const PROFILE_JOINED_TESTID = "profile-joined";
export const PROFILE_EDIT_TESTID = "profile-edit";
export const PROFILE_FORM_TESTID = "profile-form";
export const PROFILE_SAVE_TESTID = "profile-save";
export const PROFILE_CANCEL_TESTID = "profile-cancel";
export const PROFILE_SAVED_TESTID = "profile-saved";
export const PROFILE_ERROR_TESTID = "profile-error";
export const PROFILE_SAVE_FAILED_TESTID = "profile-save-failed";
export const PROFILE_SESSION_EXPIRED_TESTID = "profile-session-expired";
export const PROFILE_UNCERTAIN_TESTID = "profile-uncertain";

/**
 * Owned client deadline for a profile save, covering fetch plus
 * response-body completion (TOG-11625). Finite and wall-clock: when it passes
 * before the single in-flight PATCH settles, the binder aborts the owned
 * fetch where AbortController exists, shows the uncertain notice with the
 * draft intact, and releases the controls. Timeout ownership ends there — a
 * late completion can never replace newer feedback or mutate the accepted
 * baseline, cancel disposes the timer/abort, and the timeout is never
 * represented as a server rollback (no automatic resend, no second PATCH
 * while the earlier write remains unsettled). The unsettled-write admission
 * gate itself is owned elsewhere; this deadline only bounds the feedback.
 */
export const PROFILE_SAVE_DEADLINE_MS = 10_000;

export const PROFILE_LIMITS = { bio: 1000, gamesMax: 20, gameChars: 80 } as const;

export const PROFILE_COPY = {
  saved: "Profile saved.",
  saveFailed: "Could not save your profile. Your changes are still here — try again.",
  sessionExpired: "Your session expired. Your changes are still here.",
  uncertain:
    "Still saving — this is taking longer than expected. It may still have gone through; wait a moment, then save again if nothing changed.",
  logIn: "Log in with Discord",
  edit: "Edit profile",
  save: "Save",
  cancel: "Cancel",
} as const;

/**
 * Empty-state copy, owner-aware: the owner is told what to add,
 * visitors are told what is missing, and a profile with nothing filled in
 * reads as new rather than neglected. The binder only ever runs for the
 * owner, so it mirrors the `*Owner`/`bioNew` strings verbatim.
 */
export const PROFILE_EMPTY_COPY = {
  bioOwner: "You have not added a bio yet.",
  bioOther: (name: string) => `${name} has not added a bio yet.`,
  bioNew: "New here. More soon.",
  gamesOwner: "Add the games you keep coming back to.",
  gamesOther: "No games listed yet.",
  timezoneOwner: "Add yours so people know when you are around.",
  timezoneOther: "Not listed yet.",
} as const;

export const PROFILE_NEW_MEMBER_TESTID = "profile-new-member";
export const PROFILE_NEW_MEMBER_CTA_TESTID = "profile-new-member-cta";
export const PROFILE_NEW_MEMBER_COPY = {
  heading: "Your profile has room to grow.",
  body: "Add a bio, a few games and your timezone so people know when to find you.",
  cta: "Add profile details",
} as const;

/** New member: nothing the member can edit has been filled in yet. */
export function profileIsNewMember(profile: {
  bio: string | null;
  games: readonly string[];
  timezone: string | null;
}): boolean {
  return !profile.bio && profile.games.length === 0 && !profile.timezone;
}

/** Spam trap (TOG-8715/TOG-9361): decoy field + server-side open-time floor. */
export const PROFILE_HONEY_FIELD = "website";
export const PROFILE_OPENED_AT_FIELD = "formOpenedAt";
export const PROFILE_MIN_FILL_MS = 1000;

/** The one exposure rule: only the owner is ever handed an edit control. */
export function profileEditVisible(viewerId: string, memberId: string): boolean {
  return viewerId === memberId;
}

export interface ProfileWriteBody {
  bio: string;
  games_text: string;
  timezone: string;
  website: string;
  formOpenedAt: number;
}

export interface ProfileWriteRequest {
  method: "PATCH";
  url: string;
  body: ProfileWriteBody;
}

/** Exactly one PATCH per save; cancel fires nothing. */
export function profileWriteRequest(memberId: string, body: ProfileWriteBody): ProfileWriteRequest {
  return { method: "PATCH", url: `/members/${encodeURIComponent(memberId)}`, body };
}

const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Client-side mirror of the server rules; the server stays authoritative. */
export function profileClientErrors(input: {
  bio: string;
  games_text: string;
  timezone: string;
}): Record<string, string> {
  const errors: Record<string, string> = {};
  if (
    CONTROL_CHARS.test(input.bio) ||
    CONTROL_CHARS.test(input.games_text) ||
    CONTROL_CHARS.test(input.timezone)
  ) {
    errors.control = "Remove control characters.";
  }
  if ([...input.bio].length > PROFILE_LIMITS.bio)
    errors.bio = "Keep your bio to 1000 characters or fewer.";
  const games: string[] = [];
  for (const line of input.games_text.split(/\r\n|\r|\n/)) {
    const t = line.trim();
    if ([...t].length > PROFILE_LIMITS.gameChars)
      errors.games ??= "Keep each game name to 80 characters or fewer.";
    if (t !== "" && !games.includes(t)) games.push(t);
  }
  if (games.length > PROFILE_LIMITS.gamesMax) errors.games ??= "Add no more than 20 games.";
  if (input.timezone !== "") {
    try {
      new Intl.DateTimeFormat("en", { timeZone: input.timezone });
    } catch {
      errors.timezone = "Choose a valid IANA timezone, e.g. Europe/London.";
    }
  }
  return errors;
}

/**
 * Admin event/featured editor session-expiry notice (TOG-12399): the island
 * vetoes the probe reload so the unsaved draft stays reachable, releases the
 * dirty guard for the recovery trip, and shows this durable notice with the
 * recovery link from the event detail.
 */
export const ADMIN_SESSION_EXPIRED_TESTID = "admin-session-expired";
export const ADMIN_SESSION_EXPIRED_COPY = "Your session expired. Your changes are still here.";

export type ProfileOutcome =
  | "saved"
  | "invalid"
  | "failed"
  | "session-expired"
  | "uncertain"
  | "cancelled";

/** Focus after each outcome: heading, alert, or saved confirmation (TOG-6957). */
export function profileFocusTarget(outcome: ProfileOutcome): string | null {
  switch (outcome) {
    case "saved":
      return PROFILE_SAVED_TESTID;
    case "invalid":
      return PROFILE_ERROR_TESTID;
    case "failed":
      return PROFILE_SAVE_FAILED_TESTID;
    case "session-expired":
      return PROFILE_SESSION_EXPIRED_TESTID;
    case "uncertain":
      return PROFILE_UNCERTAIN_TESTID;
    case "cancelled":
      return PROFILE_NAME_TESTID;
  }
}

/**
 * Trap verdict: true when a VALID save should be silently swallowed. Missing
 * `formOpenedAt` is no signal (API clients), a future/garbled one counts as
 * bot-fast. Called only after validation passed — errors always surface first.
 */
export function profileTrapTripped(input: Record<string, unknown>, nowMs: number): boolean {
  const honey = input[PROFILE_HONEY_FIELD];
  if (typeof honey === "string" ? honey !== "" : honey !== undefined && honey !== null) return true;
  const opened = input[PROFILE_OPENED_AT_FIELD];
  if (opened === undefined || opened === null || opened === "") return false;
  const n = Number(opened);
  return !Number.isFinite(n) || nowMs - n < PROFILE_MIN_FILL_MS;
}

/** Discord CDN avatar with srcset, or null so SSR renders the initial fallback. */
export function profileAvatarSrcset(
  id: string,
  avatar: string | null,
): { src: string; srcset: string } | null {
  if (!avatar || !/^[a-z0-9_]{1,64}$/i.test(avatar)) return null;
  const base = `https://cdn.discordapp.com/avatars/${id}/${avatar}.png`;
  return {
    src: `${base}?size=128`,
    srcset: `${base}?size=64 1x, ${base}?size=128 2x, ${base}?size=256 3x`,
  };
}

export function profileJoinedMonth(joinedAt: Date | null): string | null {
  return joinedAt
    ? joinedAt.toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" })
    : null;
}
