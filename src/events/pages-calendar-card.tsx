// Calendar event card: one list row for a persisted event or a Discord transient.
import type { FC } from "hono/jsx";
import {
  EVENTS_EMPTY_COPY,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  SPOTS_LEFT_TESTID,
  cardDayLabel,
  cardTimeLabel,
  wallDateIso,
  existingResponsesText,
  goingCountText,
  loginUrl,
  spotsLeftText,
  wallTimeHm,
} from "../islands/contracts";
import { ScheduleDate } from "./pages-shared";
import {
  type CalRow,
  isTransient,
  rowKey,
  rowLocation,
  rowTitle,
  rowZone,
} from "./pages-calendar-row";

// Shared by persisted and Discord cards; count code points, never UTF-16 units.
const DESCRIPTION_LIMIT = 240;

/**
 * One event card (legacy partials/event-card-anon): same markup for every
 * viewer until slice 2 lands the RSVP control — guests get the sign-in link,
 * Discord-native rows get "RSVP in Discord" and no going count (there are no
 * local answers to count). `isPast` suppresses the action area entirely.
 * Cancelled rows keep their title, schedule and badge, but never invite
 * participation: no sign-in link, and the retained answers read as existing
 * responses, never attendance or places.
 */
export const CalCard: FC<{
  e: CalRow;
  zone: string;
  isPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}> = ({ e, zone, isPast, member, inviteUrl, loginReturnTo }) => {
  const tz = rowZone(e, zone);
  const transient = isTransient(e);
  const cancelled = !transient && e.status === "cancelled";
  const startDay = wallDateIso(e.startsAt, tz);
  const endDay = e.endsAt ? wallDateIso(e.endsAt, tz) : null;
  const descriptionPoints = [...(e.description ?? "")];
  return (
    <li>
      <article
        class="schedule-row"
        id={`event-${rowKey(e)}`}
        data-event-key={rowKey(e)}
        data-testid={EVENT_CARD_TESTID}
        tabindex={-1}
      >
        <ScheduleDate date={e.startsAt} zone={tz} />
        <div class="schedule-info">
          {/* Cancelled rows stay listed with their badge, but their detail
              page answers 410 — so the title is plain text, never a dead
              anchor. Transients have no detail page either. */}
          <h3>
            {transient || e.status === "cancelled" ? (
              rowTitle(e)
            ) : (
              <a href={`/e/${e.eventKey}`}>{rowTitle(e)}</a>
            )}
          </h3>
          {!transient && e.game ? <p>{e.game}</p> : null}
          {!transient && e.status === "draft" ? (
            <span class="schedule-badge" data-testid={EVENT_DRAFT_TESTID}>
              Draft
            </span>
          ) : null}
          {!transient && e.status === "cancelled" ? (
            <span class="schedule-badge" data-testid={EVENT_CANCELLED_TESTID}>
              Cancelled
            </span>
          ) : null}
          <p>
            <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, tz)}</time>
            {e.endsAt ? (
              <>
                {" · "}
                <time datetime={e.endsAt.toISOString()}>
                  {(endDay !== startDay
                    ? `${cardDayLabel(e.endsAt, tz)}${endDay!.slice(0, -6) !== startDay.slice(0, -6) ? ` ${endDay!.slice(0, -6)}` : ""}, `
                    : "") + wallTimeHm(e.endsAt, tz)}
                </time>
              </>
            ) : null}{" "}
            <span>{tz}</span>
            {rowLocation(e) ? (
              <>
                {" · "}
                <span>{rowLocation(e)}</span>
              </>
            ) : null}
          </p>
          {descriptionPoints.length > DESCRIPTION_LIMIT ? (
            <details class="schedule-description">
              <summary>
                <span class="schedule-excerpt">
                  {descriptionPoints.slice(0, DESCRIPTION_LIMIT).join("")}…
                  <br />
                </span>
                Full description
              </summary>
              <p>{e.description}</p>
            </details>
          ) : e.description ? (
            <p>{e.description}</p>
          ) : null}
        </div>
        <div class="schedule-actions">
          {!transient ? (
            <span class="schedule-attendance" data-testid="event-going-count">
              {cancelled
                ? existingResponsesText(e.goingCount)
                : goingCountText(e.goingCount, e.capacity)}
              {/* Full marker, same node and copy as the detail lineup: one
                  inline run, because the actions column is a grid and a
                  sibling would stack onto its own row. The verdict reads seat
                  occupancy, never the attributable count alone, so the card
                  never offers a seat the write path cannot grant. Past cards
                  stay unmarked, and cancelled cards stay unmarked too:
                  capacity is meaningless after cancellation, so only the
                  existing-responses line shows. */}
              {!cancelled && !isPast && e.capacity !== null && e.goingOccupancy >= e.capacity ? (
                <>
                  {" · "}
                  <span data-testid={SPOTS_LEFT_TESTID}>
                    {spotsLeftText(e.goingOccupancy, e.capacity)}
                  </span>
                </>
              ) : null}
            </span>
          ) : null}
          {isPast ? null : transient ? (
            <a href={inviteUrl} data-testid={EVENT_DISCORD_RSVP_TESTID}>
              {EVENTS_EMPTY_COPY.discordRsvp}
            </a>
          ) : member || cancelled ? null : (
            <a href={loginUrl(loginReturnTo)} data-testid="signin">
              {EVENTS_EMPTY_COPY.signIn}
            </a>
          )}
        </div>
      </article>
    </li>
  );
};
