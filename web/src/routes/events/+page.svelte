<script lang="ts">
import CalendarCard from "#lib/CalendarCard.svelte";
import Shell from "#lib/Shell.svelte";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_STATUS_TESTID,
  CALENDAR_MONTH_TESTID,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  DISCORD_JOIN_TESTID,
  EVENTS_CALENDAR_FETCH_FAILED,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_ISLAND,
  EVENTS_CALENDAR_SCROLL_LABEL,
  EVENTS_CALENDAR_SCROLL_TESTID,
  EVENTS_CALENDAR_TESTID,
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
  EVENTS_OUT_OF_RANGE_TESTID,
  EVENTS_PAGER_LABEL,
  EVENTS_PAGER_NEXT_COPY,
  EVENTS_PAGER_NEXT_TESTID,
  EVENTS_PAGER_PREV_COPY,
  EVENTS_PAGER_PREV_TESTID,
  EVENTS_PAGER_STATUS_TESTID,
  EVENTS_PAGER_TESTID,
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
  EVENTS_SEARCH_TOO_LONG_COPY,
  EVENTS_SUBSCRIBE_TESTID,
  EVENTS_VIEW_CALENDAR_TESTID,
  EVENTS_VIEW_GROUP_LABEL,
  EVENTS_VIEW_LIST_TESTID,
  EVENTS_VIEW_STATUS_TESTID,
  WEEKDAY_HEADINGS,
  addCalendarMonth,
  calendarJumpUrl,
  calendarMonthLabel,
  calendarSearching,
  calendarShowingPast,
  calendarUrl,
  cardTimeLabel,
  eventsSearchHitCopy,
  eventsSearchMissCopy,
  eventsViewStatusCopy,
  gridAccessibleName,
  gridTitle,
  monthGrid,
  upcomingEventsOutOfRangeCopy,
  upcomingEventsPageStatusCopy,
  wallDateIso,
  wallTimeHm,
} from "../../../../src/islands/contracts";
import { rowKey, rowTitle, rowZone, type CalRow } from "../../../../src/events/pages-calendar-row";
import { feedUrl, webcalUrl } from "../../../../src/events/feeds";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

