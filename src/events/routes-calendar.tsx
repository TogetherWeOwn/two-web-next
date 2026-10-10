// Calendar/collection event routes: GET /events and GET /events/past.
// Split out of src/events/routes.tsx; behavior unchanged.
import { dbFor } from "../admin/db";
import { inviteDestination } from "../invite";
import {
  calendarEmptyState,
  calendarZone,
  currentCalendarMonth,
  dedupeTransients,
  eventSearchLogEntry,
  mergeCalendarRows,
  parseCalendarMonth,
  parseCalendarView,
  wallMonth,
} from "../islands/contracts";
import { takeJoinResult } from "../return-journey";
import { MAX_QUERY_LENGTH, matchQuery, recordSearch } from "./search-log";
import { discordEventsSource } from "./discord-transients";
import {
  listCalendarPast,
  listPast,
  listUpcoming,
  normalizePastPage,
  persistedDiscordIds,
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

    const opts = { includeDrafts: session?.moderator ?? false, search: match };
    const localUpcoming = await listUpcoming(db, now, opts);
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
    const upcoming = mergeCalendarRows(localUpcoming, transients);

    const zone = calendarZone([
      ...localUpcoming.map((e) => e.timezone),
      ...localPast.map((e) => e.timezone),
    ]);
    // No month given: open on the first upcoming event's host-zone month, else
    // this month. An unparseable month is a page, never a 500.
    const month =
      parseCalendarMonth(c.req.query("month")) ??
      parseCalendarMonth(
        upcoming[0]
          ? wallMonth(
              upcoming[0].startsAt,
              "discordId" in upcoming[0] ? zone : upcoming[0].timezone,
            )
          : null,
      ) ??
      currentCalendarMonth(now);

    const state = { view, month, q, past };
    const emptyState = calendarEmptyState({
      searching,
      upcomingEmpty: upcoming.length === 0,
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
    const island = c.req.header("x-two-island") === "events-calendar";
    const joinResult = island ? null : await takeJoinResult(c);
    // Search analytics must run per request, not only on shared-cache misses.
    c.header(
      "cache-control",
      session || searching || joinResult ? "private, no-store" : "public, max-age=60",
    );
    if (searching) c.header("x-robots-tag", "noindex, follow");
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
    return c.html(
      <EventsCalendarPage
        state={state}
        upcoming={upcoming}
        past={localPast}
        zone={zone}
        now={now}
        emptyState={emptyState}
        discordFailed={discordFailed}
        member={session?.member ?? false}
        inviteUrl={inviteDestination(c.env.DISCORD_INVITE_URL)}
        appUrl={c.env.APP_URL}
        loginReturnTo={loginReturnTo}
        joinResult={joinResult}
      />,
    );
  });

  app.get("/events/past", async (c) => {
    const limited = await publicReadGuard(c);
    if (limited) return limited;
    const db = await dbFor(c);
    if (!db) return eventsUnavailable(c);
    const page = normalizePastPage(Number.parseInt(c.req.query("page") ?? "1", 10));
    const { rows, hasMore, totalPages } = await listPast(db, page);
    c.header("cache-control", "public, max-age=300");
    return c.html(
      <PastEventsPage
        rows={rows}
        page={page}
        hasMore={hasMore}
        totalPages={totalPages}
        appUrl={c.env.APP_URL}
      />,
    );
  });
}
