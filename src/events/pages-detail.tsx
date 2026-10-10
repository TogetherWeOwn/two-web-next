// Event detail screen: hero, RSVP, share, attendees, discovery.
import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { renderGoingCount } from "../islands/contracts";
import type { Session } from "../env";
import { JoinResultBanner } from "../pages";
import type { JoinResult } from "../return-journey";
import { googleCalendarUrl } from "./feeds";
import type { EventAttendee, EventLink, EventNeighbors, PublicEvent, ViewerRsvp } from "./reads";
import { RsvpButton } from "./rsvp-button";
import { EventDetailShell, fmt } from "./pages-shared";

const fmtWithOffset = (d: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: tz,
      timeZoneName: "longOffset",
    }).format(d);
  } catch {
    return d.toISOString();
  }
};

// Legacy show.blade.php pitch (data-testid="event-join-pitch"): guests only —
// the blade wraps it in @guest, so any signed-in viewer (member or
// non-member) never sees it. The pitch carries this page as ?next= so the
// journey lands the guest back here after joining. The one-shot join
// confirmation still renders for the newly authenticated member.
export const EventPage: FC<{
  e: PublicEvent;
  neighbors: EventNeighbors;
  related: EventLink[];
  attendees?: EventAttendee[];
  appUrl: string;
  jsonLd: string;
  session?: Session | null;
  joinResult?: JoinResult | null;
  waitlistPosition?: number | null;
  member?: boolean;
  answer?: ViewerRsvp | null;
  returnTo?: string;
}> = ({
  e,
  neighbors,
  related,
  attendees = [],
  appUrl,
  jsonLd,
  session,
  joinResult,
  waitlistPosition,
  member = false,
  answer = null,
  returnTo,
}) => {
  const path = `/e/${e.eventKey}`;
  const canonical = canonicalUrl(appUrl, path);
  return (
    <EventDetailShell
      title={e.title}
      canonical={canonical}
      session={session}
      loginReturnTo={path}
      description={e.description || "An event at Together We Own."}
      robots={e.status === "draft" || e.status === "past" ? "noindex, nofollow" : undefined}
    >
      <section class="event-hero" aria-label="Event overview">
        <p class="event-kicker">{e.game || "Community event"}</p>
        {e.status === "draft" ? (
          <p class="notice" data-testid="event-draft">
            Draft
          </p>
        ) : null}
        {e.status === "past" ? (
          <p class="notice" data-testid="event-past">
            Past event
          </p>
        ) : null}
        {e.status === "cancelled" ? (
          <p class="notice" data-testid="event-cancelled">
            Cancelled
          </p>
        ) : null}
        <h1 data-waitlist-position={waitlistPosition ?? ""}>{e.title}</h1>
      </section>
      {joinResult ? <JoinResultBanner result={joinResult} /> : null}
      <dl class="event-meta" aria-label="Event details">
        <div>
          <dt>When</dt>
          <dd>
            <time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>
          </dd>
        </div>
        {e.location ? (
          <div>
            <dt>Where</dt>
            <dd>
              <p data-testid="event-venue">{e.location}</p>
            </dd>
          </div>
        ) : null}
        <div>
          <dt>The lineup</dt>
          <dd>
            <p
              dangerouslySetInnerHTML={{
                __html: renderGoingCount(e.eventKey, {
                  going: e.goingCount,
                  capacity: e.capacity,
                  showSpotsLeft: true,
                  announcement: null,
                }),
              }}
            />
          </dd>
        </div>
      </dl>
      <div class="event-rsvp">
        <RsvpButton
          e={e}
          member={member}
          answer={answer}
          waitlistPosition={waitlistPosition}
          returnTo={returnTo ?? path}
        />
        <script src="/islands/rsvp-button.js" defer />
      </div>
      <div class="event-detail-grid">
        <div>
          {e.description ? (
            <section class="event-description" aria-labelledby="event-description-heading">
              <h2 id="event-description-heading">About this event</h2>
              <p>{e.description}</p>
            </section>
          ) : null}
          {!session ? (
            <section
              class="event-pitch"
              data-testid="event-join-pitch"
              aria-label="Join the community"
            >
              <p>
                Game nights get posted here first. Join the Discord and you&apos;ll see them before
                they land on this page.
              </p>
              <p>
                <a
                  class="btn"
                  href={`/join?next=${encodeURIComponent(path)}`}
                  data-testid="discord-join"
                >
                  Join the Discord
                </a>
              </p>
            </section>
          ) : null}
        </div>
        <section class="event-share" aria-labelledby="event-share-heading">
          <h2 id="event-share-heading">Save the date</h2>
          <p>
            <a href={`/events/${e.eventKey}.ics`} data-testid="event-ics">
              Add to calendar (.ics)
            </a>
            {" · "}
            <a href={googleCalendarUrl(e)} data-testid="event-google-calendar" rel="noopener">
              Google Calendar
            </a>
            {" · "}
            <a href={canonical} data-copy-link={canonical} data-testid="event-copy-link">
              Copy link
            </a>
          </p>
          <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
        </section>
      </div>
      {attendees.length > 0 ? (
        <section aria-labelledby="event-attendees-heading" data-testid="event-attendees">
          <h2 id="event-attendees-heading">Who's going ({attendees.length})</h2>
          <ul class="event-attendee-grid">
            {attendees.map((attendee) => (
              <li>
                <span class="event-attendee-mark" aria-hidden="true">
                  {Array.from(attendee.name)[0]}
                </span>
                <a href={`/members/${encodeURIComponent(attendee.id)}`}>{attendee.name}</a>
              </li>
            ))}
          </ul>
          <p>
            Attendees shown at page load.{" "}
            <a href={path} data-testid="event-attendees-refresh">
              Refresh attendees
            </a>
            .
          </p>
        </section>
      ) : null}
      <script src="/islands/copy-link.js" defer />
      <script src="/islands/going-count.js" defer />
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
      <div class="event-discovery">
        {neighbors.previous || neighbors.next ? (
          <nav class="event-pagination" aria-label="More events" data-testid="event-pagination">
            {neighbors.previous ? (
              <a href={`/e/${neighbors.previous.eventKey}`} rel="prev" data-testid="event-previous">
                ← Previous event: {neighbors.previous.title}
              </a>
            ) : null}{" "}
            {neighbors.next ? (
              <a href={`/e/${neighbors.next.eventKey}`} rel="next" data-testid="event-next">
                Next event: {neighbors.next.title} →
              </a>
            ) : null}
          </nav>
        ) : null}
        {related.length > 0 ? (
          <section aria-label="Related events" data-testid="event-related">
            <h2>More events you might like</h2>
            <ul class="event-related-grid">
              {related.map((event) => (
                <li>
                  <a href={`/e/${event.eventKey}`} data-testid="event-related-link">
                    {event.title}{" "}
                    <time datetime={event.startsAt.toISOString()}>
                      {fmtWithOffset(event.startsAt, event.timezone)}
                    </time>
                    {event.location ? (
                      <>
                        {" "}
                        <span class="event-related-location">{event.location}</span>
                      </>
                    ) : null}
                  </a>
                </li>
              ))}
            </ul>
            {!session ? (
              <>
                <p>
                  These fill up fast for members. Join the Discord and you&apos;ll hear about the
                  next one before it lands here.
                </p>
                <a
                  class="btn"
                  href={`/join?next=${encodeURIComponent(path)}`}
                  data-testid="event-related-join"
                >
                  Join the Discord
                </a>
              </>
            ) : null}
          </section>
        ) : null}
      </div>
    </EventDetailShell>
  );
};
