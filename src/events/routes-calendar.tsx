// Calendar/collection event routes: GET /events and GET /events/past.
// Split out of src/events/routes.tsx; behavior unchanged.
import { dbFor } from "../admin/db";
import { inviteDestination } from "../invite";
import {
  calendarEmptyState,
  calendarGridRange,
  calendarZone,
  currentCalendarMonth,
  dedupeTransients,
  eventSearchLogEntry,
  EVENTS_UPCOMING_PAGE_SIZE,
  mergeCalendarRows,
  parseCalendarMonth,
  parseCalendarView,
  wallDateIso,
  wallDayStart,
  wallMonth,
} from "../islands/contracts";
import { takeJoinResult, readJoinResult } from "../return-journey";
import { MAX_QUERY_LENGTH, matchQuery, recordSearch } from "./search-log";
import {
  ANON_EVENTS_TTL_MS,
  ANON_PAST_TTL_MS,
  anonCacheGeneration,
  anonCacheSource,
  anonEventsKey,
  anonPastKey,
  isAnonCacheEligible,
  readAnonCache,
  writeAnonCache,
} from "./anon-cache";
import { discordEventsSource } from "./discord-transients";
import {
  listCalendarPast,
  listPast,
  listUpcoming,
  listUpcomingForMonth,
  normalizePastPage,
  normalizeUpcomingPage,
  persistedDiscordIds,
  rankUpcoming,
} from "./reads";
import { EventsCalendarPage, PastEventsPage } from "./pages";
import { eventsUnavailable, publicReadGuard, type App, type SessionReader } from "./routes-shared";

