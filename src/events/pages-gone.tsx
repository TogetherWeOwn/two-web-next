// Gone (cancelled) event screen: notice plus the way back to upcoming.
import type { FC } from "hono/jsx";
import type { PublicEvent } from "./reads";
import { EventDetailShell } from "./pages-shared";

/** The notice is the only visible cancellation copy; a closed RSVP control would repeat it. */
export const EventGonePage: FC<{ e: PublicEvent; jsonLd: string }> = ({ e, jsonLd }) => (
  <EventDetailShell title={e.title} robots="noindex, nofollow" account={false}>
    <section class="event-hero event-gone" aria-label="Cancelled event">
      <p class="event-kicker">{e.game || "Community event"}</p>
      <p class="notice" data-testid="event-cancelled">
        Cancelled
      </p>
      <h1>{e.title}</h1>
      <p>
        <a class="btn" href="/events">
          See upcoming events
        </a>
      </p>
    </section>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
  </EventDetailShell>
);
