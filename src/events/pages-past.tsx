// Past events archive screen: paginated list of what already happened.
import type { FC } from "hono/jsx";
import { kitErrorCopy } from "../kit-errors";
import { RecoveryShell } from "../pages";
import { canonicalUrl } from "../seo";
import {
  EVENT_CARD_HOST_TESTID,
  EVENTS_EMPTY_COPY,
  EVENTS_GAME_ALL_COPY,
  EVENTS_GAME_FILTER_LABEL,
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
import { searchContext } from "./search-context";

const Card: FC<{ e: PublicEvent; q: string; archive: ArchiveContext }> = ({ e, q, archive }) => {
  // Same compact host line as the upcoming CalCard: trimmed public organizer,
  // already on the row (no new read); blank/missing renders no node.
  const host = (e.organizer_name ?? "").trim();
  return (
    <li class="schedule-row" data-testid="event-card" data-event-key={e.eventKey}>
      <ScheduleDate date={e.startsAt} zone={e.timezone} />
      <div class="schedule-info">
        <h2>
          <a href={archiveEventHref(e.eventKey, archive)}>
            {q ? (
              <span>
                {searchContext(e.title, q).map((part) =>
                  part.match ? <mark>{part.text}</mark> : part.text,
                )}
              </span>
            ) : (
              e.title
            )}
          </a>
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
        {host !== "" ? <p data-testid={EVENT_CARD_HOST_TESTID}>Hosted by {host}</p> : null}
        {q && e.description ? (
          <p class="archive-passage">
            {searchContext(e.description, q, true).map((part) =>
              part.match ? <mark>{part.text}</mark> : part.text,
            )}
          </p>
        ) : null}
      </div>
      <span class="schedule-attendance">{goingCountText(e.goingCount, e.capacity)}</span>
    </li>
  );
};

/** Invalid archive filter (overlong/NUL/duplicate game, duplicate query):
 * a branded 400 naming no input back, twin-agreed with kitErrorCopy(400).
 * Served before any throttle spend, DB open or cache lookup. */
export const PastEventsBadFilterPage: FC = () => {
  const copy = kitErrorCopy(400);
  return (
    <RecoveryShell
      code={copy.code}
      title={copy.title}
      headingId="error-heading"
      robots="noindex, nofollow"
    >
      <p class="lead">{copy.lead}</p>
      <p>
        <a href="/events/past">Back to past events</a>
      </p>
    </RecoveryShell>
  );
};

export const PastEventsPage: FC<{
  rows: PublicEvent[];
  page: number;
  hasMore: boolean;
  totalPages: number;
  appUrl: string;
  q?: string;
  /** Archive-visible game suggestions (capped); empty when unlisted. */
  games?: string[];
  /** Effective game filter (canonical suggestion or retained valid input); "" = unfiltered. */
  game?: string;
  /** More distinct archive games exist beyond the rendered suggestions. */
  gamesOmitted?: boolean;
}> = ({
  rows,
  page,
  hasMore,
  totalPages,
  appUrl,
  q = "",
  games = [],
  game = "",
  gamesOmitted = false,
}) => (
  <ScheduleShell
    title="Past events"
    canonical={canonicalUrl(appUrl, pastEventsUrl(page, q, game))}
    description="Look back at the community’s game nights and tournaments."
    robots="noindex, follow"
    loginReturnTo={pastEventsUrl(page, q, game)}
  >
    <section
      data-island={PAST_EVENTS_ISLAND}
      data-testid={PAST_EVENTS_TESTID}
      data-page={page}
      data-total-pages={totalPages}
      data-query={q}
      data-game={game}
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
        {/* Native GET facet inside the swapped zone, so enhanced page turns
            keep the selected game in sync. Changing it submits without a page
            value, resetting to page one; the text query rides along hidden. */}
        <form method="get" action="/events/past" role="search">
          <label for="past-events-game-filter">{EVENTS_GAME_FILTER_LABEL}</label>
          <select
            id="past-events-game-filter"
            name="game"
            aria-describedby="past-events-game-scope"
          >
            <option value="" selected={game === ""}>
              {EVENTS_GAME_ALL_COPY}
            </option>
            {games.map((suggestion) => (
              <option value={suggestion} selected={suggestion === game}>
                {suggestion}
              </option>
            ))}
            {/* A selected game beyond the capped suggestions stays selected:
                suggestions never silently unfilter a valid game. */}
            {game !== "" && !games.includes(game) ? (
              <option value={game} selected>
                {game}
              </option>
            ) : null}
          </select>
          {q ? <input type="hidden" name="q" value={q} /> : null}
          <button class="btn" type="submit">
            Search
          </button>
          <p id="past-events-game-scope">Games from past events.</p>
          {gamesOmitted ? (
            <p>Showing the first 100 games; more games exist in the archive.</p>
          ) : null}
        </form>
        {q || game ? (
          <p role="status">
            {q && game ? (
              <>
                Past events matching “{q}” for game “{game}”.{" "}
                <a href={pastEventsUrl(1, q)}>Clear game</a>{" "}
                <a href={pastEventsUrl(1, "", game)}>Clear search</a>
              </>
            ) : q ? (
              <>
                Past events matching “{q}”. <a href="/events/past">Clear search</a>
              </>
            ) : (
              <>
                Past events for game “{game}”. <a href="/events/past">Clear game</a>
              </>
            )}
          </p>
        ) : null}
        {rows.length === 0 ? (
          totalPages === 0 && (q || game) ? (
            <p role="status" data-testid={PAST_EVENTS_SEARCH_MISS_TESTID}>
              {q && game ? (
                <>
                  No past events match “{q}” for game “{game}”.{" "}
                  <a href={pastEventsUrl(1, q)}>Clear game</a>{" "}
                  <a href={pastEventsUrl(1, "", game)}>Clear search</a>
                </>
              ) : q ? (
                <>
                  No past events match “{q}”. <a href="/events/past">Clear search</a>
                </>
              ) : (
                <>
                  No past events for game “{game}”. <a href="/events/past">Clear game</a>
                </>
              )}
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
              <a href={pastEventsUrl(1, q, game)}>Back to page 1</a>
            </p>
          )
        ) : null}
      </div>
      <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>
        {rows.map((e) => (
          <Card e={e} q={q} archive={{ page, q, game }} />
        ))}
      </ul>
      <nav aria-label="Past event pages" data-archive-pager data-testid={PAST_EVENTS_PAGER_TESTID}>
        {page > 1 && totalPages > 0 ? (
          <a
            data-testid={PAST_EVENTS_PAGER_NEWER_TESTID}
            data-archive-page
            href={pastEventsUrl(Math.min(page - 1, totalPages), q, game)}
          >
            Newer
          </a>
        ) : null}{" "}
        {hasMore ? (
          <a
            data-testid={PAST_EVENTS_PAGER_OLDER_TESTID}
            data-archive-page
            href={pastEventsUrl(page + 1, q, game)}
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