// Markup contract of EventsCalendarPage (src/events/pages-calendar-screen.tsx):
// the island script, test ids and copy are shared, so the existing E2E and
// island apply. Markup is compact on purpose: Svelte preserves source
// whitespace inside text while Hono JSX collapses it, so only compact markup
// renders the same bytes (same precedent as the archive page).
let { data }: PageProps = $props();
const view = $derived(data.queryTooLong ? null : data);
const state = $derived(view?.state);
const searching = $derived(state ? calendarSearching(state) : false);
const showPast = $derived(state ? calendarShowingPast(state) : false);
const hasVisibleResults = $derived(
  view ? view.upcoming.length > 0 || (showPast && view.past.length > 0) : false,
);
const outOfRange = $derived(
  view ? state?.view === "list" && view.upcoming.length === 0 && view.totalPages > 0 : false,
);
const searchMiss = $derived(
  view && state
    ? searching && !hasVisibleResults && view.emptyState === null && !outOfRange
    : false,
);
const shareUrl = $derived(state ? calendarUrl(state) : "/events");
const byDay = $derived.by(() => {
  const map = new Map<string, CalRow[]>();
  if (!view || !state) return map;
  for (const e of [...view.upcoming, ...(showPast ? view.past : [])]) {
    const key = wallDateIso(e.startsAt, rowZone(e, view.zone));
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return map;
});
const weeks = $derived(
  view && state ? monthGrid(state.month, wallDateIso(view.now, view.zone), byDay) : [],
);
// A component-level <script> is Svelte's own; the island tag is emitted as markup.
const island = '<script src="/islands/events-calendar.js" defer></' + "script>";
</script>

<svelte:head>
  <link rel="alternate" type="text/markdown" title="Markdown version" href="/events.md" />
</svelte:head>

{#snippet accountMember()}<a class="btn" href="/discord">Open Discord</a>{/snippet}
{#if data.queryTooLong}
  <Shell title="Events" canonical={canonicalUrl(data.appUrl, "/events")} robots="noindex, follow" theme="schedule" activeNav="events" mainClass="events-page">
    <div class="schedule-heading"><p class="strap">Community schedule</p><h1>Events</h1></div>
    <p role="alert">{EVENTS_SEARCH_TOO_LONG_COPY}</p>
    <p><a href="/events">Back to events</a></p>
  </Shell>
{:else if view && state}
  <Shell
    title="Events"
    canonical={view.canonical}
    robots={view.robots}
    description="Game nights, tournaments and whatever else the community puts on."
    theme="schedule"
    activeNav="events"
    mainClass="events-page"
    loginReturnTo={view.loginReturnTo}
    accountChrome={view.member ? accountMember : undefined}
  >
    <section data-island={EVENTS_CALENDAR_ISLAND} data-testid={EVENTS_CALENDAR_TESTID} data-view={state.view} data-month={state.month} data-past={state.past ? "1" : ""} data-load-error={EVENTS_CALENDAR_FETCH_FAILED} data-search-max-length={EVENTS_SEARCH_MAX_LENGTH} data-search-too-long={EVENTS_SEARCH_TOO_LONG_COPY} aria-labelledby="events-heading">
      <div class="schedule-heading"><p class="strap">Community schedule</p><!-- svelte-ignore a11y_no_noninteractive_tabindex: skip-link/focus target, as on the Hono page. --><h1 id="events-heading" tabindex="-1">Events</h1><p>Game nights, tournaments and whatever else the community puts on.</p>{#if !view.member}<a class="btn" href={view.loginReturnTo ? `/join?next=${encodeURIComponent(view.loginReturnTo)}` : "/join"}>Join the Discord</a>{/if}</div>
      {#if view.joinResult}<p class="notice" role="status" data-testid="join-result">{#if view.joinResult === "added"}You are in. Finish Discord's rules screening before you can post.{:else}You are already in the server.{" "}<a href="/discord" data-testid="reinvite-link">Rejoin with the Discord invite</a>{/if}</p>{/if}
      <p role="status" class="sr-only" data-testid={EVENTS_VIEW_STATUS_TESTID}>{eventsViewStatusCopy(state.view)}</p>
      <p role="status" class="sr-only" data-testid={EVENTS_SEARCH_STATUS_TESTID}>{searching && view.emptyState !== "error" ? (hasVisibleResults || outOfRange ? eventsSearchHitCopy(state.q) : eventsSearchMissCopy(state.q)) : ""}</p>
      <p role="status" class="sr-only" data-testid={EVENTS_PAST_STATUS_TESTID}>{state.past && view.past.length > 0 ? EVENTS_PAST_STATUS_COPY : ""}</p>
      <p role="status" class="sr-only" data-testid={CALENDAR_MONTH_STATUS_TESTID}>{state.view === "calendar" ? calendarMonthLabel(state.month) : ""}</p>
      <div data-cal-zone="head"><div class="schedule-views" role="group" aria-label={EVENTS_VIEW_GROUP_LABEL}><a href={calendarUrl({ ...state, view: "list" })} aria-current={state.view === "list" ? "page" : undefined} data-testid={EVENTS_VIEW_LIST_TESTID}>List</a>{" "}<a href={calendarUrl({ ...state, view: "calendar" })} aria-current={state.view === "calendar" ? "page" : undefined} data-testid={EVENTS_VIEW_CALENDAR_TESTID}>Calendar</a></div><p><a href="/events/past" data-testid={EVENTS_PAST_ARCHIVE_LINK_TESTID}>{EVENTS_EMPTY_COPY.pastArchive}</a>{" "}<a href={webcalUrl(view.appUrl)} data-testid={EVENTS_SUBSCRIBE_TESTID}>{EVENTS_EMPTY_COPY.subscribe}</a>{" "}<a href={feedUrl(view.appUrl)}>Download calendar (.ics)</a>{" "}<a href="/events.rss">RSS feed</a></p></div>
      <form method="get" action="/events" role="search"><label class="sr-only" for="events-search-input">{EVENTS_SEARCH_LABEL}</label><input id="events-search-input" type="search" name="q" value={state.q} placeholder={EVENTS_SEARCH_PLACEHOLDER} aria-label={EVENTS_SEARCH_LABEL} data-testid={EVENTS_SEARCH_TESTID} /><button class="btn" type="submit">Search</button><span data-cal-zone="actions">{#if state.past}<input type="hidden" name="past" value="1" />{/if}{#if searching}<a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_TESTID}>{EVENTS_EMPTY_COPY.searchClear}</a>{/if}</span></form>
      <p role="status" data-cal-feedback></p>
      <div data-cal-zone="miss">{#if searchMiss}<div data-testid={EVENTS_EMPTY_SEARCH_TESTID}><h2>{EVENTS_EMPTY_COPY.searchMissTitle}</h2><p>{eventsSearchMissCopy(state.q)}</p><p>{EVENTS_EMPTY_COPY.searchMissBody}</p><p><a href={calendarUrl({ ...state, q: "" })} data-testid={EVENTS_SEARCH_CLEAR_EMPTY_TESTID}>{EVENTS_EMPTY_COPY.searchMissClear}</a></p></div>{/if}</div>
      <div data-testid={EVENTS_LOADING_TESTID} hidden><p>{EVENTS_LOADING_COPY}</p>{#each Array.from({ length: EVENTS_LOADING_ROWS }, (_, i) => i) as i (i)}<p aria-hidden="true">…</p>{/each}</div>
      <div data-cal-zone="content" data-testid={EVENTS_CONTENT_TESTID}>
        {#if view.emptyState === "error"}<div role="alert" data-testid={EVENTS_EMPTY_ERROR_TESTID}><h2>{EVENTS_EMPTY_COPY.errorTitle}</h2><p>{EVENTS_EMPTY_COPY.errorBody}</p><p><a href={shareUrl} data-testid={EVENTS_RETRY_TESTID}>{EVENTS_EMPTY_COPY.retry}</a>{" "}<a href={view.inviteUrl} data-testid={DISCORD_JOIN_TESTID}>{EVENTS_EMPTY_COPY.join}</a></p></div>
        {:else if view.emptyState === "never"}<div data-testid={EVENTS_EMPTY_NEVER_TESTID}><h2>{EVENTS_EMPTY_COPY.neverTitle}</h2><p>{EVENTS_EMPTY_COPY.neverBody}</p><p><a href={view.inviteUrl} data-testid={DISCORD_JOIN_TESTID}>{EVENTS_EMPTY_COPY.join}</a></p></div>
        {:else if view.emptyState === "gap"}<div data-testid={EVENTS_EMPTY_GAP_TESTID}><h2>{EVENTS_EMPTY_COPY.gapTitle}</h2><h3>{EVENTS_EMPTY_COPY.gapListHeading}</h3><ul data-testid={EVENTS_EMPTY_GAP_LIST_TESTID}>{#each view.past.slice(0, EVENTS_GAP_LIST_LIMIT) as e (e.eventKey)}<li data-testid={EVENTS_EMPTY_GAP_ITEM_TESTID}>{#if e.status === "cancelled"}{e.title}{:else}<a href={`/e/${e.eventKey}`}>{e.title}</a>{/if}{" "}<time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, rowZone(e, view.zone))}</time></li>{/each}</ul><p><a href="/events/past">{EVENTS_EMPTY_COPY.pastArchive}</a></p></div>
        {/if}
        {#if view.emptyState === null && (hasVisibleResults || outOfRange) && state.view === "list"}<div>{#if outOfRange}<p role="status" data-testid={EVENTS_OUT_OF_RANGE_TESTID}>{upcomingEventsOutOfRangeCopy(state.page, view.totalPages)}</p>{/if}<h2 class="sr-only">{EVENTS_LIST_HEADING_SR}</h2><ul data-testid={EVENTS_LIST_TESTID}>{#each view.upcoming as e (rowKey(e))}<CalendarCard {e} zone={view.zone} isPast={false} member={view.member} inviteUrl={view.inviteUrl} loginReturnTo={view.loginReturnTo} />{/each}</ul>{#if view.totalPages > 1 || outOfRange}<nav aria-label={EVENTS_PAGER_LABEL} data-testid={EVENTS_PAGER_TESTID}>{#if state.page > 1}<a href={calendarUrl({ ...state, page: outOfRange ? Math.min(state.page - 1, view.totalPages) : state.page - 1 })} data-testid={EVENTS_PAGER_PREV_TESTID}>{EVENTS_PAGER_PREV_COPY}</a>{/if}{" "}<span role="status" data-testid={EVENTS_PAGER_STATUS_TESTID}>{upcomingEventsPageStatusCopy(Math.min(state.page, Math.max(view.totalPages, 1)), view.totalPages)}</span>{" "}{#if state.page < view.totalPages}<a href={calendarUrl({ ...state, page: state.page + 1 })} data-testid={EVENTS_PAGER_NEXT_TESTID}>{EVENTS_PAGER_NEXT_COPY}</a>{/if}</nav>{/if}{#if showPast && view.past.length > 0}<div><h2>{EVENTS_PAST_LIST_HEADING}</h2><ul data-testid={EVENTS_PAST_LIST_TESTID}>{#each view.past as e (e.eventKey)}<CalendarCard {e} zone={view.zone} isPast member={view.member} inviteUrl={view.inviteUrl} loginReturnTo={view.loginReturnTo} />{/each}</ul></div>{/if}{#if !showPast && view.past.length > 0}<p><a href={calendarUrl({ ...state, past: true })} data-testid={EVENTS_PAST_TOGGLE_TESTID}>{EVENTS_PAST_TOGGLE_COPY}</a></p>{/if}</div>{/if}
        {#if view.emptyState === null && state.view === "calendar"}<div class="schedule-month"><p class="schedule-month-nav"><a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, -1) })} aria-label={CALENDAR_PREV_LABEL}>←</a>{" "}<strong data-testid={CALENDAR_MONTH_TESTID}>{calendarMonthLabel(state.month)}</strong>{" "}<a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, 1) })} aria-label={CALENDAR_NEXT_LABEL}>→</a></p><!-- svelte-ignore a11y_no_noninteractive_tabindex: keyboard-scrollable region, as on the Hono page. --><div role="region" aria-label={EVENTS_CALENDAR_SCROLL_LABEL} tabindex="0" data-testid={EVENTS_CALENDAR_SCROLL_TESTID}><table data-testid={EVENTS_CALENDAR_GRID_TESTID}><caption class="sr-only">{calendarMonthLabel(state.month)}</caption><thead><tr>{#each WEEKDAY_HEADINGS as d}<th scope="col">{d}</th>{/each}</tr></thead><tbody>{#each weeks as week}<tr>{#each week as day (day.iso)}<td data-testid={CALENDAR_DAY_TESTID} data-date={day.iso} aria-current={day.isToday ? "date" : undefined} data-outside={day.inMonth ? undefined : "true"}><span>{day.day}</span><ul>{#each day.events as e (rowKey(e))}<li><a href={calendarJumpUrl(state.past, rowKey(e))} data-cal-jump aria-label={gridAccessibleName(rowTitle(e), e.startsAt, rowZone(e, view.zone))}>{wallTimeHm(e.startsAt, rowZone(e, view.zone))} {gridTitle(rowTitle(e))}</a></li>{/each}</ul></td>{/each}</tr>{/each}</tbody></table></div></div>{/if}
      </div>
    </section>
    {@html island}
  </Shell>
{/if}
