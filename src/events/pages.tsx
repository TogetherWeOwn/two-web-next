import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import { canonicalUrl } from "../seo";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_STATUS_TESTID,
  CALENDAR_MONTH_TESTID,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  DISCORD_JOIN_TESTID,
  EVENTS_CAL_FEEDBACK,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_ISLAND,
  EVENTS_CALENDAR_SCROLL_LABEL,
  EVENTS_CALENDAR_SCROLL_TESTID,
  EVENTS_CALENDAR_TESTID,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_CONTENT_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_EMPTY_ERROR_TESTID,
  EVENTS_EMPTY_GAP_ITEM_TESTID,
  EVENTS_EMPTY_GAP_LIST_TESTID,
  EVENTS_EMPTY_GAP_TESTID,
  EVENTS_EMPTY_NEVER_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  EVENTS_GAP_LIST_LIMIT,
  EVENTS_LIST_HEADING_SR,
  EVENTS_LIST_TESTID,
  EVENTS_LOADING_COPY,
  EVENTS_LOADING_ROWS,
  EVENTS_LOADING_TESTID,
  EVENTS_PAST_ARCHIVE_LINK_TESTID,
  EVENTS_PAST_LIST_HEADING,
  EVENTS_PAST_LIST_TESTID,
  EVENTS_PAST_STATUS_COPY,
  EVENTS_PAST_STATUS_TESTID,
  EVENTS_PAST_TOGGLE_COPY,
  EVENTS_PAST_TOGGLE_TESTID,
  EVENTS_RETRY_TESTID,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  EVENTS_SEARCH_CLEAR_TESTID,
  EVENTS_SEARCH_LABEL,
  EVENTS_SEARCH_MAX_LENGTH,
  EVENTS_SEARCH_PLACEHOLDER,
  EVENTS_SEARCH_STATUS_TESTID,
  EVENTS_SEARCH_TESTID,
  EVENTS_SUBSCRIBE_TESTID,
  EVENTS_SUBSCRIBE_URL,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_GROUP_LABEL,
  EVENTS_VIEW_LIST_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_TESTID,
  WEEKDAY_HEADINGS,
  addCalendarMonth,
  calendarMonthLabel,
  calendarSearching,
  calendarShowingPast,
  calendarUrl,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
  eventsViewStatusCopy,
  goingCountText,
  gridTitle,
  monthGrid,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
  renderGoingCount,
  transientEventKey,
  wallDateIso,
  wallTimeHm,
  type CalendarDay,
  type CalendarEmptyState,
  type CalendarState,
} from "../islands/contracts";
import { cardTimeLabel, type CalendarView, type DiscordTransient } from "../islands/contracts";
import { loginUrl } from "../islands/contracts";
import type { Session } from "../env";
import { JoinResultBanner } from "../pages";
import type { JoinResult } from "../return-journey";
import { googleCalendarUrl } from "./feeds";
import type { EventAttendee, EventLink, EventNeighbors, PublicEvent } from "./reads";

const fmt = (d: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(d);
  } catch {
    return d.toISOString();
  }
};

const fmtWithOffset = (d: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long", day: "numeric", month: "long", year: "numeric",
      hour: "2-digit", minute: "2-digit", timeZone: tz, timeZoneName: "longOffset",
    }).format(d);
  } catch {
    return d.toISOString();
  }
};

const Shell: FC<PropsWithChildren<{ title: string; canonical?: string; robots?: string; description?: string | null; shareTitle?: string }>> = ({
  title,
  canonical,
  robots,
  description,
  shareTitle,
  children,
}) => (
  <Layout title={`${title} — Together We Own`} canonical={canonical} shareTitle={shareTitle ?? title} shareDescription={description} robots={robots}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav aria-label="Primary">
        <a href="/events">Events</a>
      </nav>
    </header>
    <main id="main" tabindex={-1}>{children}</main>
  </Layout>
);

