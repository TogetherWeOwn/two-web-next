// Calendar event card: one list row for a persisted event or a Discord transient.
import { withScheduleContext, type ScheduleContext } from "./schedule-context";
import type { FC } from "hono/jsx";
import {
  EVENTS_EMPTY_COPY,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_HOST_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  SCHEDULE_AVAILABILITY_TESTID,
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
  rowAvailability,
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
 * responses, never attendance or places. The availability line
 * (`rowAvailability`: "N seats left", "RSVPs paused", "Ended", "No seat
 * limit", "Discord-managed") is a server-rendered snapshot from existing row
 * data — never a reservation — so members need not open a night to learn it
 * is paused or full. Screens pass their model instant as `now`; standalone
 * callers may omit it and use the render instant, never an unbounded verdict.
 */
export const CalCard: FC<{
  e: CalRow;
  schedule?: ScheduleContext | null;
  zone: string;
  now?: Date;
  isPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
}> = ({ e, schedule, zone, now = new Date(), isPast, member, inviteUrl, loginReturnTo }) => {
  const tz = rowZone(e, zone);
  const transient = isTransient(e);
  const cancelled = !transient && e.status === "cancelled";
  // The drawer context wins over row dates: a card shown under past events
  // reads Ended even if a fixture disagrees about the instant.
  const availability = rowAvailability(e, now, isPast);
  // Compact host line: the trimmed public organizer, already on the row (no
  // new read). Transients carry no organizer and blank/missing renders no
  // node, so the badge and attendance never shift for unhosted cards.
  const host = transient ? "" : (e.organizer_name ?? "").trim();
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
              <a href={withScheduleContext(`/e/${e.eventKey}`, schedule)}>{rowTitle(e)}</a>
            )}
          </h3>
          {!transient && e.game ? <p>{e.game}</p> : null}
          {host !== "" ? <p data-testid={EVENT_CARD_HOST_TESTID}>Hosted by {host}</p> : null}
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
            <span class="schedule-attendance">
              <span data-testid="event-going-count">
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
                !isPast &&
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
              </span>
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
