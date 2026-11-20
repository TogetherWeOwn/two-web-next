import type { FC } from "hono/jsx";
import { renderGoingCount, type RsvpClosedReason } from "../islands/contracts";
import { listedSignUpCountText } from "../islands/contracts-going-count";
import { kitOpenSeat } from "./kit-seat-actions";
import type { EventAttendee, ViewerRsvp } from "./reads";
import { RsvpControl } from "./rsvp-button";

export interface DetailMetadataModel {
  eventKey: string;
  status: string;
  whenText: string;
  endsWhenText: string;
  timeDatetime: string;
  endsAt: string;
  zoneLabel: string;
  durationText?: string | null;
  location: string | null;
  directionsUrl: string | null;
  organizerName: string | null;
  series?: { hosts: string[] } | null;
  goingCount: number;
  goingOccupancy: number;
  capacity: number | null;
}

export interface DetailRosterModel {
  attendees: EventAttendee[];
  attendeesPaging: { page: number; prevHref: string | null; nextHref: string | null };
  viewerMember: boolean;
  showJoinPitch: boolean;
  joinReturnTo: string;
  attendeesRefreshHref: string;
  goingCount: number;
}

export interface DetailShareModel {
  status: string;
  title: string;
  canonical: string;
  icsUrl: string;
  googleCalendarUrl: string | null;
}

export interface DetailLeavesModel
  extends DetailMetadataModel,
    DetailRosterModel,
    DetailShareModel {
  isOngoing?: boolean;
  isEnded?: boolean;
  rsvpOpen: boolean;
  rsvpClosed: RsvpClosedReason | null;
  answer: ViewerRsvp | null;
  waitlistPosition: number | null;
  viewerModerator: boolean;
  review?: { rsvp: string };
}

export interface EventDetailHtml {
  metadata: string;
  rsvp: string;
  roster: string;
  share: string;
}

export const EventShare: FC<{ model: DetailShareModel; ended?: boolean }> = ({
  model,
  ended = false,
}) => (
  <section class="event-share" aria-labelledby="event-share-heading">
    <h2 id="event-share-heading">{ended ? "Share this event" : "Save the date"}</h2>
    {model.status === "draft" ? (
      <p data-testid="event-share-draft-note">
        Calendar and share links open once this event is published. Members can&apos;t open a draft
        yet.
      </p>
    ) : (
      <>
        <p>
          {!ended ? (
            <>
              <a href={model.icsUrl} data-testid="event-ics">
                Add to calendar (.ics)
              </a>
              {model.googleCalendarUrl ? (
                <>
                  {" · "}
                  <a
                    href={model.googleCalendarUrl}
                    data-testid="event-google-calendar"
                    rel="noopener"
                  >
                    Google Calendar
                  </a>
                </>
              ) : null}
            </>
          ) : null}
          {model.status === "published" ? (
            <>
              {!ended ? (
                <span hidden data-native-share-sep aria-hidden="true">
                  {" · "}
                </span>
              ) : null}
              <button
                type="button"
                hidden
                data-native-share
                data-share-title={model.title}
                data-share-url={model.canonical}
                data-testid="event-share"
              >
                Share
              </button>
            </>
          ) : null}
        </p>
        <div>
          <label for="event-link-url">Event link</label>
          <input
            id="event-link-url"
            data-testid="event-link-url"
            type="text"
            value={model.canonical}
            readonly
          />
          <a
            href={model.canonical}
            data-copy-link={model.canonical}
            data-testid="event-copy-link"
            hidden
          >
            Copy link
          </a>
        </div>
        <p data-testid="event-manual-copy">
          Select the event link and copy it manually to share it.
        </p>
        <p role="status" aria-live="polite" data-testid="event-copy-toast" data-copy-toast></p>
        {model.status === "published" ? (
          <p
            role="status"
            aria-live="polite"
            data-testid="event-share-status"
            data-native-share-status
          ></p>
        ) : null}
      </>
    )}
  </section>
);

