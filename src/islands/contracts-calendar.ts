/**
 * events-calendar island contract: mount attributes, testids, search, month
 * grid and shareable-URL helpers. Part of the island contract family;
 * re-exported from `./contracts` so existing import paths keep working.
 */

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
 * upcoming list in start order — expiring cache bytes, never canonical events, published, or
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
