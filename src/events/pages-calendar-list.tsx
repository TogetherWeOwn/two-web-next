// Calendar list view: out-of-range note, upcoming cards, pager, and the past drawer.
import type { FC } from "hono/jsx";
import {
  EVENTS_LIST_HEADING_SR,
  EVENTS_LIST_TESTID,
  EVENTS_OUT_OF_RANGE_TESTID,
  EVENTS_PAGER_LABEL,
  EVENTS_PAGER_NEXT_COPY,
  EVENTS_PAGER_NEXT_TESTID,
  EVENTS_PAGER_PREV_COPY,
  EVENTS_PAGER_PREV_TESTID,
  EVENTS_PAGER_STATUS_TESTID,
  EVENTS_PAGER_TESTID,
  EVENTS_PAST_LIST_HEADING,
  EVENTS_PAST_LIST_TESTID,
  EVENTS_PAST_TOGGLE_COPY,
  EVENTS_PAST_TOGGLE_TESTID,
  calendarUrl,
  upcomingEventsOutOfRangeCopy,
  upcomingEventsPageStatusCopy,
  type CalendarState,
} from "../islands/contracts";
import type { ScheduleContext } from "./schedule-context";
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

/** The list view body; the caller gates it on the empty state and the view. */
export const CalendarList: FC<{
  state: CalendarState;
  schedule?: ScheduleContext | null;
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
  schedule,
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
          schedule={schedule}
          zone={zone}
          now={now}
          isPast={false}
          member={member}
          inviteUrl={inviteUrl}
          loginReturnTo={loginReturnTo}
        />
      ))}
    </ul>
    {totalPages > 1 || outOfRange ? (
      <nav aria-label={EVENTS_PAGER_LABEL} data-testid={EVENTS_PAGER_TESTID}>
        {state.page > 1 ? (
          <PagerTurn
            state={state}
            page={outOfRange ? Math.min(state.page - 1, totalPages) : state.page - 1}
            testid={EVENTS_PAGER_PREV_TESTID}
            copy={EVENTS_PAGER_PREV_COPY}
          />
        ) : null}{" "}
        <span role="status" data-testid={EVENTS_PAGER_STATUS_TESTID}>
          {upcomingEventsPageStatusCopy(Math.min(state.page, Math.max(totalPages, 1)), totalPages)}
        </span>{" "}
        {state.page < totalPages ? (
          <PagerTurn
            state={state}
            page={state.page + 1}
            testid={EVENTS_PAGER_NEXT_TESTID}
            copy={EVENTS_PAGER_NEXT_COPY}
          />
        ) : null}
      </nav>
    ) : null}
    {showPast && past.length > 0 ? (
      <div>
        <h2>{EVENTS_PAST_LIST_HEADING}</h2>
        <ul data-testid={EVENTS_PAST_LIST_TESTID}>
          {past.map((e) => (
            <CalCard
              e={e}
              schedule={schedule}
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
  </div>
);
