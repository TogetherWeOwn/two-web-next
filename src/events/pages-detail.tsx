// Event detail screen: hero, RSVP, share, attendees, discovery.
import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { isValidZone, renderGoingCount } from "../islands/contracts";
import type { Session } from "../env";
import { JoinResultBanner } from "../pages";
import type { JoinResult } from "../return-journey";
import { googleCalendarUrl, isWireInstant } from "./feeds";
import { attendeePageHref } from "./attendee-paths";
import type { EventAttendee, EventLink, EventNeighbors, PublicEvent, ViewerRsvp } from "./reads";
import { RsvpButton } from "./rsvp-button";
import { EventDetailShell } from "./pages-shared";

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
export interface EventAttendeesPaging {
  page: number;
  prevHref: string | null;
  nextHref: string | null;
}

export const EventPage: FC<{
  e: PublicEvent;
  neighbors: EventNeighbors;
  related: EventLink[];
  attendees?: EventAttendee[];
  /** Native attendee page window; omitted renders the legacy single page. */
  attendeesPaging?: EventAttendeesPaging;
  appUrl: string;
  jsonLd: string;
  siteJsonLd?: string;
  session?: Session | null;
  joinResult?: JoinResult | null;
  waitlistPosition?: number | null;
  member?: boolean;
  answer?: ViewerRsvp | null;
  returnTo?: string;
  /** Normalized native attendee page for the RSVP form action. */
  attendeePage?: number;
  /** Rooted .md alternate path (A2), e.g. `/e/<key>.md`. */
  markdownAlternate?: string;
}> = ({
  e,
  neighbors,
  related,
  attendees = [],
  attendeesPaging = { page: 1, prevHref: null, nextHref: null },
  appUrl,
  jsonLd,
  siteJsonLd,
  session,
  joinResult,
  waitlistPosition,
  member = false,
  answer = null,
  returnTo,
  attendeePage = 1,
  markdownAlternate,
}) => {
  const path = `/e/${e.eventKey}`;
  const canonical = canonicalUrl(appUrl, path);
  // Finite but non-wire years stay a readable page: only the Google Calendar
  // deep link (an ICS instant pair) is omitted, never the whole render.
  const gcalUrl =
    isWireInstant(e.startsAt) && isWireInstant(e.endsAt) ? googleCalendarUrl(e) : null;
  return (
    <EventDetailShell
      title={e.title}
      canonical={canonical}
      session={session}
      loginReturnTo={path}
      description={e.description || "An event at Together We Own."}
      robots={e.status === "draft" || e.status === "past" ? "noindex, nofollow" : undefined}
      markdownAlternate={markdownAlternate}
      siteJsonLd={siteJsonLd}
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
          <p class="notice" role="status" data-testid="event-cancelled">
            Cancelled
          </p>
        ) : null}
        <h1 data-waitlist-position={waitlistPosition ?? ""}>{e.title}</h1>
      </section>
      {joinResult ? <JoinResultBanner result={joinResult} /> : null}
      <dl class="event-meta" aria-label="Event details">
        <div>
          <dt>Starts</dt>
          <dd>
            <time datetime={e.startsAt.toISOString()}>
              {fmtWithOffset(e.startsAt, e.timezone)} (
              {isValidZone(e.timezone) ? e.timezone : "UTC"})
            </time>
          </dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>
            <time datetime={e.endsAt.toISOString()}>
              {fmtWithOffset(e.endsAt, e.timezone)} ({isValidZone(e.timezone) ? e.timezone : "UTC"})
            </time>
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
                  occupancy: e.goingOccupancy,
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
          signedIn={session != null}
          answer={answer}
          waitlistPosition={waitlistPosition}
          returnTo={returnTo ?? path}
          attendeePage={attendeePage}
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
            {gcalUrl ? (
              <>
                {" · "}
                <a href={gcalUrl} data-testid="event-google-calendar" rel="noopener">
                  Google Calendar
                </a>
              </>
            ) : null}
            {" · "}
            <a href={canonical} data-copy-link={canonical} data-testid="event-copy-link">
              Copy link
            </a>
          </p>
          <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
        </section>
      </div>
      {attendees.length > 0 || (member && attendeesPaging.page > 1) ? (
        <section
          aria-labelledby="event-attendees-heading"
          data-testid="event-attendees"
          data-island="attendees-live"
        >
          {attendeesPaging.prevHref || attendeesPaging.nextHref ? (
            <h2 id="event-attendees-heading">Who's going</h2>
          ) : (
            <h2 id="event-attendees-heading">Who's going ({attendees.length})</h2>
          )}
          {attendees.length > 0 ? (
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
          ) : (
            <p>There are no more attendees on this page.</p>
          )}
          {attendeesPaging.prevHref || attendeesPaging.nextHref ? (
            <nav class="event-attendees-pagination" aria-label="Attendee pages">
              {attendeesPaging.prevHref ? (
                <a href={attendeesPaging.prevHref} rel="prev" data-testid="event-attendees-prev">
                  ← Previous attendees
                </a>
              ) : null}{" "}
              <span data-testid="event-attendees-current-page" aria-current="page">
                Page {attendeesPaging.page}
              </span>{" "}
              {attendeesPaging.nextHref ? (
                <a href={attendeesPaging.nextHref} rel="next" data-testid="event-attendees-next">
                  Next attendees →
                </a>
              ) : null}
            </nav>
          ) : null}
          <p>
            Attendees shown at page load.{" "}
            <a
              href={attendeePageHref(e.eventKey, attendeesPaging.page)}
              data-testid="event-attendees-refresh"
            >
              Refresh attendees
            </a>
            .
          </p>
        </section>
      ) : null}
      <script src="/islands/copy-link.js" defer />
      <script src="/islands/going-count.js" defer />
      <script src="/islands/attendees-live.js" defer />
      <script
        type="application/ld+json"
        data-testid="event-jsonld"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
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