export function registerCalendarRoutes(
  app: App,
  readSession: SessionReader,
  readFragmentSession: SessionReader,
): void {
  app.get("/events", async (c) => {
    const q = c.req.query("q") ?? "";
    if ([...q].length > MAX_QUERY_LENGTH) {
      c.header("cache-control", "no-store, private");
      return c.text(`Search query must be ${MAX_QUERY_LENGTH} characters or fewer.`, 422);
    }
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const session = await (c.req.header("x-two-island") === "events-calendar"
      ? readFragmentSession(c)
      : readSession(c));
    const now = new Date();

    // Resolve the URL state. A search forces the list view (a month grid that
    // may not contain the matches reads as "no results"); an unknown view
    // keeps the current one, which for a fresh URL means the default list.
    const match = matchQuery(q);
    const searching = match !== null;
    const view = searching ? "list" : (parseCalendarView(c.req.query("view")) ?? "list");
    const past = c.req.query("past") === "1";
    // The upcoming list is paged: one page of full cards per render. The
    // month grid is month-scoped and always reads as page one.
    const page = normalizeUpcomingPage(Number.parseInt(c.req.query("page") ?? "1", 10));

    const opts = { includeDrafts: session?.moderator ?? false, search: match };
    // Anonymous shared entry (N6 retire): only a cookieless, session-free,
    // search-free render with no pending join flash may serve shared bytes.
    // The peek reads without consuming; the miss path below still consumes
    // exactly once, and island swaps keep their pending value like today.
    const island = c.req.header("x-two-island") === "events-calendar";
    const flashed = island ? null : await readJoinResult(c);
    const anonEligible = isAnonCacheEligible({
      method: c.req.method,
      hasCookie: c.req.header("cookie") !== undefined,
      hasSession: session !== null,
      searching,
      flashed: flashed !== null,
    });
    const anonSource = anonEligible ? anonCacheSource(c.env) : null;
    let anonKey: string | null = null;
    if (anonSource) {
      let pathAndSearch = "";
      try {
        const u = new URL(c.req.url);
        pathAndSearch = u.pathname + u.search;
      } catch {
        pathAndSearch = "/events";
      }
      anonKey = anonEventsKey(c.req.method, pathAndSearch, island);
      const hit = readAnonCache(anonKey, anonSource);
      if (hit) {
        // Remaining TTL, not the stored full window: a browser must never
        // extend the entry past its origin expiry.
        c.header(
          "cache-control",
          hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
        );
        if (hit.vary) c.header("vary", hit.vary);
        return c.html(hit.body, hit.status as 200);
      }
    }
    // Retire generation before the first render read: a publish, edit or RSVP
    // that commits (and retires) while this render awaits its reads must stop
    // the stale bytes from settling below.
    const anonGen = anonSource ? anonCacheGeneration() : 0;
    // Grid day-jumps name the card (`?event=`): resolve the list page holding
    // it so jumps land even past page one. Absent, invisible or over-long
    // keys fall back to the requested page.
    const jumpKey = c.req.query("event") ?? "";
    let listPage = view === "calendar" ? 1 : page;
    if (view === "list" && jumpKey !== "" && jumpKey.length <= 64) {
      const rank = await rankUpcoming(db, jumpKey, now, opts);
      if (rank !== null) listPage = Math.floor(rank / EVENTS_UPCOMING_PAGE_SIZE) + 1;
    }
    // One bounded page of upcoming rows plus the capped past drawer: the read,
    // the RSVP aggregate and the rendered HTML stay flat no matter how many
    // future events exist. The calendar view always works from page one — it
    // only needs the total (for the empty states) and the soonest row (for
    // the default month); the grid itself is month-scoped below.
    const {
      rows: pageRows,
      totalPages,
      total: totalUpcoming,
    } = await listUpcoming(db, now, opts, listPage);
    const localPast = await listCalendarPast(db, now, opts);

    // One resolve per request: the rows and the failure flag MUST come from the
    // same source instance (legacy render() comment) or every error reads as
    // "never scheduled". Transients are re-checked against the local clock —
    // a just-ended event cannot linger if the collector goes dark.
    const discord = discordEventsSource(c.env);
    const discordRows = await discord.upcoming(now);
    // Probe only candidate identities, without search/draft/time/pagination
    // predicates. A filtered canonical row must never become a stale transient.
    const persistedIds = await persistedDiscordIds(
      db,
      discordRows.map((t) => t.discordId),
    );
    const term = (match ?? "").toLowerCase();
    const transients = dedupeTransients(discordRows, persistedIds).filter(
      (t) =>
        (t.endsAt === null || t.endsAt >= now) &&
        (term === "" ||
          t.title.toLowerCase().includes(term) ||
          (t.description ?? "").toLowerCase().includes(term)),
    );
    const discordFailed = discord.lastReadFailed();

    // Discord extras are unpaged, so they render on the first list page only
    // — later pages must not repeat them — plus on an empty collection, where
    // any page is effectively the first and they are the whole schedule. The
    // calendar view keeps them in the probe so the default month still opens
    // on a Discord-only schedule, exactly like the old unpaged merge.
    const probe = mergeCalendarRows(
      pageRows,
      view !== "list" || listPage === 1 || totalUpcoming === 0 ? transients : [],
    );
    const probeZone = calendarZone([
      ...pageRows.map((e) => e.timezone),
      ...localPast.map((e) => e.timezone),
    ]);
    // No month given: open on the first upcoming event's host-zone month, else
    // this month. An unparseable month is a page, never a 500. In the list
    // view the toggle target follows the rendered page, not the whole
    // collection — page one keeps the old soonest-first behavior exactly.
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
    const month = parseCalendarMonth(c.req.query("month")) ?? fallbackMonth;
    if (view === "calendar") {
      const monthRows = await listUpcomingForMonth(db, month, now, opts);
      zone = calendarZone([
        ...monthRows.map((e) => e.timezone),
        ...localPast.map((e) => e.timezone),
      ]);
      // The grid renders whole weeks, so it keeps exactly the Discord extras
      // landing on a covered wall day in the same zone — including the
      // adjacent months' neighbor cells.
      const grid = calendarGridRange(month) ?? { first: month, last: month };
      const gridFirst = wallDayStart(grid.first);
      const gridLast = wallDayStart(grid.last);
      upcoming = mergeCalendarRows(
        monthRows,
        transients.filter((t) => {
          const day = wallDayStart(wallDateIso(t.startsAt, zone));
          return day >= gridFirst && day <= gridLast;
        }),
      );
    }

    const state = { view, month, q, past, page: listPage };
    const emptyState = calendarEmptyState({
      searching,
      upcomingEmpty: totalUpcoming === 0 && transients.length === 0,
      pastEmpty: localPast.length === 0,
      readFailed: discordFailed,
    });

    // One structured line per rendered search: normalized query + visible
    // count, no identity (legacy EventSearchLogger, TOG-8400). Fail-open.
    if (searching) {
      const visibleCount = upcoming.length + localPast.length;
      await recordSearch(db, q, visibleCount);
      const entry = eventSearchLogEntry(match ?? "", visibleCount);
      if (entry) {
        try {
          console.info("event_search", JSON.stringify(entry));
        } catch {
          /* a down logger is an unrecorded search, never a broken page */
        }
      }
    }

    // One-shot join confirmation (legacy join_result flash): /events is a
    // join-CTA landing (`/join?next=/events`), so it consumes and renders the
    // banner exactly once like /, /join, /profile and /e/:key (TOG-10356
    // review). Island fragment swaps must not consume it: the banner renders
    // outside the swapped zones, so a fragment would eat the flash without
    // ever displaying it — the pending value survives for the next full load.
    // `island` is hoisted above the anonymous-cache lookup; `flashed` peeked
    // there, so this consume is a no-op on the cacheable path.
    const joinResult = island ? null : await takeJoinResult(c);
    // Search analytics must run per request, not only on shared-cache misses.
    c.header(
      "cache-control",
      session || searching || joinResult ? "private, no-store" : "public, max-age=60",
    );
    // Paged turns and card jumps duplicate first-page content for crawlers,
    // like the past archive's always-noindex pages.
    if (searching || state.page > 1 || jumpKey !== "") c.header("x-robots-tag", "noindex, follow");
    c.header("vary", "Cookie, X-Two-Island");
    // Guest sign-in links carry this page as ?next= so the OAuth round trip
    // lands back here (TOG-10356). Rooted pathname + search only — the
    // journey guard re-validates before any redirect, so a hostile query can
    // at worst fall back to the default landing, never off-app.
    let loginReturnTo: string | null = null;
    try {
      const u = new URL(c.req.url);
      loginReturnTo = u.pathname + u.search;
    } catch {
      loginReturnTo = "/events";
    }
    const response = await c.html(
      <EventsCalendarPage
        state={state}
        upcoming={upcoming}
        past={localPast}
        zone={zone}
        now={now}
        totalPages={totalPages}
        emptyState={emptyState}
        discordFailed={discordFailed}
        member={session?.member ?? false}
        inviteUrl={inviteDestination(c.env.DISCORD_INVITE_URL)}
        appUrl={c.env.APP_URL}
        loginReturnTo={loginReturnTo}
        joinResult={joinResult}
      />,
    );
    // Settle the shared entry only from an anonymous 200: the header guard
    // above already forced private on session/search/flash, so a `public`
    // prefix re-checks that no viewer state slipped into shared bytes. The
    // generation check drops a render overtaken by a retire mid-flight; the
    // compare-and-write is synchronous, so it is atomic within the isolate.
    if (anonSource && anonKey && response.status === 200 && anonCacheGeneration() === anonGen) {
      const cacheControl = response.headers.get("cache-control");
      if (cacheControl?.startsWith("public")) {
        writeAnonCache(
          anonKey,
          anonSource,
          {
            status: 200,
            cacheControl,
            vary: response.headers.get("vary"),
            body: await response.clone().text(),
          },
          ANON_EVENTS_TTL_MS,
        );
      }
    }
    return response;
  });

  app.get("/events/past", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const page = normalizePastPage(Number.parseInt(c.req.query("page") ?? "1", 10));
    // Anonymous shared entry (N6 retire): the archive renders no session, no
    // flash and no RSVP controls, so every cookieless render is shareable.
    // Only data pages settle — empty and out-of-range renders stay uncached
    // so a fresh archive never pins a stale "never ran" state, and keys stay
    // bounded.
    const pastEligible = isAnonCacheEligible({
      method: c.req.method,
      hasCookie: c.req.header("cookie") !== undefined,
      hasSession: false,
      searching: false,
      flashed: false,
    });
    const pastSource = pastEligible ? anonCacheSource(c.env) : null;
    const pastKey = pastEligible ? anonPastKey(c.req.method, page) : null;
    if (pastSource && pastKey) {
      const hit = readAnonCache(pastKey, pastSource);
      if (hit) {
        c.header(
          "cache-control",
          hit.cacheControl.replace(/max-age=\d+/, `max-age=${hit.maxAgeSeconds}`),
        );
        if (hit.vary) c.header("vary", hit.vary);
        return c.html(hit.body, hit.status as 200);
      }
    }
    // Same retire-generation guard as `/events`: an edit that commits while
    // this archive render awaits its read must stop stale bytes settling.
    const pastGen = pastSource ? anonCacheGeneration() : 0;
    const { rows, hasMore, totalPages } = await listPast(db, page);
    c.header("cache-control", "public, max-age=300");
    const pastResponse = await c.html(
      <PastEventsPage
        rows={rows}
        page={page}
        hasMore={hasMore}
        totalPages={totalPages}
        appUrl={c.env.APP_URL}
      />,
    );
    if (
      pastSource &&
      pastKey &&
      pastResponse.status === 200 &&
      rows.length > 0 &&
      anonCacheGeneration() === pastGen
    ) {
      writeAnonCache(
        pastKey,
        pastSource,
        {
          status: 200,
          cacheControl: pastResponse.headers.get("cache-control") ?? "public, max-age=300",
          vary: pastResponse.headers.get("vary"),
          body: await pastResponse.clone().text(),
        },
        ANON_PAST_TTL_MS,
      );
    }
    return pastResponse;
  });
}
