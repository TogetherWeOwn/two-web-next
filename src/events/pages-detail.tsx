// Event detail screen: hero, RSVP, share, attendees, discovery.
import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import { isValidZone, renderGoingCount } from "../islands/contracts";
import type { Session } from "../env";
import { JoinResultBanner } from "../pages";
import type { JoinResult } from "../return-journey";
import { directionsUrl, googleCalendarUrl, isWireInstant } from "./feeds";
import { archiveEventHref, type ArchiveContext } from "./attendee-paths";
import { archiveReturnLink } from "./archive-links";
import { eventLinkAvailability } from "./link-availability";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  EventSeriesContext,
  PublicEvent,
  ViewerRsvp,
} from "./reads";
import { RsvpButton } from "./rsvp-button";
import { EventDetailShell } from "./pages-shared";

import { formatElapsedDuration, formatEventWhen as fmtWithOffset } from "./date-format";

const DestinationPreview: FC<{ event: EventLink; now: Date }> = ({ event, now }) => {
  const availability = eventLinkAvailability(event, now);
  return (
    <>
      {Number.isFinite(event.startsAt.getTime()) ? (
        <>
          {" "}
          <time datetime={event.startsAt.toISOString()}>
            {fmtWithOffset(event.startsAt, event.timezone)}
          </time>
        </>
      ) : null}
      {event.location ? (
        <>
          {" "}
          <span class="event-related-location">{event.location}</span>
        </>
      ) : null}
      {event.game ? (
        <>
          {" "}
          <span class="event-related-game">{event.game}</span>
        </>
      ) : null}
      {availability ? (
        <>
          {" "}
          <span class="event-related-state">{availability}</span>
        </>
      ) : null}
    </>
  );
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
  /** Series run context; null (or omitted) for standalone events, which render exactly as today. */
  series?: EventSeriesContext | null;
  attendees?: EventAttendee[];
  /** Native attendee page window; omitted renders the legacy single page. */
  attendeesPaging?: EventAttendeesPaging;
  archive?: ArchiveContext | null;
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
  series = null,
  attendees = [],
  attendeesPaging = { page: 1, prevHref: null, nextHref: null },
  archive,
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
  const accessibilityNotes = e.accessibilityNotes?.trim();
  const duration = formatElapsedDuration(e.endsAt.getTime() - e.startsAt.getTime());
  const now = new Date();
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
      backLink={archiveReturnLink(archive)}
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
          <dd class="event-device-timezone" data-event-device-timezone>
            <button type="button" hidden data-testid="event-device-timezone-starts-button">
              Show in my device timezone
            </button>
            <p
              role="status"
              aria-live="polite"
              data-testid="event-device-timezone-starts-status"
            ></p>
          </dd>
        </div>
        <div>
          <dt>Ends</dt>
          <dd>
            <time datetime={e.endsAt.toISOString()}>
              {fmtWithOffset(e.endsAt, e.timezone)} ({isValidZone(e.timezone) ? e.timezone : "UTC"})
            </time>
          </dd>
          <dd class="event-device-timezone" data-event-device-timezone>
            <button type="button" hidden data-testid="event-device-timezone-ends-button">
              Show in my device timezone
            </button>
            <p role="status" aria-live="polite" data-testid="event-device-timezone-ends-status"></p>
          </dd>
        </div>
        {duration ? (
          <div>
            <dt>Duration</dt>
            <dd>{duration}</dd>
          </div>
        ) : null}
        {e.location ? (
          <div>
            <dt>Where</dt>
            <dd>
              <p data-testid="event-venue">{e.location}</p>
              <p>
                <a href={directionsUrl(e.location)} data-testid="event-directions" rel="noopener">
                  Get directions
                </a>
              </p>
            </dd>
          </div>
        ) : null}
        {e.organizer_name ? (
          <div>
            <dt>Hosted by</dt>
            <dd>
              <p data-testid="event-organizer">{e.organizer_name}</p>
            </dd>
          </div>
        ) : null}
        {series && series.hosts.length > 0 ? (
          <div>
            <dt>Series hosts</dt>
            <dd>
              <p data-testid="event-series-hosts">{series.hosts.join(", ")}</p>
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
                  // Reconciliation can lag: published rows stop inviting at
                  // their end, using the same server instant as RSVP below.
                  // Draft previews retain the line. The binder patches existing
                  // spots nodes only, so refresh cannot recreate it after close.
                  showSpotsLeft:
                    e.status === "draft" || (e.status === "published" && e.endsAt > now),
                  announcement: null,
                }),
              }}
            />
          </dd>
        </div>
        <div hidden>
          <dt>Compare in another timezone</dt>
          <dd class="event-device-timezone" data-event-chosen-timezone>
            <label for="chosen-timezone-input">Timezone (IANA identifier)</label>
            <input
              type="text"
              id="chosen-timezone-input"
              data-testid="event-chosen-timezone-input"
              maxlength={64}
              hidden
              autocomplete="off"
              spellcheck={false}
            />
            <p data-testid="event-chosen-timezone-examples">e.g. Europe/London, Asia/Tokyo</p>
            <button type="button" hidden data-testid="event-chosen-timezone-button">
              Compare times
            </button>
            <p role="status" aria-live="polite" data-testid="event-chosen-timezone-status"></p>
          </dd>
        </div>
      </dl>
      <div class="event-rsvp">
        <RsvpButton
          e={e}
          now={now}
          member={member}
          signedIn={session != null}
          answer={answer}
          waitlistPosition={waitlistPosition}
          returnTo={returnTo ?? path}
          attendeePage={attendeePage}
        />
        <script src="/islands/rsvp-button.js" defer />
        <script src="/islands/event-device-timezone.js" defer />
      </div>
      <div class="event-detail-grid">
        <div>
          {e.description ? (
            <section class="event-description" aria-labelledby="event-description-heading">
              <h2 id="event-description-heading">About this event</h2>
              <p>{e.description}</p>
            </section>
          ) : null}
          {accessibilityNotes ? (
            <section
              class="event-description"
              data-testid="event-accessibility"
              aria-labelledby="event-accessibility-heading"
            >
              <h2 id="event-accessibility-heading">Accessibility</h2>
              <p>{accessibilityNotes}</p>
            </section>
          ) : null}
          {(e.status === "published" || e.status === "draft") &&
          (e.join_url || e.join_instructions) ? (
            <section
              class="event-description event-join-details"
              aria-labelledby="event-join-details-heading"
              data-testid="event-join-details"
            >
              <h2 id="event-join-details-heading">How to join</h2>
              {e.join_url ? (
                e.status === "published" ? (
                  <p>
                    <a href={e.join_url} data-testid="event-public-join-link">
                      Open the public joining link
                    </a>
                  </p>
                ) : (
                  <p>Public joining link: {e.join_url}</p>
                )
              ) : null}
              {e.join_instructions ? (
                <p data-testid="event-join-instructions">{e.join_instructions}</p>
              ) : null}
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
            {e.status === "published" ? (
              <>
                <span hidden data-native-share-sep aria-hidden="true">
                  {" · "}
                </span>
                <button
                  type="button"
                  hidden
                  data-native-share
                  data-share-title={e.title}
                  data-share-url={canonical}
                  data-testid="event-share"
                >
                  Share
                </button>
              </>
            ) : null}
          </p>
          <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
          {e.status === "published" ? (
            <p
              role="status"
              aria-live="polite"
              data-testid="event-share-status"
              data-native-share-status
            ></p>
          ) : null}
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
              href={archiveEventHref(e.eventKey, archive, attendeesPaging.page)}
              data-testid="event-attendees-refresh"
            >
              Refresh attendees
            </a>
            .
          </p>
        </section>
      ) : null}
      <script src="/islands/copy-link.js" defer />
      <script src="/islands/event-share.js" defer />
      <script src="/islands/going-count.js" defer />
      <script src="/islands/attendees-live.js" defer />
      <script
        type="application/ld+json"
        data-testid="event-jsonld"
        dangerouslySetInnerHTML={{ __html: jsonLd }}
      />
      <div class="event-discovery">
        {series && (series.previous || series.next) ? (
          <nav class="event-pagination" aria-label="Series events" data-testid="event-series-nav">
            {series.previous ? (
              <a
                href={`/e/${series.previous.eventKey}`}
                rel="prev"
                data-testid="event-series-previous"
              >
                <span>← Previous in series: {series.previous.title}</span>
                <DestinationPreview event={series.previous} now={now} />
              </a>
            ) : null}{" "}
            {series.next ? (
              <a href={`/e/${series.next.eventKey}`} rel="next" data-testid="event-series-next">
                <span>Next in series: {series.next.title} →</span>
                <DestinationPreview event={series.next} now={now} />
              </a>
            ) : null}
          </nav>
        ) : null}
        {neighbors.previous || neighbors.next ? (
          <nav class="event-pagination" aria-label="More events" data-testid="event-pagination">
            {neighbors.previous ? (
              <a href={`/e/${neighbors.previous.eventKey}`} rel="prev" data-testid="event-previous">
                <span>← Previous event: {neighbors.previous.title}</span>
                <DestinationPreview event={neighbors.previous} now={now} />
              </a>
            ) : null}{" "}
            {neighbors.next ? (
              <a href={`/e/${neighbors.next.eventKey}`} rel="next" data-testid="event-next">
                <span>Next event: {neighbors.next.title} →</span>
                <DestinationPreview event={neighbors.next} now={now} />
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
                    {event.title}
                    <DestinationPreview event={event} now={now} />
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
