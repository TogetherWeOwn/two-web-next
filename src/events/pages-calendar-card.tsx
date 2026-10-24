// Calendar event card: one list row for a persisted event or a Discord transient.
import type { FC } from "hono/jsx";
import {
  EVENTS_EMPTY_COPY,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  SCHEDULE_AVAILABILITY_TESTID,
  SPOTS_LEFT_TESTID,
  cardTimeLabel,
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
  rowAvailability,
  rowKey,
  rowLocation,
  rowTitle,
  rowZone,
} from "./pages-calendar-row";

/**
 * One event card (legacy partials/event-card-anon): same markup for every
 * viewer until slice 2 lands the RSVP control — guests get the sign-in link,
 * Discord-native rows get "RSVP in Discord" and no going count (there are no
 * local answers to count). `isPast` suppresses the action area entirely.
 * Cancelled rows keep their title, schedule and badge, but never invite
 * participation: no sign-in link, and the retained answers read as existing
 * responses, never attendance or places. The availability line
 * (`rowAvailability`: "N seats left", "RSVPs paused", "Ended", "No seat
 * limit", "Discord-managed") is a server-rendered snapshot from existing row
 * data — never a reservation — so members need not open a night to learn it
 * is paused or full. `now` is the same model instant the screen renders with.
 */
export const CalCard: FC<{
  e: CalRow;
  zone: string;
  now: Date;
  isPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}> = ({ e, zone, now, isPast, member, inviteUrl, loginReturnTo }) => {
  const tz = rowZone(e, zone);
  const transient = isTransient(e);
  const cancelled = !transient && e.status === "cancelled";
  // The drawer context wins over row dates: a card shown under past events
  // reads Ended even if a fixture disagrees about the instant.
  const availability = rowAvailability(e, now, isPast);
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
          {/* The badges sit between block paragraphs; the explicit spaces keep
              their words separated in textContent ("Galactic Cancelled Fri",
              never "GalacticCancelledFri"). Line-edge whitespace collapses, so
              the rendered layout is unchanged. */}
          {!transient && e.status === "draft" ? (
            <>
              {" "}
              <span class="schedule-badge" data-testid={EVENT_DRAFT_TESTID}>
                Draft
              </span>{" "}
            </>
          ) : null}
          {!transient && e.status === "cancelled" ? (
            <>
              {" "}
              <span class="schedule-badge" data-testid={EVENT_CANCELLED_TESTID}>
                Cancelled
              </span>{" "}
            </>
          ) : null}
          <p>
            <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, tz)}</time>
            {e.endsAt ? (
              <>
                {" · "}
                <span>{wallTimeHm(e.endsAt, tz)}</span>
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
          {e.description ? <p>{e.description}</p> : null}
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
                  capacity is meaningless after the end, so only the
                  existing-responses line shows. Ended covers the drawer flag
                  and the row dates alike (see `availability` above), so an
                  upcoming row whose interval already elapsed reads Ended,
                  never Full. A paused row keeps its supplemental Full marker
                  beside the paused line: paused wins the verdict, the marker
                  stays as capacity fact. */}
              {!cancelled &&
              availability?.state !== "past" &&
              e.capacity !== null &&
              e.goingOccupancy >= e.capacity ? (
                <>
                  {" · "}
                  <span data-testid={SPOTS_LEFT_TESTID}>
                    {spotsLeftText(e.goingOccupancy, e.capacity)}
                  </span>
                </>
              ) : null}
              {/* Availability snapshot: paused/remaining/ended/uncapped. The
                  full state keeps the marker above, so it renders no second
                  node; cancelled and draft rows render none at all. */}
              {!cancelled && availability && availability.state !== "full" ? (
                <>
                  {" · "}
                  <span data-testid={SCHEDULE_AVAILABILITY_TESTID}>{availability.text}</span>
                </>
              ) : null}
            </span>
          ) : availability ? (
            <span class="schedule-attendance" data-testid={SCHEDULE_AVAILABILITY_TESTID}>
              {availability.text}
            </span>
          ) : null}{" "}
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
