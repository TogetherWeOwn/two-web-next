import { fmt } from "../events/pages";
import { escapeHtml } from "../html-escape";
import type { UpcomingGameNight } from "./upcoming";

/** Static SSR markup for the csr=false Kit profile routes. Escape every stored
 * value, including attributes, before the view admits this through {@html}.
 * Keep the Hono UpcomingGameNightsBlock's markup/copy contract. */
export function profileUpcomingMarkup(upcoming: UpcomingGameNight[]): string {
  const content = upcoming.length
    ? `<ol class="profile-upcoming-list">${upcoming
        .map(
          (night) =>
            `<li data-testid="profile-upcoming-item"><a href="/e/${escapeHtml(night.eventKey)}">${escapeHtml(night.title)}</a> <time datetime="${escapeHtml(night.startsAt.toISOString())}">${escapeHtml(fmt(night.startsAt, night.timezone))}</time> <p>${escapeHtml(night.location ?? "Venue to be announced")}</p> ${
              night.status === "waitlisted"
                ? `<p data-testid="profile-upcoming-position">Waitlist position ${escapeHtml(String(night.waitlistPosition))}</p>`
                : ""
            }</li>`,
        )
        .join("")}</ol>`
    : '<p data-testid="profile-upcoming-empty">Nothing booked yet. <a href="/events">Browse the schedule</a> to find your next game night.</p>';
  return `<section class="profile-panel" aria-labelledby="upcoming-heading" data-testid="profile-upcoming"><h2 id="upcoming-heading">Your upcoming game nights</h2> ${content}</section>`;
}