export const EventMetadata: FC<{
  model: DetailMetadataModel;
  showTimeFromNow: boolean;
  showSpotsLeft: boolean;
  retainEmptyInstants?: boolean;
  refreshSeat?: boolean;
  ended?: boolean;
  /** Kit-only: the C6 facts list owns the host row (and its event-organizer
   * hook), so the metadata list skips it. Hono never sets this. */
  omitHost?: boolean;
}> = ({
  model,
  showTimeFromNow,
  showSpotsLeft,
  retainEmptyInstants = false,
  refreshSeat = false,
  ended = false,
  omitHost = false,
}) => (
  <dl class="event-meta" aria-label="Event details">
    <div>
      <dt>Starts</dt>
      <dd>
        <time datetime={model.timeDatetime || undefined}>
          {model.whenText} ({model.zoneLabel})
        </time>
      </dd>
      <dd class="event-device-timezone" data-event-device-timezone>
        <button type="button" hidden data-testid="event-device-timezone-starts-button">
          Show in my device timezone
        </button>
        <p role="status" aria-live="polite" data-testid="event-device-timezone-starts-status"></p>
      </dd>
    </div>
    <div>
      <dt>Ends</dt>
      <dd>
        <time datetime={model.endsAt || undefined}>
          {model.endsWhenText} ({model.zoneLabel})
        </time>
      </dd>
      <dd class="event-device-timezone" data-event-device-timezone>
        <button type="button" hidden data-testid="event-device-timezone-ends-button">
          Show in my device timezone
        </button>
        <p role="status" aria-live="polite" data-testid="event-device-timezone-ends-status"></p>
      </dd>
    </div>
    {showTimeFromNow ? (
      <div hidden>
        <dt>Time from now</dt>
        <dd
          class="event-device-timezone"
          data-event-time-from-now
          data-starts-at={
            retainEmptyInstants ? model.timeDatetime : model.timeDatetime || undefined
          }
          data-ends-at={retainEmptyInstants ? model.endsAt : model.endsAt || undefined}
        >
          <button type="button" hidden data-testid="event-time-from-now-button">
            Show time from now
          </button>
          <p role="status" aria-live="polite" data-testid="event-time-from-now-status"></p>
        </dd>
      </div>
    ) : null}
    {model.durationText ? (
      <div>
        <dt>Duration</dt>
        <dd>{model.durationText}</dd>
      </div>
    ) : null}
    <div>
      <dt>Where</dt>
      <dd>
        {model.location ? (
          <>
            <p data-testid="event-venue">{model.location}</p>
            {model.directionsUrl ? (
              <p>
                <a href={model.directionsUrl} data-testid="event-directions" rel="noopener">
                  Get directions
                </a>
              </p>
            ) : null}
          </>
        ) : (
          <p data-testid="event-venue-tbd">
            Venue TBD — check <a href="/discord">Discord</a> for updates.
          </p>
        )}
      </dd>
    </div>
    {model.organizerName && !omitHost ? (
      <div>
        <dt>Hosted by</dt>
        <dd>
          <p data-testid="event-organizer">{model.organizerName}</p>
        </dd>
      </div>
    ) : null}
    {model.series && model.series.hosts.length > 0 ? (
      <div>
        <dt>Series hosts</dt>
        <dd>
          <p data-testid="event-series-hosts">{model.series.hosts.join(", ")}</p>
        </dd>
      </div>
    ) : null}
    <div data-event-lineup={refreshSeat ? "" : undefined}>
      <dt>{ended ? "Sign-ups" : "The lineup"}</dt>
      <dd>
        <p
          dangerouslySetInnerHTML={{
            __html: renderGoingCount(model.eventKey, {
              going: model.goingCount,
              occupancy: model.goingOccupancy,
              capacity: model.capacity,
              showSpotsLeft,
              refreshSeat,
              signedUp: ended,
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
);

export const EventRoster: FC<{ model: DetailRosterModel; ended?: boolean }> = ({
  model,
  ended = false,
}) =>
  model.attendees.length > 0 || (model.viewerMember && model.attendeesPaging.page > 1) ? (
    <section
      aria-labelledby="event-attendees-heading"
      data-testid="event-attendees"
      data-island={ended ? undefined : "attendees-live"}
    >
      {model.attendeesPaging.prevHref || model.attendeesPaging.nextHref ? (
        <h2 id="event-attendees-heading">{ended ? "Signed up" : "Who's going"}</h2>
      ) : (
        <h2 id="event-attendees-heading">
          {ended ? "Signed up" : "Who's going"} ({model.attendees.length})
        </h2>
      )}
      {model.attendees.length > 0 ? (
        <ul class="event-attendee-grid">
          {model.attendees.map((attendee) => (
            <li>
              <span class="event-attendee-mark" aria-hidden="true">
                {Array.from(attendee.name)[0]}
              </span>
              <a href={`/members/${encodeURIComponent(attendee.id)}`}>{attendee.name}</a>
            </li>
          ))}
        </ul>
      ) : (
        <p>
          {ended
            ? "There are no more sign-ups on this page."
            : "There are no more attendees on this page."}
        </p>
      )}
      {model.attendeesPaging.prevHref || model.attendeesPaging.nextHref ? (
        <nav
          class="event-attendees-pagination"
          aria-label={ended ? "Sign-up pages" : "Attendee pages"}
        >
          {model.attendeesPaging.prevHref ? (
            <a href={model.attendeesPaging.prevHref} rel="prev" data-testid="event-attendees-prev">
              ← Previous {ended ? "sign-ups" : "attendees"}
            </a>
          ) : null}{" "}
          <span data-testid="event-attendees-current-page" aria-current="page">
            Page {model.attendeesPaging.page}
          </span>{" "}
          {model.attendeesPaging.nextHref ? (
            <a href={model.attendeesPaging.nextHref} rel="next" data-testid="event-attendees-next">
              Next {ended ? "sign-ups" : "attendees"} →
            </a>
          ) : null}
        </nav>
      ) : null}
      <p>
        {ended ? "Sign-ups shown at page load." : "Attendees shown at page load."}{" "}
        <a href={model.attendeesRefreshHref} data-testid="event-attendees-refresh">
          Refresh {ended ? "sign-ups" : "attendees"}
        </a>
        .
      </p>
    </section>
  ) : (
    <section
      aria-labelledby="event-roster-heading"
      data-testid={
        model.viewerMember
          ? "event-roster-empty"
          : model.showJoinPitch
            ? "event-roster-guest-nudge"
            : "event-roster-members-only"
      }
    >
      <h2 id="event-roster-heading">
        {ended ? "Signed up" : "Who's going"}
        {model.viewerMember ? " (0)" : ""}
      </h2>
      <p>
        {model.viewerMember ? (
          ended ? (
            "No sign-ups are listed."
          ) : (
            "No one is listed as going yet."
          )
        ) : model.showJoinPitch ? (
          <>
            {model.goingCount > 0
              ? `${ended ? listedSignUpCountText(model.goingCount) : `${model.goingCount} going`} —`
              : ended
                ? "No sign-ups are listed."
                : "No one is listed as going yet."}{" "}
            <a href={`/join/discord?next=${encodeURIComponent(model.joinReturnTo)}`}>
              sign in to {ended ? "see who signed up" : "see who's in"}
            </a>
            .
          </>
        ) : (
          <>
            Members only —{" "}
            <a href={`/join?next=${encodeURIComponent(model.joinReturnTo)}`}>join the Discord</a> to
            {ended ? "see who signed up" : "see who's in"}.
          </>
        )}
      </p>
    </section>
  );

/** Server-only projection. Rebuild after fixture overrides, just as the resolver does. */
export function withEventDetailHtml<T extends DetailLeavesModel>(
  model: T,
): T & { detailHtml: EventDetailHtml } {
  const review = model.viewerModerator ? model.review : undefined;
  const ended = model.isEnded ?? false;
  return {
    ...model,
    detailHtml: {
      // Kit has always kept this hidden row for cancelled review; Hono has not.
      metadata: (
        <EventMetadata
          model={model}
          showTimeFromNow={model.status !== "draft" && !model.isOngoing}
          retainEmptyInstants
          ended={ended}
          omitHost={Boolean(model.organizerName?.trim())}
          refreshSeat={kitOpenSeat(model) !== null}
          showSpotsLeft={
            model.status !== "past" && model.status !== "cancelled" && model.rsvpClosed !== "past"
          }
        />
      ).toString(),
      rsvp: review
        ? review.rsvp
        : (
            <RsvpControl
              e={model}
              closed={model.rsvpClosed}
              member={model.viewerMember}
              answer={model.answer}
              waitlistPosition={model.waitlistPosition}
              returnTo={model.joinReturnTo}
              attendeePage={model.attendeesPaging.page}
            />
          ).toString(),
      roster: (<EventRoster model={model} ended={ended} />).toString(),
      share: (<EventShare model={model} ended={ended} />).toString(),
    },
  };
}