const ScheduleShell: FC<PropsWithChildren<{
  title: string; canonical: string; description?: string; robots?: string; member?: boolean; loginReturnTo?: string | null;
}>> = ({ title, canonical, description, robots, member, loginReturnTo, children }) => (
  <Layout title={`${title} — Together We Own`} canonical={canonical} shareDescription={description} robots={robots} theme="home">
    <SiteHeader active="events" loginReturnTo={loginReturnTo}>
      {member ? <a class="btn" href="/discord">Open Discord</a> : undefined}
    </SiteHeader>
    <main class="events-page" id="main" tabindex={-1}>{children}</main>
    <SiteFooter />
  </Layout>
);

const ScheduleDate: FC<{ date: Date; zone: string }> = ({ date, zone }) => {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: zone }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" }).formatToParts(date);
  }
  return (
    <span class="schedule-date" aria-hidden="true">
      <span>{parts.find((p) => p.type === "month")?.value}</span>
      <strong>{parts.find((p) => p.type === "day")?.value}</strong>
    </span>
  );
};

const Card: FC<{ e: PublicEvent }> = ({ e }) => (
  <li class="schedule-row" data-testid="event-card" data-event-key={e.eventKey}>
    <ScheduleDate date={e.startsAt} zone={e.timezone} />
    <div class="schedule-info">
      <h2><a href={`/e/${e.eventKey}`}>{e.title}</a></h2>
      <p><time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time></p>
      {e.game ? <p>{e.game}</p> : null}
    </div>
    <span class="schedule-attendance">{goingCountText(e.goingCount, e.capacity)}</span>
  </li>
);

/** Anything the calendar renders: a persisted row or a Discord transient. */
type CalRow = PublicEvent | DiscordTransient;
const isTransient = (e: CalRow): e is DiscordTransient => "discordId" in e;
const rowKey = (e: CalRow): string => (isTransient(e) ? transientEventKey(e.discordId) : e.eventKey);
const rowZone = (e: CalRow, fallback: string): string => (isTransient(e) ? fallback : e.timezone);
const rowTitle = (e: CalRow): string => e.title;
const rowLocation = (e: CalRow): string | null => e.location;

/**
 * One event card (legacy partials/event-card-anon): same markup for every
 * viewer until slice 2 lands the RSVP control — guests get the sign-in link,
 * Discord-native rows get "RSVP in Discord" and no going count (there are no
 * local answers to count). `isPast` suppresses the action area entirely.
 */
const CalCard: FC<{ e: CalRow; zone: string; isPast: boolean; member: boolean; inviteUrl: string; loginReturnTo: string | null }> = ({
  e,
  zone,
  isPast,
  member,
  inviteUrl,
  loginReturnTo,
}) => {
  const tz = rowZone(e, zone);
  const transient = isTransient(e);
  return (
    <li>
      <article class="schedule-row" id={`event-${rowKey(e)}`} data-event-key={rowKey(e)} data-testid={EVENT_CARD_TESTID} tabindex={-1}>
        <ScheduleDate date={e.startsAt} zone={tz} />
        <div class="schedule-info">
          <h3>{transient ? rowTitle(e) : <a href={`/e/${e.eventKey}`}>{rowTitle(e)}</a>}</h3>
          {!transient && e.game ? <p>{e.game}</p> : null}
          {!transient && e.status === "draft" ? <span class="schedule-badge" data-testid={EVENT_DRAFT_TESTID}>Draft</span> : null}
          {!transient && e.status === "cancelled" ? <span class="schedule-badge" data-testid={EVENT_CANCELLED_TESTID}>Cancelled</span> : null}
          <p>
            <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, tz)}</time>
            {e.endsAt ? <>{" · "}<span>{wallTimeHm(e.endsAt, tz)}</span></> : null}
            {" "}<span>{tz}</span>
            {rowLocation(e) ? <>{" · "}<span>{rowLocation(e)}</span></> : null}
          </p>
          {e.description ? <p>{e.description}</p> : null}
        </div>
        <div class="schedule-actions">
          {!transient ? (
            <span class="schedule-attendance" data-testid="event-going-count">{goingCountText(e.goingCount, e.capacity)}</span>
          ) : null}
          {isPast ? null : transient ? (
            <a href={inviteUrl} data-testid={EVENT_DISCORD_RSVP_TESTID}>{EVENTS_EMPTY_COPY.discordRsvp}</a>
          ) : member ? null : (
            <a href={loginUrl(loginReturnTo)} data-testid="signin">{EVENTS_EMPTY_COPY.signIn}</a>
          )}
        </div>
      </article>
    </li>
  );
};

