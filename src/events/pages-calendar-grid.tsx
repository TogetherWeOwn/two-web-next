// Calendar month grid: prev/next anchors are real links; cells link into the list.
import type { FC } from "hono/jsx";
import {
  CALENDAR_DAY_TESTID,
  CALENDAR_MONTH_TESTID,
  CALENDAR_NEXT_LABEL,
  CALENDAR_PREV_LABEL,
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
  gridTitle,
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
}> = ({ state, weeks, zone }) => (
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
      </a>
    </p>
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
                      // Cancelled entries keep their day-jump to the retained
                      // list card, but say so in words — never color alone —
                      // with the same badge word the card carries.
                      const cancelled = !isTransient(e) && e.status === "cancelled";
                      return (
                        <li>
                          <a
                            href={calendarJumpUrl(state.past, rowKey(e))}
                            data-cal-jump
                            data-cancelled={cancelled ? "true" : undefined}
                            aria-label={gridAccessibleName(
                              rowTitle(e),
                              e.startsAt,
                              rowZone(e, zone),
                              cancelled,
                            )}
                          >
                            {wallTimeHm(e.startsAt, rowZone(e, zone))} {gridTitle(rowTitle(e))}
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
