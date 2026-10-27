/** The one availability verdict a discovery preview may advertise, from the
 * destination row alone (no RSVP aggregates): the calendar row's wording and
 * precedence (`pages-calendar-row.ts`) — ended beats paused. An unrenderable
 * end instant is never "ended"; its preview stays unmarked rather than guess.
 * This module imports nothing, so renderers that bundle alongside the static
 * leaves never pull the database layer in through it. */
export function eventLinkAvailability(
  link: { endsAt: Date; rsvpOpen: boolean },
  now: Date,
): "Ended" | "RSVPs paused" | null {
  if (Number.isFinite(link.endsAt.getTime()) && link.endsAt.getTime() <= now.getTime()) {
    return "Ended";
  }
  if (!link.rsvpOpen) return "RSVPs paused";
  return null;
}