/** The never-scheduled empty state: invite-first, no "0 events" framing. */
const EmptyNever: FC<{ inviteUrl: string }> = ({ inviteUrl }) => (
  <div data-testid={EVENTS_EMPTY_NEVER_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.neverTitle}</h2>
    <p>{EVENTS_EMPTY_COPY.neverBody}</p>
    <p>
      <a href={inviteUrl} data-testid={DISCORD_JOIN_TESTID}>
        {EVENTS_EMPTY_COPY.join}
      </a>
    </p>
  </div>
);

/** Upcoming is empty but the drawer has history: show the last few so the page never reads as dead. */
const EmptyGap: FC<{ past: PublicEvent[]; zone: string }> = ({ past, zone }) => (
  <div data-testid={EVENTS_EMPTY_GAP_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.gapTitle}</h2>
    <h3>{EVENTS_EMPTY_COPY.gapListHeading}</h3>
    <ul data-testid={EVENTS_EMPTY_GAP_LIST_TESTID}>
      {past.slice(0, EVENTS_GAP_LIST_LIMIT).map((e) => (
        <li data-testid={EVENTS_EMPTY_GAP_ITEM_TESTID}>
          <a href={`/e/${e.eventKey}`}>{e.title}</a>{" "}
          <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, rowZone(e, zone))}</time>
        </li>
      ))}
    </ul>
    <p>
      <a href="/events/past">{EVENTS_EMPTY_COPY.pastArchive}</a>
    </p>
  </div>
);

/** A read failed (role=alert): Retry re-issues the same URL; the join link is the human fallback. */
const EmptyError: FC<{ url: string; inviteUrl: string }> = ({ url, inviteUrl }) => (
  <div role="alert" data-testid={EVENTS_EMPTY_ERROR_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.errorTitle}</h2>
    <p>{EVENTS_EMPTY_COPY.errorBody}</p>
    <p>
      <a href={url} data-testid={EVENTS_RETRY_TESTID}>
        {EVENTS_EMPTY_COPY.retry}
      </a>{" "}
      <a href={inviteUrl} data-testid={DISCORD_JOIN_TESTID}>
        {EVENTS_EMPTY_COPY.join}
      </a>
    </p>
  </div>
);

/** Search miss block: named query, what is searched, and the way back out. */
const SearchMiss: FC<{ state: CalendarState }> = ({ state }) => (
  <div data-testid={EVENTS_EMPTY_SEARCH_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.searchMissTitle}</h2>
    <p>{eventsSearchMissCopy(state.q)}</p>
    <p>{EVENTS_EMPTY_COPY.searchMissBody}</p>
    <p>
      <a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_EMPTY_TESTID}>
        {EVENTS_EMPTY_COPY.searchMissClear}
      </a>
    </p>
  </div>
);

