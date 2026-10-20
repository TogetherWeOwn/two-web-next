// Calendar month grid: prev/next anchors are real links; cells link into the list.
import type { FC } from "hono/jsx";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_JUMP_INPUT_ID,
  CALENDAR_MONTH_JUMP_LABEL,
  CALENDAR_MONTH_JUMP_SUBMIT_COPY,
  CALENDAR_MONTH_JUMP_SUBMIT_TESTID,
  CALENDAR_MONTH_JUMP_TESTID,
  CALENDAR_MONTH_MAX,
  CALENDAR_MONTH_MIN,
  CALENDAR_MONTH_TESTID,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
  CALENDAR_THIS_MONTH_COPY,
  CALENDAR_THIS_MONTH_TESTID,
  EVENTS_CALENDAR_GRID_TESTID,
  EVENTS_CALENDAR_SCROLL_LABEL,
  EVENTS_CALENDAR_SCROLL_TESTID,
  WEEKDAY_HEADINGS,
  addCalendarMonth,
  calendarJumpUrl,
  calendarMonthLabel,
  calendarUrl,
  gridAccessibleName,
  gridTitle,
  wallMonth,
  wallTimeHm,
  type CalendarDay,
  type CalendarState,
} from "../islands/contracts";
import { type CalRow, rowKey, rowTitle, rowZone } from "./pages-calendar-row";

/** The month grid: prev/next anchors are real links; cells link into the list. */
export const MonthGrid: FC<{
  state: CalendarState;
  weeks: CalendarDay<CalRow>[][];
  zone: string;
  now: Date;
}> = ({ state, weeks, zone, now }) => (
  <div class="schedule-month">
    <p class="schedule-month-nav">
      <a
        href={calendarUrl({ ...state, month: addCalendarMonth(state.month, -1) })}
        aria-label={CALENDAR_PREV_LABEL}
      >
        ←
      </a>{" "}
      <strong data-testid={CALENDAR_MONTH_TESTID}>{calendarMonthLabel(state.month)}</strong>{" "}
      <a
        href={calendarUrl({ ...state, month: addCalendarMonth(state.month, 1) })}
        aria-label={CALENDAR_NEXT_LABEL}
      >
        →
      </a>{" "}
      {/* This month is server-derived in the model zone, like the grid's
          today column: the same instant both pick the same month. */}
      <a
        href={calendarUrl({ ...state, month: wallMonth(now, zone) })}
        data-testid={CALENDAR_THIS_MONTH_TESTID}
      >
        {CALENDAR_THIS_MONTH_COPY}
      </a>
    </p>
    {/* Native GET jump: view and the committed past state ride as hidden
        fields, so the no-JS submit lands on the same URL the binder fetches.
        A jump is month-scoped — the search query never rides along. */}
    <form data-testid={CALENDAR_MONTH_JUMP_TESTID} method="get" action="/events">
      <label for={CALENDAR_MONTH_JUMP_INPUT_ID}>{CALENDAR_MONTH_JUMP_LABEL}</label>{" "}
      <input
        id={CALENDAR_MONTH_JUMP_INPUT_ID}
        type="month"
        name="month"
        value={state.month}
        min={CALENDAR_MONTH_MIN}
        max={CALENDAR_MONTH_MAX}
      />{" "}
      <input type="hidden" name="view" value="calendar" />
      {state.past ? <input type="hidden" name="past" value="1" /> : null}{" "}
      <button class="btn" type="submit" data-testid={CALENDAR_MONTH_JUMP_SUBMIT_TESTID}>
        {CALENDAR_MONTH_JUMP_SUBMIT_COPY}
      </button>
    </form>
    <div
      role="region"
      aria-label={EVENTS_CALENDAR_SCROLL_LABEL}
      tabindex={0}
      data-testid={EVENTS_CALENDAR_SCROLL_TESTID}
    >
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
                        <a
                          href={calendarJumpUrl(state.past, rowKey(e))}
                          data-cal-jump
                          aria-label={gridAccessibleName(rowTitle(e), e.startsAt, rowZone(e, zone))}
                        >
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
