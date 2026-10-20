/**
 * events-calendar island contract: mount attributes, testids, search, month
 * grid and shareable-URL helpers. Part of the island contract family;
 * re-exported from `./contracts` so existing import paths keep working.
 */

export const eventPageUrl = (eventKey: string): string => `/e/${encodeURIComponent(eventKey)}`;
export {
  calendarZone,
  cardDayLabel,
  cardTimeLabel,
  isValidZone,
  currentCalendarMonth,
  wallDateIso,
  wallDayStart,
  wallMonth,
  wallTimeHm,
} from "../events/date-format";
import { cardDayLabel, wallTimeHm } from "../events/date-format";
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

/** The two views share one query shape but different bounds: the list is paged,
 * the month grid is month-scoped — never two components, never unbounded. */
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
export const EVENTS_SEARCH_TOO_LONG_COPY = `Search query must be ${EVENTS_SEARCH_MAX_LENGTH} characters or fewer.`;
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

/* Upcoming list paging: the list view renders one page of full cards, so the
 * read, the aggregate and the HTML stay bounded no matter how many future
 * events exist. Same size as the past archive's pages. */
export const EVENTS_UPCOMING_PAGE_SIZE = 20;
/* Month-grid guard: the grid reads one wall month, which bounds it in
 * practice; this caps a pathological month (hundreds of events in 31 days)
 * at the soonest rows so the render cannot blow up. */
export const EVENTS_MONTH_GRID_LIMIT = 200;
export const EVENTS_PAGER_TESTID = "events-pager";
export const EVENTS_PAGER_PREV_TESTID = "events-pager-prev";
export const EVENTS_PAGER_NEXT_TESTID = "events-pager-next";
export const EVENTS_PAGER_STATUS_TESTID = "events-pager-status";
export const EVENTS_PAGER_LABEL = "Upcoming event pages";
export const EVENTS_PAGER_PREV_COPY = "Previous page";
export const EVENTS_PAGER_NEXT_COPY = "Next page";
export const EVENTS_OUT_OF_RANGE_TESTID = "events-out-of-range";
export function upcomingEventsOutOfRangeCopy(page: number, totalPages: number): string {
  return `Page ${page} is outside the schedule. There ${totalPages === 1 ? "is" : "are"} ${totalPages} ${totalPages === 1 ? "page" : "pages"}.`;
}
export const upcomingEventsPageStatusCopy = (page: number, totalPages: number): string =>
  `Page ${page} of ${totalPages}.`;

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
/** Owned overall read deadline for one island fragment fetch: headers plus
 * response-body completion, at most 10 seconds. On expiry the binder aborts
 * the owned fetch, restores the last good zones and releases loading. */
export const EVENTS_CALENDAR_READ_DEADLINE_MS = 10_000;

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

/* Month jump: a server-derived This month anchor plus a native GET form, so a
 * chosen month is one step away with or without JavaScript. The form carries
 * only the island's month vocabulary (month/view/past) — never the search
 * query — and its bounds mirror the addCalendarMonth saturation below. */
export const CALENDAR_THIS_MONTH_TESTID = "calendar-this-month";
export const CALENDAR_THIS_MONTH_COPY = "This month";
export const CALENDAR_MONTH_JUMP_TESTID = "calendar-month-jump";
export const CALENDAR_MONTH_JUMP_SUBMIT_TESTID = "calendar-month-jump-submit";
export const CALENDAR_MONTH_JUMP_INPUT_ID = "calendar-month-jump-input";
export const CALENDAR_MONTH_JUMP_LABEL = "Jump to month";
export const CALENDAR_MONTH_JUMP_SUBMIT_COPY = "Go";
export const CALENDAR_MONTH_MIN = "0001-01";
export const CALENDAR_MONTH_MAX = "9999-12";

/* Month-local empty guidance: a successfully read selected month with no
 * in-month events keeps its grid and names the month, with a recovery link
 * back to the upcoming list. Spillover-day rows never count as in-month, and
 * the block never claims the whole schedule is empty. */
export const CALENDAR_MONTH_EMPTY_TESTID = "calendar-month-empty";
export const CALENDAR_MONTH_EMPTY_RECOVERY_COPY = "Upcoming events";

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

/** Month-local empty guidance names the selected month, never the schedule. */
export const calendarMonthEmptyCopy = (month: string): string =>
  `No events in ${calendarMonthLabel(month)}.`;

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

/** The wall-day range the month grid covers: whole Monday-first weeks, so the
 * leading/trailing neighbor days plot the adjacent months' events too. Null
 * for unsupported months. */
export function calendarGridRange(month: string): { first: string; last: string } | null {
  const parsed = parseCalendarMonth(month);
  if (!parsed) return null;
  // Day 15 exists in every supported month; only the geometry is read here.
  const days = monthGrid(parsed, `${parsed}-15`, new Map()).flat();
  return { first: days[0]!.iso, last: days.at(-1)!.iso };
}

/** Grid cell link text: host-zone "HH:mm" + title capped at GRID_TITLE_MAX chars. */
export function gridTitle(title: string): string {
  const chars = [...title];
  return chars.length > GRID_TITLE_MAX ? `${chars.slice(0, GRID_TITLE_MAX).join("")}…` : title;
}

/** Month-grid link name starts with the visible "HH:mm title" (WCAG 2.5.3), then the day. */
export function gridAccessibleName(title: string, startsAt: Date, zone: string): string {
  return `${wallTimeHm(startsAt, zone)} ${title}, ${cardDayLabel(startsAt, zone)}`;
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
 * `month` is always resolved (the grid is one render away via the toggle).
 * `page` is the upcoming-list page; the month grid is month-scoped, so it
 * always reads as page 1. */
export interface CalendarState {
  view: CalendarView;
  month: string;
  q: string;
  past: boolean;
  page: number;
}

/** Whether this state is a search (blank input is no search). */
export const calendarSearching = (s: { q: string }): boolean => s.q.trim() !== "";

/** Whether the past drawer renders (opened, or forced open by a search). */
export const calendarShowingPast = (s: CalendarState): boolean => s.past || calendarSearching(s);

/**
 * The island's shareable URL. `view`/`month` are emitted only for the calendar
 * view (the list is the default and a search forces it); `q` only when
 * non-blank; `past` only when open; `page` only past the first list page (the
 * month grid is month-scoped, so it never carries a page).
 */
export function calendarUrl(s: CalendarState): string {
  const params = new URLSearchParams();
  if (s.q.trim() !== "") params.set("q", s.q);
  if (s.past) params.set("past", "1");
  if (s.view === "calendar") {
    params.set("view", "calendar");
    params.set("month", s.month);
  } else if (Number.isSafeInteger(s.page) && s.page > 1) {
    params.set("page", String(s.page));
  }
  const qs = params.toString();
  return qs === "" ? "/events" : `/events?${qs}`;
}

/** Grid day-jump into the list: names the card so the route renders the list
 * page holding it, plus the card anchor. `past` rides along; a search never
 * co-occurs with the grid (it forces the list view). */
export function calendarJumpUrl(past: boolean, key: string): string {
  const params = new URLSearchParams();
  params.set("event", key);
  if (past) params.set("past", "1");
  return `/events?${params.toString()}#event-${key}`;
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