/** The month grid: prev/next anchors are real links; cells link into the list. */
const MonthGrid: FC<{ state: CalendarState; weeks: CalendarDay<CalRow>[][]; zone: string }> = ({
  state,
  weeks,
  zone,
}) => (
  <div class="schedule-month">
    <p class="schedule-month-nav">
      <a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, -1) })} aria-label={CALENDAR_PREV_LABEL}>
        ←
      </a>{" "}
      <strong data-testid={CALENDAR_MONTH_TESTID}>{calendarMonthLabel(state.month)}</strong>{" "}
      <a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, 1) })} aria-label={CALENDAR_NEXT_LABEL}>
        →
      </a>
    </p>
    <div role="region" aria-label={EVENTS_CALENDAR_SCROLL_LABEL} tabindex={0} data-testid={EVENTS_CALENDAR_SCROLL_TESTID}>
      <table data-testid={EVENTS_CALENDAR_GRID_TESTID}>
        <caption class="sr-only">{calendarMonthLabel(state.month)}</caption>
        <thead>
          <tr>
            {WEEKDAY_HEADINGS.map((d) => (
              <th scope="col">{d}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr>
              {week.map((day) => (
                <td
                  data-testid={CALENDAR_DAY_TESTID}
                  data-date={day.iso}
                  aria-current={day.isToday ? "date" : undefined}
                  data-outside={day.inMonth ? undefined : "true"}
                >
                  <span>{day.day}</span>
                  <ul>
                    {day.events.map((e) => (
                      <li>
                        <a href={`${calendarUrl({ ...state, view: "list" })}#event-${rowKey(e)}`} data-cal-jump>
                          {wallTimeHm(e.startsAt, rowZone(e, zone))} {gridTitle(rowTitle(e))}
                        </a>
                      </li>
                    ))}
                  </ul>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  </div>
);

/**
 * The events calendar island (legacy Livewire EventsCalendar): one rowset
 * rendered as list or month grid, every control a real anchor so the page is
 * fully functional without JavaScript; the binder upgrades anchors to
 * fragment swaps. Zones: `head` (toggle + links), `actions` (Clear control),
 * `miss` (search-miss block), `content` (empty states / list / grid). Live-status
 * lines, the search input, skeleton and feedback stay outside swapped zones —
 * the input must never be re-created mid-typing.
 */
export const EventsCalendarPage: FC<{
  state: CalendarState;
  upcoming: CalRow[];
  past: PublicEvent[];
  zone: string;
  now: Date;
  emptyState: CalendarEmptyState;
  discordFailed: boolean;
  member: boolean;
  inviteUrl: string;
  appUrl: string;
  /** Rooted path the guest sign-in link carries as ?next= (null = bare link). */
  loginReturnTo?: string | null;
  /** One-shot join confirmation when this page is the join landing (TOG-10356). */
  joinResult?: JoinResult | null;
}> = ({ state, upcoming, past, zone, now, emptyState, discordFailed, member, inviteUrl, appUrl, loginReturnTo = null, joinResult = null }) => {
  const searching = calendarSearching(state);
  const showPast = calendarShowingPast(state);
  const hasVisibleResults = upcoming.length > 0 || (showPast && past.length > 0);
  // An error state suppresses the miss block: a failed read must never read
  // as "no matches" (contract: error beats everything, including a search).
  const searchMiss = searching && !hasVisibleResults && emptyState === null;
  const url = calendarUrl(state);
  const byDay = new Map<string, CalRow[]>();
  for (const e of [...upcoming, ...(showPast ? past : [])]) {
    const key = wallDateIso(e.startsAt, rowZone(e, zone));
    const list = byDay.get(key) ?? [];
    list.push(e);
    byDay.set(key, list);
  }
  const weeks = monthGrid(state.month, wallDateIso(now, zone), byDay);
  return (
    <ScheduleShell title="Events" canonical={canonicalUrl(appUrl, "/events")} description="Game nights, tournaments and whatever else the community puts on." member={member} loginReturnTo={loginReturnTo}>
      <section
        data-island={EVENTS_CALENDAR_ISLAND}
        data-testid={EVENTS_CALENDAR_TESTID}
        data-view={state.view}
        data-month={state.month}
        data-past={state.past ? "1" : ""}
        data-load-error={EVENTS_CALENDAR_FETCH_FAILED}
        aria-labelledby="events-heading"
      >
        <div class="schedule-heading">
          <p class="strap">Community schedule</p>
          <h1 id="events-heading" tabindex={-1}>Events</h1>
          <p>Game nights, tournaments and whatever else the community puts on.</p>
          {!member ? <a class="btn" href="/join">Join the Discord</a> : null}
        </div>
        {/* One-shot join confirmation (legacy join_result): /events is the
            join landing when the CTA carried next=/events. Renders outside the
            island zones so fragment swaps never swallow it. */}
        {joinResult ? <JoinResultBanner result={joinResult} /> : null}

        {/* Live regions OUTSIDE the swapped zones (legacy TOG-5416): they must
            announce without being re-created. */}
        <p role="status" class="sr-only" data-testid={EVENTS_VIEW_STATUS_TESTID}>
          {eventsViewStatusCopy(state.view)}
        </p>
        <p role="status" class="sr-only" data-testid={EVENTS_SEARCH_STATUS_TESTID}>
          {searching && emptyState !== "error" ? (hasVisibleResults ? eventsSearchHitCopy(state.q) : eventsSearchMissCopy(state.q)) : ""}
        </p>
        <p role="status" class="sr-only" data-testid={EVENTS_PAST_STATUS_TESTID}>
          {state.past && past.length > 0 ? EVENTS_PAST_STATUS_COPY : ""}
        </p>
        <p role="status" class="sr-only" data-testid={CALENDAR_MONTH_STATUS_TESTID}>
          {state.view === "calendar" ? calendarMonthLabel(state.month) : ""}
        </p>

        <div data-cal-zone="head">
          <div class="schedule-views" role="group" aria-label={EVENTS_VIEW_GROUP_LABEL}>
            <a
              href={calendarUrl({ ...state, view: "list" })}
              aria-current={state.view === "list" ? "page" : undefined}
              data-testid={EVENTS_VIEW_LIST_TESTID}
            >
              List
            </a>{" "}
            <a
              href={calendarUrl({ ...state, view: "calendar" })}
              aria-current={state.view === "calendar" ? "page" : undefined}
              data-testid={EVENTS_VIEW_CALENDAR_TESTID}
            >
              Calendar
            </a>
          </div>
          <p>
            <a href="/events/past" data-testid={EVENTS_PAST_ARCHIVE_LINK_TESTID}>
              {EVENTS_EMPTY_COPY.pastArchive}
            </a>{" "}
            <a href={EVENTS_SUBSCRIBE_URL} data-testid={EVENTS_SUBSCRIBE_TESTID}>
              {EVENTS_EMPTY_COPY.subscribe}
            </a>{" "}
            <a href="/events.rss">RSS feed</a>
          </p>
        </div>

        {/* The form is stable: the binder debounces input and never swaps it. */}
        <form method="get" action="/events" role="search">
          <label class="sr-only" for="events-search-input">
            {EVENTS_SEARCH_LABEL}
          </label>
          <input
            id="events-search-input"
            type="search"
            name="q"
            value={state.q}
            maxlength={EVENTS_SEARCH_MAX_LENGTH}
            placeholder={EVENTS_SEARCH_PLACEHOLDER}
            aria-label={EVENTS_SEARCH_LABEL}
            data-testid={EVENTS_SEARCH_TESTID}
          />
          <button class="btn" type="submit">Search</button>
          <span data-cal-zone="actions">
            {searching ? (
              <a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_TESTID}>
                {EVENTS_EMPTY_COPY.searchClear}
              </a>
            ) : null}
          </span>
        </form>

        <div data-cal-zone="miss">{searchMiss ? <SearchMiss state={state} /> : null}</div>

        {/* Skeleton: member-started re-renders only — typing is untargeted. */}
        <div data-testid={EVENTS_LOADING_TESTID} hidden>
          <p>{EVENTS_LOADING_COPY}</p>
          {Array.from({ length: EVENTS_LOADING_ROWS }, () => (
            <p aria-hidden="true">…</p>
          ))}
        </div>

        <div data-cal-zone="content" data-testid={EVENTS_CONTENT_TESTID}>
          {emptyState === "error" ? (
            <EmptyError url={url} inviteUrl={inviteUrl} />
          ) : emptyState === "never" ? (
            <EmptyNever inviteUrl={inviteUrl} />
          ) : emptyState === "gap" ? (
            <EmptyGap past={past} zone={zone} />
          ) : null}

          {emptyState === null && hasVisibleResults && state.view === "list" ? (
            <div>
              <h2 class="sr-only">{EVENTS_LIST_HEADING_SR}</h2>
              <ul data-testid={EVENTS_LIST_TESTID}>
                {upcoming.map((e) => (
                  <CalCard e={e} zone={zone} isPast={false} member={member} inviteUrl={inviteUrl} loginReturnTo={loginReturnTo} />
                ))}
              </ul>
              {showPast && past.length > 0 ? (
                <div>
                  <h2>{EVENTS_PAST_LIST_HEADING}</h2>
                  <ul data-testid={EVENTS_PAST_LIST_TESTID}>
                    {past.map((e) => (
                      <CalCard e={e} zone={zone} isPast member={member} inviteUrl={inviteUrl} loginReturnTo={loginReturnTo} />
                    ))}
                  </ul>
                </div>
              ) : null}
              {!showPast && past.length > 0 ? (
                <p>
                  <a href={calendarUrl({ ...state, past: true })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>
                    {EVENTS_PAST_TOGGLE_COPY}
                  </a>
                </p>
              ) : null}
            </div>
          ) : null}

          {emptyState === null && hasVisibleResults && state.view === "calendar" ? (
            <MonthGrid state={state} weeks={weeks} zone={zone} />
          ) : null}
        </div>

        <p role="status" {...{ [EVENTS_CAL_FEEDBACK]: true }} />
      </section>
      <script src="/islands/events-calendar.js" defer />
    </ScheduleShell>
  );
};

export const PastEventsPage: FC<{ rows: PublicEvent[]; page: number; hasMore: boolean; totalPages: number; appUrl: string }> = ({ rows, page, hasMore, totalPages, appUrl }) => (
  <ScheduleShell title="Past events" canonical={canonicalUrl(appUrl, pastEventsUrl(page))} description="Look back at the community’s game nights and tournaments." robots="noindex, follow">
    <section data-island={PAST_EVENTS_ISLAND} data-testid={PAST_EVENTS_TESTID} data-page={page} data-total-pages={totalPages} data-load-error={PAST_EVENTS_COPY.failed} aria-labelledby="past-events-heading">
      <div class="schedule-heading">
        <p class="strap">The archive</p>
        <h1 id="past-events-heading" tabindex={-1}>Past events</h1>
        <p>Game nights we’ve shared. Find the next one in the upcoming schedule.</p>
      </div>
      <div data-archive-state>
        {rows.length === 0 ? (
          totalPages === 0 ? (
            <div data-testid={PAST_EVENTS_EMPTY_TESTID}>
              <p>{PAST_EVENTS_COPY.empty}</p>
              <p><a href="/join">{PAST_EVENTS_COPY.join}</a></p>
            </div>
          ) : (
            <p role="status" data-testid={PAST_EVENTS_OUT_OF_RANGE_TESTID}>{pastEventsOutOfRangeCopy(page, totalPages)}</p>
          )
        ) : null}
      </div>
      <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>{rows.map((e) => <Card e={e} />)}</ul>
      <nav aria-label="Past event pages" data-archive-pager>
        {page > 1 && totalPages > 0 ? (
          <a data-archive-page href={pastEventsUrl(Math.min(page - 1, totalPages))}>Newer</a>
        ) : null}{" "}
        {hasMore ? <a data-archive-page href={pastEventsUrl(page + 1)}>Older</a> : null}
      </nav>
      <p><a href="/events">Back to upcoming events</a></p>
      <p role="status" data-archive-feedback></p>
    </section>
    <script src="/islands/past-events.js" defer />
  </ScheduleShell>
);

// Legacy show.blade.php pitch (data-testid="event-join-pitch"): guests only —
// the blade wraps it in @guest, so any signed-in viewer (member or
// non-member) never sees it. The pitch carries this page as ?next= so the
// journey lands the guest back here after joining. The one-shot join
// confirmation still renders for the newly authenticated member.
export const EventPage: FC<{
  e: PublicEvent;
  neighbors: EventNeighbors;
  related: EventLink[];
  attendees?: EventAttendee[];
  appUrl: string;
  jsonLd: string;
  session?: Session | null;
  joinResult?: JoinResult | null;
  waitlistPosition?: number | null;
}> = ({ e, neighbors, related, attendees = [], appUrl, jsonLd, session, joinResult, waitlistPosition }) => {
  const path = `/e/${e.eventKey}`;
  const canonical = canonicalUrl(appUrl, path);
  return (
    <Shell title={e.title} canonical={canonical} shareTitle={`${e.title} — Together We Own`}
      description={e.description || "An event at Together We Own."}
      robots={e.status === "draft" || e.status === "past" ? "noindex, nofollow" : undefined}>
      {e.status === "draft" ? <p class="notice" data-testid="event-draft">Draft</p> : null}
      {e.status === "past" ? <p class="notice" data-testid="event-past">Past event</p> : null}
      {e.status === "cancelled" ? <p class="notice" data-testid="event-cancelled">Cancelled</p> : null}
      <h1 data-waitlist-position={waitlistPosition ?? ""}>{e.title}</h1>
      {joinResult ? <JoinResultBanner result={joinResult} /> : null}
      <p>
        <time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>
      </p>
      {e.location ? <p data-testid="event-venue">{e.location}</p> : null}
      {e.description ? <p>{e.description}</p> : null}
      <p dangerouslySetInnerHTML={{
        __html: renderGoingCount(e.eventKey, {
          going: e.goingCount,
          capacity: e.capacity,
          showSpotsLeft: true,
          announcement: null,
        }),
      }} />
      {!session ? (
        <section data-testid="event-join-pitch" aria-label="Join the community">
          <p>Game nights get posted here first. Join the Discord and you&apos;ll see them before they land on this page.</p>
          <p>
            <a class="btn" href={`/join?next=${encodeURIComponent(path)}`} data-testid="discord-join">
              Join the Discord
            </a>
          </p>
        </section>
      ) : null}
      <p>
        <a href={`/events/${e.eventKey}.ics`} data-testid="event-ics">Add to calendar (.ics)</a>
        {" · "}
        <a href={googleCalendarUrl(e)} data-testid="event-google-calendar" rel="noopener">Google Calendar</a>
        {" · "}
        <a href={canonical} data-copy-link={canonical} data-testid="event-copy-link">Copy link</a>
      </p>
      <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
      {attendees.length > 0 ? (
        <section aria-labelledby="event-attendees-heading" data-testid="event-attendees">
          <h2 id="event-attendees-heading">Who's going ({attendees.length})</h2>
          <ul>{attendees.map((attendee) => (
            <li><a href={`/members/${encodeURIComponent(attendee.id)}`}>{attendee.name}</a></li>
          ))}</ul>
        </section>
      ) : null}
      <script src="/islands/copy-link.js" defer />
      <script src="/islands/going-count.js" defer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      {neighbors.previous || neighbors.next ? (
        <nav aria-label="More events" data-testid="event-pagination">
          {neighbors.previous ? (
            <a href={`/e/${neighbors.previous.eventKey}`} rel="prev" data-testid="event-previous">
              ← Previous event: {neighbors.previous.title}
            </a>
          ) : null}{" "}
          {neighbors.next ? (
            <a href={`/e/${neighbors.next.eventKey}`} rel="next" data-testid="event-next">
              Next event: {neighbors.next.title} →
            </a>
          ) : null}
        </nav>
      ) : null}
      {related.length > 0 ? (
        <section aria-label="Related events" data-testid="event-related">
          <h2>More events you might like</h2>
          <ul>
            {related.map((event) => (
              <li>
                <a href={`/e/${event.eventKey}`} data-testid="event-related-link">
                  {event.title}{" · "}
                  <time datetime={event.startsAt.toISOString()}>{fmtWithOffset(event.startsAt, event.timezone)}</time>
                  {event.location ? ` · ${event.location}` : ""}
                </a>
              </li>
            ))}
          </ul>
          {!session ? (
            <>
              <p>These fill up fast for members. Join the Discord and you&apos;ll hear about the next one before it lands here.</p>
              <a class="btn" href={`/join?next=${encodeURIComponent(path)}`} data-testid="event-related-join">
                Join the Discord
              </a>
            </>
          ) : null}
        </section>
      ) : null}
    </Shell>
  );
};

export const EventGonePage: FC<{ e: PublicEvent; jsonLd: string }> = ({ e, jsonLd }) => (
  <Shell title={e.title} robots="noindex, nofollow">
    <p class="notice" data-testid="event-cancelled">Cancelled</p>
    <h1>{e.title}</h1>
    <p>This event was cancelled</p>
    <p><a href="/events">See upcoming events</a></p>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
  </Shell>
);
