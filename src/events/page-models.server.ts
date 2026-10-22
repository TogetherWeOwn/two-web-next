// Framework-neutral, server-only page models for public event pages.
import type { Db } from "../db/index";
import {
  calendarEmptyState,
  calendarGridRange,
  dedupeTransients,
  eventSearchLogEntry,
  EVENTS_UPCOMING_PAGE_SIZE,
  mergeCalendarRows,
  parseCalendarMonth,
  resolveGameFilter,
  type CalendarState,
  type DiscordTransient,
} from "../islands/contracts";
import {
  calendarZone,
  currentCalendarMonth,
  wallDateIso,
  wallDayStart,
  wallMonth,
} from "./date-format";
import type { DiscordEventsSource } from "./discord-transients-types";
import {
  listCalendarPast,
  listPublishedGames,
  listUpcoming,
  listUpcomingForMonth,
  normalizeUpcomingPage,
  persistedDiscordIds,
  rankUpcoming,
  type PublicEvent,
} from "./reads";
import { MAX_QUERY_LENGTH, matchQuery, recordSearch } from "./search-log";

export interface CalendarPageInput {
  q: string;
  /** Raw `game` facet input; the effective game resolves against the distinct
   * published list at read time (blank/unknown degrades to unfiltered). */
  game: string;
  searching: boolean;
  view: "list" | "calendar";
  past: boolean;
  page: number;
  jumpKey: string;
  /** NUL-stripped `?event=` was present, even when overlong and unusable for lookup. */
  jumpRequested: boolean;
  month: string | null;
  queryTooLong: boolean;
}

/** Normalize bounded URL state before a framework-specific route loads data. */
export function resolveCalendarInput(input: {
  q?: string | null;
  game?: string | null;
  view?: string | null;
  past?: string | null;
  page?: string | null;
  event?: string | null;
  month?: string | null;
}): CalendarPageInput {
  const q = input.q ?? "";
  const queryTooLong = [...q].length > MAX_QUERY_LENGTH;
  const searching = !queryTooLong && matchQuery(q) !== null;
  const view = searching ? "list" : input.view === "calendar" ? "calendar" : "list";
  const parsedPage = Number.parseInt(input.page ?? "1", 10);
  const rawJumpKey = (input.event ?? "").replaceAll(String.fromCharCode(0), "");

  return {
    q,
    game: input.game ?? "",
    searching,
    view,
    past: input.past === "1",
    page: normalizeUpcomingPage(parsedPage),
    jumpKey: rawJumpKey !== "" && rawJumpKey.length <= 64 ? rawJumpKey : "",
    jumpRequested: rawJumpKey !== "",
    month: input.month ?? null,
    queryTooLong,
  };
}

export interface CalendarPageModel {
  state: CalendarState;
  upcoming: (PublicEvent | DiscordTransient)[];
  past: PublicEvent[];
  pastMayBeTruncated?: boolean;
  zone: string;
  totalPages: number;
  emptyState: ReturnType<typeof calendarEmptyState>;
  robots?: string;
  discordFailed: boolean;
  /** Distinct published games backing the facet select (one bounded read). */
  games: string[];
  /** Effective facet: the canonical stored game, or null when unfiltered. */
  gameFilter: string | null;
}

/**
 * Load the public calendar projection from the shared Drizzle/domain reads.
 * The framework adapter owns admission, DB acquisition, session and response
 * caching; this model owns only normalized public page data and its fallbacks.
 */
