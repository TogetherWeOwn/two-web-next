import type { FC, PropsWithChildren } from "hono/jsx";
import { Layout } from "../pages";
import { goingCountText } from "../islands/contracts";
import { googleCalendarUrl, webcalUrl } from "./feeds";
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

export const EventsPage: FC<{ rows: PublicEvent[]; pastRows?: PublicEvent[]; q?: string; appUrl: string }> = ({ rows, pastRows = [], q, appUrl }) => (
  <Shell title="Events" canonical={`${appUrl}/events`}>
    <h1>Upcoming events</h1>
    <form method="get" action="/events" role="search">
      <input type="search" name="q" value={q ?? ""} maxlength={255} aria-label="Search events" />
      <button type="submit">Search</button>
      {q ? <a href="/events">Clear</a> : null}
    </form>
    {q && rows.length + pastRows.length === 0 ? (
      <p data-testid="events-no-results">No events match “{q}”.</p>
    ) : rows.length === 0 && !q ? (
      <p data-testid="events-empty">Nothing scheduled right now.</p>
    ) : (
      <ul>{rows.map((e) => <Card e={e} />)}</ul>
    )}
    {pastRows.length > 0 ? (
      <section data-testid="events-past-matches">
        <h2>Past events</h2>
        <ul>{pastRows.map((e) => <Card e={e} />)}</ul>
      </section>
    ) : null}
    <p>
      <a href={webcalUrl(appUrl)} data-testid="events-subscribe">Subscribe</a>
      {" · "}
      <a href="/events/past">Past events</a>
    </p>
  </Shell>
);

export const PastEventsPage: FC<{ rows: PublicEvent[]; page: number; hasMore: boolean; appUrl: string }> = ({ rows, page, hasMore, appUrl }) => (
  <Shell title="Past events" canonical={`${appUrl}/events/past${page > 1 ? `?page=${page}` : ""}`} robots="noindex, follow">
    <h1>Past events</h1>
    {rows.length === 0 ? <p>No past events yet.</p> : <ul>{rows.map((e) => <Card e={e} />)}</ul>}
    <p>
      {page > 1 ? <a href={page === 2 ? "/events/past" : `/events/past?page=${page - 1}`}>Newer</a> : null}{" "}
      {hasMore ? <a href={`/events/past?page=${page + 1}`}>Older</a> : null}
    </p>
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
    <p>
      <a href={`/events/${e.eventKey}.ics`} data-testid="event-ics">Add to calendar (.ics)</a>
      {" · "}
      <a href={googleCalendarUrl(e)} data-testid="event-google-calendar" rel="noopener">Google Calendar</a>
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
