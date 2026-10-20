// Calendar empty states: never scheduled, gap, read error, and the search miss.
import type { FC } from "hono/jsx";
import {
  DISCORD_JOIN_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_EMPTY_ERROR_TESTID,
  EVENTS_EMPTY_GAP_ITEM_TESTID,
  EVENTS_EMPTY_GAP_LIST_TESTID,
  EVENTS_EMPTY_GAP_TESTID,
  EVENTS_EMPTY_NEVER_TESTID,
  EVENTS_EMPTY_SEARCH_TESTID,
  EVENTS_GAP_LIST_LIMIT,
  EVENTS_PARTIAL_COPY,
  EVENTS_PARTIAL_TESTID,
  EVENTS_RETRY_TESTID,
  EVENTS_SEARCH_CLEAR_EMPTY_TESTID,
  calendarUrl,
  cardTimeLabel,
  eventsSearchMissCopy,
  type CalendarState,
} from "../islands/contracts";
import type { PublicEvent } from "./reads";
import { rowZone } from "./pages-calendar-row";

/** The never-scheduled empty state: invite-first, no "0 events" framing. */
export const EmptyNever: FC<{ inviteUrl: string }> = ({ inviteUrl }) => (
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
export const EmptyGap: FC<{ past: PublicEvent[]; zone: string }> = ({ past, zone }) => (
  <div data-testid={EVENTS_EMPTY_GAP_TESTID}>
    <h2>{EVENTS_EMPTY_COPY.gapTitle}</h2>
    <h3>{EVENTS_EMPTY_COPY.gapListHeading}</h3>
    <ul data-testid={EVENTS_EMPTY_GAP_LIST_TESTID}>
      {past.slice(0, EVENTS_GAP_LIST_LIMIT).map((e) => (
        <li data-testid={EVENTS_EMPTY_GAP_ITEM_TESTID}>
          {/* Same dead-anchor rule as the card title: cancelled detail pages
              answer 410, so the gap list keeps the title as plain text. */}
          {e.status === "cancelled" ? e.title : <a href={`/e/${e.eventKey}`}>{e.title}</a>}{" "}
          <time datetime={e.startsAt.toISOString()}>
            {cardTimeLabel(e.startsAt, rowZone(e, zone))}
          </time>
        </li>
      ))}
    </ul>
    <p>
      <a href="/events/past">{EVENTS_EMPTY_COPY.pastArchive}</a>
    </p>
  </div>
);

/** A read failed (role=alert): Retry re-issues the same URL; the join link is the human fallback. */
export const EmptyError: FC<{ url: string; inviteUrl: string }> = ({ url, inviteUrl }) => (
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

/** Partial source (role=status): healthy rows stay visible beside this notice.
 * Retry re-issues the same URL; the join link is the human fallback. */
export const PartialSourceNotice: FC<{ url: string; inviteUrl: string }> = ({ url, inviteUrl }) => (
  <div role="status" data-testid={EVENTS_PARTIAL_TESTID}>
    <p>{EVENTS_PARTIAL_COPY.notice}</p>
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
export const SearchMiss: FC<{ state: CalendarState }> = ({ state }) => (
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
