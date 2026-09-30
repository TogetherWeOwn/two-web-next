import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout } from "../pages";
import {
  PAST_EVENTS_COPY,
  PAST_EVENTS_EMPTY_TESTID,
  PAST_EVENTS_ISLAND,
  PAST_EVENTS_LIST_TESTID,
  PAST_EVENTS_OUT_OF_RANGE_TESTID,
  PAST_EVENTS_TESTID,
  goingCountText,
  pastEventsOutOfRangeCopy,
  pastEventsUrl,
} from "../islands/contracts";
import type { PublicEvent } from "./reads";

const fmt = (d: Date, tz: string): string => {
  try {
    return new Intl.DateTimeFormat("en-GB", { dateStyle: "full", timeStyle: "short", timeZone: tz }).format(d);
  } catch {
    return d.toISOString();
  }
};

const Shell: FC<PropsWithChildren<{ title: string; canonical?: string; robots?: string; description?: string | null }>> = ({
  title,
  canonical,
  robots,
  description,
  children,
}) => (
  <Layout title={`${title} — Together We Own`} canonical={canonical} shareTitle={title} shareDescription={description} robots={robots}>
    <header class="bar">
      <a class="brand" href="/">TWO</a>
      <nav>
        <a href="/events">Events</a>
      </nav>
    </header>
    <main>{children}</main>
  </Layout>
);

const Card: FC<{ e: PublicEvent }> = ({ e }) => (
  <li data-testid="event-card" data-event-key={e.eventKey}>
    <h2>
      <a href={`/e/${e.eventKey}`}>{e.title}</a>
    </h2>
    <p>
      <time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>
      {e.game ? ` · ${e.game}` : ""}
    </p>
    <p>{goingCountText(e.goingCount, e.capacity)}</p>
  </li>
);

export const EventsPage: FC<{ rows: PublicEvent[]; appUrl: string }> = ({ rows, appUrl }) => (
  <Shell title="Events" canonical={`${appUrl}/events`}>
    <h1>Upcoming events</h1>
    {rows.length === 0 ? <p data-testid="events-empty">Nothing scheduled right now.</p> : <ul>{rows.map((e) => <Card e={e} />)}</ul>}
    <p><a href="/events/past">Past events</a></p>
  </Shell>
);

export const PastEventsPage: FC<{ rows: PublicEvent[]; page: number; hasMore: boolean; totalPages: number; appUrl: string }> = ({ rows, page, hasMore, totalPages, appUrl }) => (
  <Shell title="Past events" canonical={`${appUrl}${pastEventsUrl(page)}`} robots="noindex, follow">
    <section data-island={PAST_EVENTS_ISLAND} data-testid={PAST_EVENTS_TESTID} data-page={page} data-total-pages={totalPages} data-load-error={PAST_EVENTS_COPY.failed} aria-labelledby="past-events-heading">
      <h1 id="past-events-heading" tabindex={-1}>Past events</h1>
      <div data-archive-state>
        {rows.length === 0 ? (
          totalPages === 0 ? (
            <div data-testid={PAST_EVENTS_EMPTY_TESTID}>
              <p>{PAST_EVENTS_COPY.empty}</p>
              <p><a href="/join">{PAST_EVENTS_COPY.join}</a></p>
            </div>
          ) : (
            <p role="status" data-testid={PAST_EVENTS_OUT_OF_RANGE_TESTID}>{pastEventsOutOfRangeCopy(page, totalPages)}</p>
          )
        ) : null}
      </div>
      <ul data-testid={PAST_EVENTS_LIST_TESTID} data-archive-list hidden={rows.length === 0}>{rows.map((e) => <Card e={e} />)}</ul>
      <nav aria-label="Past event pages" data-archive-pager>
        {page > 1 && totalPages > 0 ? (
          <a data-archive-page href={pastEventsUrl(Math.min(page - 1, totalPages))}>Newer</a>
        ) : null}{" "}
        {hasMore ? <a data-archive-page href={pastEventsUrl(page + 1)}>Older</a> : null}
      </nav>
      <p><a href="/events">Back to upcoming events</a></p>
      <p role="status" data-archive-feedback></p>
    </section>
    <script src="/islands/past-events.js" defer />
  </Shell>
);

export const EventPage: FC<{ e: PublicEvent; appUrl: string; jsonLd: string }> = ({ e, appUrl, jsonLd }) => (
  <Shell title={e.title} canonical={`${appUrl}/e/${e.eventKey}`} description={e.description}>
    <h1>{e.title}</h1>
    <p>
      <time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>
    </p>
    {e.location ? <p>{e.location}</p> : null}
    {e.description ? <p>{e.description}</p> : null}
    <p data-testid="going-count" data-island="going-count" data-event-key={e.eventKey}>
      {goingCountText(e.goingCount, e.capacity)}
    </p>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
  </Shell>
);

export const EventGonePage: FC = () => (
  <Shell title="Event cancelled" robots="noindex, nofollow">
    <h1>This event was cancelled</h1>
    <p><a href="/events">See upcoming events</a></p>
  </Shell>
);
