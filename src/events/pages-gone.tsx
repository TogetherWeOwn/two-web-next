// Gone (cancelled) event screen: notice, upcoming same-game alternatives and
// the per-event calendar download, plus the way back to upcoming. Mirrors the
// Kit gone block (web/src/lib/EventGone.svelte): same testids, same order,
// same formatter, no RSVP/join surface anywhere.
import type { FC } from "hono/jsx";
import { EXISTING_RESPONSES_TESTID, existingResponsesText } from "../islands/contracts";
import type { EventLink, PublicEvent } from "./reads";
import { EventDetailShell, fmt } from "./pages-shared";

/** The notice is the only visible cancellation copy; a closed RSVP control would repeat it. */
export const EventGonePage: FC<{
  e: PublicEvent;
  jsonLd: string;
  siteJsonLd?: string;
  /** Upcoming same-game siblings; empty (or omitted) renders no list, never an empty one. */
  related?: EventLink[];
}> = ({ e, jsonLd, siteJsonLd, related = [] }) => (
  <EventDetailShell
    title={e.title}
    robots="noindex, nofollow"
    account={false}
    markdownAlternate={`/e/${e.eventKey}.md`}
    siteJsonLd={siteJsonLd}
  >
    <section class="event-hero event-gone" aria-label="Cancelled event">
      <p class="event-kicker">{e.game || "Community event"}</p>
      <p class="notice" role="status" data-testid="event-cancelled">
        Cancelled
      </p>
      <h1>{e.title}</h1>
      {/* Retained answers as history, never attendance: the cancelled
          schedule card's line (existingResponsesText), with no capacity and
          no island mount — a closed event takes no RSVPs, so there is
          nothing to refresh. */}
      <p data-testid={EXISTING_RESPONSES_TESTID}>{existingResponsesText(e.goingCount)}</p>
      {related.length > 0 ? (
        <ul class="facts" data-testid="event-cancelled-alternatives">
          {related.map((alternative) => (
            <li class="card">
              <a href={`/e/${alternative.eventKey}`}>{alternative.title}</a>
              <p>
                <time>{fmt(alternative.startsAt, alternative.timezone)}</time>
                {alternative.location ? ` · ${alternative.location}` : null}
              </p>
            </li>
          ))}
        </ul>
      ) : null}
      <p>
        <a class="btn" href="/events">
          See upcoming events
        </a>
      </p>
      <p>
        <a href={`/events/${e.eventKey}.ics`} data-testid="event-cancelled-ics">
          Download calendar entry (.ics)
        </a>
      </p>
    </section>
    <script
      type="application/ld+json"
      data-testid="event-jsonld"
      dangerouslySetInnerHTML={{ __html: jsonLd }}
    />
  </EventDetailShell>
);
