// Past events archive screen: paginated list of what already happened.
import type { FC } from "hono/jsx";
import { canonicalUrl } from "../seo";
import {
  EVENTS_EMPTY_COPY,
  EVENTS_SUBSCRIBE_TESTID,
  PAST_EVENTS_BACK_TESTID,
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_PAGER_NEWER_TESTID,
  PAST_EVENTS_PAGER_OLDER_TESTID,
  PAST_EVENTS_PAGER_TESTID,
  PAST_EVENTS_SEARCH_MISS_TESTID,
  PAST_EVENTS_TESTID,
  goingCountText,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../islands/contracts";
import { archiveEventHref, type ArchiveContext } from "./attendee-paths";
import { feedUrl, rssUrl, webcalUrl } from "./feeds";
import { subscriptionHelp } from "./subscription-help";
import type { PublicEvent } from "./reads";
import { fmt, ScheduleDate, ScheduleShell } from "./pages-shared";

const Card: FC<{ e: PublicEvent; archive: ArchiveContext }> = ({ e, archive }) => (
  <li class="schedule-row" data-testid="event-card" data-event-key={e.eventKey}>
    <ScheduleDate date={e.startsAt} zone={e.timezone} />
    <div class="schedule-info">
      <h2>
        <a href={archiveEventHref(e.eventKey, archive)}>{e.title}</a>
      </h2>
      {/* Upcoming-card shape (time · zone · location): the zone always
          renders, the location only when the row has one. */}
      <p>
        <time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>{" "}
        <span>{e.timezone}</span>
        {e.location ? (
          <>
            {" · "}
            <span>{e.location}</span>
          </>
        ) : null}
      </p>
      {e.game ? <p>{e.game}</p> : null}
    </div>
    <span class="schedule-attendance">{goingCountText(e.goingCount, e.capacity)}</span>
  </li>
);

export const PastEventsPage: FC<{
  rows: PublicEvent[];
  page: number;
  hasMore: boolean;
  totalPages: number;
  appUrl: string;
  q?: string;
}> = ({ rows, page, hasMore, totalPages, appUrl, q = "" }) => (
  <ScheduleShell
    title="Past events"
    canonical={canonicalUrl(appUrl, pastEventsUrl(page, q))}
    description="Look back at the community’s game nights and tournaments."
    robots="noindex, follow"
    loginReturnTo={pastEventsUrl(page, q)}
  >
    <section
      data-island={PAST_EVENTS_ISLAND}
      data-testid={PAST_EVENTS_TESTID}
      data-page={page}
      data-total-pages={totalPages}
      data-query={q}
      data-load-error={PAST_EVENTS_COPY.failed}
      aria-labelledby="past-events-heading"
    >
      <div class="schedule-heading">
        <p class="strap">The archive</p>{" "}
        <h1 id="past-events-heading" tabindex={-1}>
          Past events
        </h1>{" "}
        <p>
          Game nights we’ve shared. Find the next one in the <a href="/events">upcoming schedule</a>
          .
        </p>
      </div>
      {/* Feed links live outside the binder's swapped zones (state/list/pager)
          so fragment turns never swallow them; same helpers as the calendar. */}
      <p>
        <a href={webcalUrl(appUrl)} data-testid={EVENTS_SUBSCRIBE_TESTID}>
          {EVENTS_EMPTY_COPY.subscribe}
        </a>{" "}
        <a href={rssUrl(appUrl)}>RSS feed</a> <a href={feedUrl(appUrl)}>Download calendar (.ics)</a>
      </p>
      {subscriptionHelp(appUrl)}
      <div data-archive-state>
        {q ? (
          <p role="status">
            Past events matching “{q}”. <a href="/events/past">Clear search</a>
          </p>
        ) : null}
        {rows.length === 0 ? (
          totalPages === 0 && q ? (
            <p role="status" data-testid={PAST_EVENTS_SEARCH_MISS_TESTID}>
              No past events match “{q}”. <a href="/events/past">Clear search</a>
            </p>
          ) : totalPages === 0 ? (
            <div data-testid={PAST_EVENTS_EMPTY_TESTID}>
              <p>{PAST_EVENTS_COPY.empty}</p>
              <p>
                <a href="/join">{PAST_EVENTS_COPY.join}</a>
              </p>
            </div>
          ) : (
            <p role="status" data-testid={PAST_EVENTS_OUT_OF_RANGE_TESTID}>
              {pastEventsOutOfRangeCopy(page, totalPages)}{" "}
              <a href={pastEventsUrl(1, q)}>Back to page 1</a>
            </p>
          )
        ) : null}
      </div>
      <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>
        {rows.map((e) => (
          <Card e={e} archive={{ page, q }} />
        ))}
      </ul>
      <nav aria-label="Past event pages" data-archive-pager data-testid={PAST_EVENTS_PAGER_TESTID}>
        {page > 1 && totalPages > 0 ? (
          <a
            data-testid={PAST_EVENTS_PAGER_NEWER_TESTID}
            data-archive-page
            href={pastEventsUrl(Math.min(page - 1, totalPages), q)}
          >
            Newer
          </a>
        ) : null}{" "}
        {hasMore ? (
          <a
            data-testid={PAST_EVENTS_PAGER_OLDER_TESTID}
            data-archive-page
            href={pastEventsUrl(page + 1, q)}
          >
            Older
          </a>
        ) : null}
      </nav>
      <p>
        <a data-testid={PAST_EVENTS_BACK_TESTID} href="/events">
          Back to upcoming events
        </a>
      </p>
      <p role="status" data-archive-feedback></p>
    </section>
    <script src="/islands/copy-link.js" defer />
    <script src="/islands/past-events.js" defer />
  </ScheduleShell>
);