export async function loadCalendarPageModel(args: {
  db: Db;
  input: CalendarPageInput;
  includeDrafts: boolean;
  discord: DiscordEventsSource;
  now?: Date;
  /** Correlation id for the `event_search` line and the demand-record warn; omitted when absent or invalid. */
  requestId?: string | null;
}): Promise<CalendarPageModel> {
  const { db, input, includeDrafts, discord, requestId } = args;
  const now = args.now ?? new Date();
  const { q, game: rawGame, searching, view, past, page, jumpKey, jumpRequested } = input;
  const match = matchQuery(q);

  // The distinct-games list scopes every list read below, so it resolves
  // before them — overlapped with the Discord read (snapshot store, at most
  // one live Discord GET), which shares nothing with it. The list reads then
  // start together like the homepage (perf(home) #856).
  const [games, discordRows] = await Promise.all([listPublishedGames(db), discord.upcoming(now)]);
  const gameFilter = resolveGameFilter(games, rawGame);
  const opts = { includeDrafts, search: match, game: gameFilter };

  // Grid day-jumps resolve the list page holding the card, even past page one.
  let listPage = view === "calendar" ? 1 : page;
  if (view === "list" && jumpKey !== "") {
    const rank = await rankUpcoming(db, jumpKey, now, opts);
    if (rank !== null) listPage = Math.floor(rank / EVENTS_UPCOMING_PAGE_SIZE) + 1;
  }

  // Independent reads start together like the homepage (perf(home) #856):
  // the upcoming page and the past drawer (web DB) share nothing, so
  // sequential awaits would sum every round trip into /events server time.
  // Keep the rows and failure flag on the same resolved source instance.
  const [upcomingPage, localPast] = await Promise.all([
    listUpcoming(db, now, opts, listPage),
    listCalendarPast(db, now, opts),
  ]);
  const { rows: pageRows, totalPages, total: totalUpcoming } = upcomingPage;
  const persistedIds = await persistedDiscordIds(
    db,
    discordRows.map((row) => row.discordId),
  );
  const term = (match ?? "").toLowerCase();
  // Discord transients carry no game, so they cannot match the facet — while
  // one is active they drop out instead of breaking its promise.
  const transients = (
    gameFilter === null ? dedupeTransients(discordRows, persistedIds) : []
  ).filter(
    (row) =>
      (row.endsAt === null || row.endsAt >= now) &&
      (term === "" ||
        row.title.toLowerCase().includes(term) ||
        (row.description ?? "").toLowerCase().includes(term)),
  );
  const discordFailed = discord.lastReadFailed();

  const probe = mergeCalendarRows(
    pageRows,
    view !== "list" || listPage === 1 || totalUpcoming === 0 ? transients : [],
  );
  const probeZone = calendarZone([
    ...pageRows.map((event) => event.timezone),
    ...localPast.map((event) => event.timezone),
  ]);
  const firstProbe = probe[0];
  const fallbackMonth =
    parseCalendarMonth(
      firstProbe
        ? wallMonth(
            firstProbe.startsAt,
            "discordId" in firstProbe ? probeZone : firstProbe.timezone,
          )
        : null,
    ) ?? currentCalendarMonth(now);

  let upcoming = probe;
  let zone = probeZone;
  const month = parseCalendarMonth(input.month) ?? fallbackMonth;
  if (view === "calendar") {
    const monthRows = await listUpcomingForMonth(db, month, now, opts);
    zone = calendarZone([
      ...monthRows.map((event) => event.timezone),
      ...localPast.map((event) => event.timezone),
    ]);
    const grid = calendarGridRange(month) ?? { first: month, last: month };
    const gridFirst = wallDayStart(grid.first);
    const gridLast = wallDayStart(grid.last);
    upcoming = mergeCalendarRows(
      monthRows,
      transients.filter((row) => {
        const day = wallDayStart(wallDateIso(row.startsAt, zone));
        return day >= gridFirst && day <= gridLast;
      }),
    );
  }

  const state = { view, month, q, game: rawGame, past, page: listPage };
  // An overlong `?event=` never resolves, but it is still a jump URL — not an
  // indexable copy of page one — so the robots decision sees the request flag.
  const robots = searching || state.page > 1 || jumpRequested ? "noindex, follow" : undefined;
  const emptyState = calendarEmptyState({
    searching,
    upcomingEmpty: totalUpcoming === 0 && transients.length === 0,
    pastEmpty: localPast.length === 0,
    readFailed: discordFailed,
  });

  // An incomplete read must never manufacture demand evidence: while the
  // Discord source reports failure, the count is partial and a zero is not a
  // definitive no-match, so neither the search-demand record nor the
  // event_search result log is written. Recovery records normally.
  if (searching && listPage === 1 && !discordFailed) {
    const totalMatches = totalUpcoming + transients.length + localPast.length;
    await recordSearch(db, q, totalMatches, undefined, requestId);
    const entry = eventSearchLogEntry(match ?? "", totalMatches, requestId);
    if (entry) {
      try {
        console.info("event_search", entry);
      } catch {
        /* a down logger is an unrecorded search, never a broken page */
      }
    }
  }

  return {
    state,
    upcoming,
    past: localPast,
    pastMayBeTruncated: localPast.mayBeTruncated,
    zone,
    totalPages,
    emptyState,
    robots,
    discordFailed,
    games,
    gameFilter,
  };
}
