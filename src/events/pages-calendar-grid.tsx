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
  GRID_CANCELLED_COPY,
  WEEKDAY_HEADINGS,
  addCalendarMonth,
  calendarJumpUrl,
  calendarMonthLabel,
  calendarUrl,
  gridAccessibleName,
  gridContinuationAccessibleName,
  gridTitle,
  wallDateIso,
  wallMonth,
  wallTimeHm,
  type CalendarDay,
  type CalendarState,
} from "../islands/contracts";
import { type CalRow, isTransient, rowKey, rowTitle, rowZone } from "./pages-calendar-row";

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
    {/* Native GET jump: view, game and the committed past state ride as hidden
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
      {state.game?.trim() ? <input type="hidden" name="game" value={state.game.trim()} /> : null}
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
                    {day.events.map((e) => {
                      const entryZone = rowZone(e, zone);
                      // A row lands on a non-start cell only through canonical
                      // interval expansion — transients and past rows bucket on
                      // their start day — so a day mismatch is exactly the
                      // continuation case.
                      const continued = day.iso !== wallDateIso(e.startsAt, entryZone);
                      // Cancelled entries keep their day-jump to the retained
                      // list card, but say so in words — never color alone —
                      // with the same badge word the card carries.
                      const cancelled = !isTransient(e) && e.status === "cancelled";
                      return (
                        <li>
                          <a
                            href={calendarJumpUrl(state.past, rowKey(e), state.game)}
                            data-cal-jump
                            data-cancelled={cancelled ? "true" : undefined}
                            aria-label={
                              continued
                                ? gridContinuationAccessibleName(rowTitle(e), day.iso, cancelled)
                                : gridAccessibleName(rowTitle(e), e.startsAt, entryZone, cancelled)
                            }
                          >
                            {continued
                              ? `Continues ${gridTitle(rowTitle(e))}`
                              : `${wallTimeHm(e.startsAt, entryZone)} ${gridTitle(rowTitle(e))}`}
                            {cancelled ? (
                              <>
                                {" "}
                                <span class="schedule-badge">{GRID_CANCELLED_COPY}</span>
                              </>
                            ) : null}
                          </a>
                        </li>
                      );
                    })}
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
