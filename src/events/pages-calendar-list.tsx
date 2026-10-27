// Calendar list view: out-of-range note, upcoming cards, pager, and the past drawer.
import type { FC } from "hono/jsx";
import {
  EVENTS_LIST_HEADING_SR,
  EVENTS_LIST_TESTID,
  EVENTS_OUT_OF_RANGE_TESTID,
  EVENTS_PAGER_FIRST_COPY,
  EVENTS_PAGER_FIRST_TESTID,
  EVENTS_PAGER_LABEL,
  EVENTS_PAGER_LAST_COPY,
  EVENTS_PAGER_LAST_TESTID,
  EVENTS_PAGER_NEXT_COPY,
  EVENTS_PAGER_NEXT_TESTID,
  EVENTS_PAGER_PREV_COPY,
  EVENTS_PAGER_PREV_TESTID,
  EVENTS_PAGER_STATUS_TESTID,
  EVENTS_PAGER_TESTID,
  EVENTS_PAST_HIDE_COPY,
  EVENTS_PAST_LIST_HEADING,
  EVENTS_PAST_LIST_TESTID,
  EVENTS_PAST_TOGGLE_COPY,
  EVENTS_PAST_TOGGLE_TESTID,
  calendarSearching,
  calendarUrl,
  upcomingEventsOutOfRangeCopy,
  upcomingEventsPageStatusCopy,
  type CalendarState,
} from "../islands/contracts";
import type { PublicEvent } from "./reads";
import { CalCard } from "./pages-calendar-card";
import type { CalRow } from "./pages-calendar-row";

/** A pager turn: a real anchor so page turns work without JavaScript and the island binder upgrades them to fragment swaps. */
const PagerTurn: FC<{ state: CalendarState; page: number; testid: string; copy: string }> = ({
  state,
  page,
  testid,
  copy,
}) => (
  <a href={calendarUrl({ ...state, page })} data-testid={testid}>
    {copy}
  </a>
);

/**
 * The past preview: bounded past cards plus the native Show/Hide turn. Both
 * views render it, so a preview opened in one view closes in the other.
 * Hide only ever closes a manually opened preview — a non-blank search
 * forces past matches open (`calendarShowingPast`), and clearing the manual
 * flag there would leave the cards up behind a control that claims to hide
 * them, so search screens offer no Hide at all.
 */
export const PastDrawer: FC<{
  state: CalendarState;
  past: PublicEvent[];
  zone: string;
  now: Date;
  showPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}> = ({ state, past, zone, now, showPast, member, inviteUrl, loginReturnTo }) => (
  <>
    {showPast && past.length > 0 ? (
      <div>
        <h2>{EVENTS_PAST_LIST_HEADING}</h2>
        {state.past && !calendarSearching(state) ? (
          <p>
            <a
              href={calendarUrl({ ...state, past: false })}
              data-testid={EVENTS_PAST_TOGGLE_TESTID}
            >
              {EVENTS_PAST_HIDE_COPY}
            </a>
          </p>
        ) : null}
        <ul data-testid={EVENTS_PAST_LIST_TESTID}>
          {past.map((e) => (
            <CalCard
              e={e}
              zone={zone}
              now={now}
              isPast
              member={member}
              inviteUrl={inviteUrl}
              loginReturnTo={loginReturnTo}
            />
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
  </>
);

/** The list view body; the caller gates it on the empty state and the view. */
export const CalendarList: FC<{
  state: CalendarState;
  upcoming: CalRow[];
  past: PublicEvent[];
  zone: string;
  now: Date;
  totalPages: number;
  outOfRange: boolean;
  showPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}> = ({
  state,
  upcoming,
  past,
  zone,
  now,
  totalPages,
  outOfRange,
  showPast,
  member,
  inviteUrl,
  loginReturnTo,
}) => (
  <div>
    {outOfRange ? (
      <p role="status" data-testid={EVENTS_OUT_OF_RANGE_TESTID}>
        {upcomingEventsOutOfRangeCopy(state.page, totalPages)}
      </p>
    ) : null}
    <h2 class="sr-only">{EVENTS_LIST_HEADING_SR}</h2>
    <ul data-testid={EVENTS_LIST_TESTID}>
      {upcoming.map((e) => (
        <CalCard
          e={e}
          zone={zone}
          now={now}
          isPast={false}
          q={state.q}
          member={member}
          inviteUrl={inviteUrl}
          loginReturnTo={loginReturnTo}
        />
      ))}
    </ul>
    {totalPages > 1 || outOfRange ? (
      <nav aria-label={EVENTS_PAGER_LABEL} data-testid={EVENTS_PAGER_TESTID}>
        {/* Boundary turns only where they land somewhere new: First from any
            later or unavailable page, Last only before the final page. An
            out-of-range request therefore recovers straight to page one. */}
        {state.page > 1 && (totalPages > 1 || outOfRange) ? (
          <>
            <PagerTurn
              state={state}
              page={1}
              testid={EVENTS_PAGER_FIRST_TESTID}
              copy={EVENTS_PAGER_FIRST_COPY}
            />{" "}
          </>
        ) : null}
        {state.page > 1 ? (
          <PagerTurn
            state={state}
            page={outOfRange ? Math.min(state.page - 1, totalPages) : state.page - 1}
            testid={EVENTS_PAGER_PREV_TESTID}
            copy={EVENTS_PAGER_PREV_COPY}
          />
        ) : null}{" "}
        {/* The requested page, never clamped: an unavailable page must not be
            announced as the last valid page — the out-of-range note above
            already says it sits outside the schedule. */}
        <span role="status" data-testid={EVENTS_PAGER_STATUS_TESTID}>
          {upcomingEventsPageStatusCopy(state.page, totalPages)}
        </span>{" "}
        {state.page < totalPages ? (
          <PagerTurn
            state={state}
            page={state.page + 1}
            testid={EVENTS_PAGER_NEXT_TESTID}
            copy={EVENTS_PAGER_NEXT_COPY}
          />
        ) : null}
        {totalPages > 1 && state.page < totalPages ? (
          <>
            {" "}
            <PagerTurn
              state={state}
              page={totalPages}
              testid={EVENTS_PAGER_LAST_TESTID}
              copy={EVENTS_PAGER_LAST_COPY}
            />
          </>
        ) : null}
      </nav>
    ) : null}
    <PastDrawer
      state={state}
      past={past}
      zone={zone}
      now={now}
      showPast={showPast}
      member={member}
      inviteUrl={inviteUrl}
      loginReturnTo={loginReturnTo}
    />
  </div>
);
