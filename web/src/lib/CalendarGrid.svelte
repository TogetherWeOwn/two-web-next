<script lang="ts">
import {
  CALENDAR_MONTH_MAX, CALENDAR_MONTH_MIN, WEEKDAY_HEADINGS, addCalendarMonth,
  calendarJumpUrl, calendarMonthLabel, calendarUrl, gridAccessibleName,
  gridContinuationAccessibleName, gridTitle, isValidZone, wallDateIso, wallMonth, wallTimeHm,
} from "../../../src/islands/contracts";
import { ONGOING_COPY } from "../../../src/events/ongoing";
import type { CalendarGridProps } from "./calendar-grid";

let { state, weeks, zone, now }: CalendarGridProps = $props();
// The horizontally scrollable region needs keyboard focus on narrow screens.
const scrollAttributes = { tabindex: 0 };
</script>

<div class="schedule-month">
  <p class="schedule-month-nav">
    <a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, -1) })} aria-label="Previous month">←</a>{" "}
    <strong data-testid="calendar-month">{calendarMonthLabel(state.month)}</strong>{" "}
    <a href={calendarUrl({ ...state, month: addCalendarMonth(state.month, 1) })} aria-label="Next month">→</a>{" "}
    <a href={calendarUrl({ ...state, month: wallMonth(now, zone) })} data-testid="calendar-this-month">This month</a>
  </p>
  <form data-testid="calendar-month-jump" method="get" action="/events">
    <label for="calendar-month-jump-input">Jump to month</label>{" "}
    <input id="calendar-month-jump-input" type="month" name="month" value={state.month} min={CALENDAR_MONTH_MIN} max={CALENDAR_MONTH_MAX} />{" "}
    <input type="hidden" name="view" value="calendar" />
    {#if state.game?.trim()}<input type="hidden" name="game" value={state.game.trim()} />{/if}
    {#if state.past}<input type="hidden" name="past" value="1" />{/if}{" "}
    <button class="btn" type="submit" data-testid="calendar-month-jump-submit">Go</button>
  </form>
  <div role="region" aria-label="Events calendar; scroll horizontally to see all days" {...scrollAttributes} data-testid="events-calendar-scroll">
    <table data-testid="events-calendar-grid">
      <caption class="sr-only">{calendarMonthLabel(state.month)}</caption>
      <thead><tr>{#each WEEKDAY_HEADINGS as day}<th scope="col">{day}</th>{/each}</tr></thead>
      <tbody>
        {#each weeks as week}
          <tr>
            {#each week as day}
              <td data-testid="calendar-day" data-date={day.iso} aria-current={day.isToday ? "date" : undefined} data-outside={day.inMonth ? undefined : "true"}>
                <span>{day.day}</span>
                <ul>
                  {#each day.events as event}
                    {@const entryZone = isValidZone(event.zone) ? event.zone : "UTC"}
                    {@const continued = day.iso !== wallDateIso(event.startsAt, entryZone)}
                    {@const availabilityText = event.ongoing ? [ONGOING_COPY, event.availability].filter(Boolean).join(" ") : event.availability}
                    <li><a href={calendarJumpUrl(state.past, event.key, state.game)} data-cal-jump data-cancelled={event.cancelled ? "true" : undefined} aria-label={continued ? gridContinuationAccessibleName(event.title, day.iso, event.cancelled, availabilityText) : gridAccessibleName(event.title, event.startsAt, entryZone, event.cancelled, availabilityText)}>
                      {continued ? `Continues ${gridTitle(event.title)}` : `${wallTimeHm(event.startsAt, entryZone)} ${entryZone} ${gridTitle(event.title)}`}{#if event.cancelled}{" "}<span class="schedule-badge">Cancelled</span>{/if}{#if event.ongoing}{" "}<span class="schedule-badge" data-testid="event-ongoing">{ONGOING_COPY}</span>{/if}{#if event.availability}{" "}<span data-testid="event-schedule-availability">{event.availability}</span>{/if}
                    </a></li>
                  {/each}
                </ul>
              </td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
</div>
