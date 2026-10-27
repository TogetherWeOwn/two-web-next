// Hot-zone HTML pages.
//
// Aggregates only: 7x24 grids of counts, weekday names, no per-user rows, no
// timestamps, no discord_id/created_at strings. Voice/games grids always carry
// an estimate label until bot event-store calibration.
import type { FC } from "hono/jsx";
import { Layout, RecoveryShell, SiteFooter, SiteHeader } from "../pages";
import { canonicalUrl } from "../seo";
import type { HeatGrid } from "./aggregates";
import { HOTZONE_SIGNALS, WEEKDAY_NAMES } from "./aggregates";
import type { HotzoneSignal } from "./aggregates";
import { DAY_TOKENS, hotzoneQuery, projectDay, type DayToken } from "./day";
import { utcPeriodShortcuts } from "./season";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// The 7x24 grid keeps its 42rem floor (public/schedule-theme.css) for the
// desktop presentation; the scroll wrapper contains it so the 390px viewport
// scrolls inside the region instead of overflowing the page. The table tag
// stays bare: ci/kit-parity-gates.mjs pins a literal "<table>" in the HTML.
// The region mirrors the calendar scroll wrapper (focusable with a label) so
// keyboard users can pan the grid. Both renderers share this markup through
// renderHotzoneGrid.
const Grid: FC<{ cells: HeatGrid; caption: string }> = ({ cells, caption }) => {
  // The day and hour axes bucket in UTC (aggregates.ts), so say so where the
  // hours are read: one labelled string serves as the visible caption and
  // the scroll region's accessible name, and the corner header carries the
  // same UTC marking at the axis origin (the first thing a panning mobile
  // reader sees), on every grid and both renderers.
  const labelled = `${caption} (hours in UTC)`;
  return (
    <div data-hotzone-scroll role="region" aria-label={labelled} tabindex={0}>
      <table>
        <caption>{labelled}</caption>
        <thead>
          <tr>
            <th scope="col">Day (UTC)</th>
            {HOURS.map((h) => (
              <th scope="col">{String(h).padStart(2, "0")}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WEEKDAY_NAMES.map((day, weekday) => (
            <tr>
              <th scope="row">{day}</th>
              {HOURS.map((h) => (
                <td>{cells[weekday]![h]}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};

// Kit's server-only loaders reuse this escaped JSX, rather than shipping a
// second table renderer in the client bundle. Never accept pre-rendered input.
export const renderHotzoneGrid = (cells: HeatGrid, caption: string) =>
  (<Grid cells={cells} caption={caption} />).toString();

// Narrow reading mode for one weekday: the same source cells as the week grid,
// two columns (Hour UTC / Count) so a phone or a sequential screen reader walks
// 24 rows instead of a 25-column table. It reuses the member-board-table class
// (min-width 0, no 8rem cell height), so no region wrapper is needed: nothing
// scrolls sideways.
const DayReader: FC<{ cells: HeatGrid; caption: string; day: DayToken }> = ({
  cells,
  caption,
  day,
}) => {
  const labelled = `${WEEKDAY_NAMES[DAY_TOKENS.indexOf(day)]}: ${caption} (hours in UTC)`;
  return (
    <table class="member-board-table">
      <caption>{labelled}</caption>
      <thead>
        <tr>
          <th scope="col">Hour (UTC)</th>
          <th scope="col">Count</th>
        </tr>
      </thead>
      <tbody>
        {projectDay(cells, day).map((count, hour) => (
          <tr>
            <th scope="row">{String(hour).padStart(2, "0")}:00</th>
            <td>{count}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

export const renderHotzoneDay = (cells: HeatGrid, caption: string, day: DayToken) =>
  (<DayReader cells={cells} caption={caption} day={day} />).toString();

// Native period picker shared by Hono and Kit: a GET form whose action stays
// on the current index/signal route, plus server-derived UTC shortcuts. No
// JavaScript dependency; the committed season renders back into the input so
// applies and resets stay bookmarkable. The all/absent reset anchor carries
// no query state, keeping the canonical URL bare.
//
// Signal pages pass `weekday` (the chosen day token, or null for the full
// week) to add the native weekday select to this same form, so applying a
// period keeps the chosen weekday and choosing a weekday keeps the committed
// season. The leading "Full week" option submits an empty day, which the
// shared parser reads as the full week; the day-mode link returns there
// without a form. The index renders no weekday control.
const PeriodPicker: FC<{
  action: string;
  season: string;
  weekday?: { day: DayToken | null };
}> = ({ action, season, weekday }) => {
  const { month, quarter } = utcPeriodShortcuts();
  const day = weekday?.day ?? null;
  return (
    <section aria-labelledby="hotzone-period-heading">
      <h2 id="hotzone-period-heading">
        {weekday ? "Choose a period or weekday" : "Choose a period"}
      </h2>
      <form method="get" action={action}>
        <label for="hotzone-season">Period</label>{" "}
        <input
          type="text"
          id="hotzone-season"
          name="season"
          value={season}
          aria-describedby="hotzone-season-help"
        />{" "}
        {weekday ? (
          <>
            <label for="hotzone-day">Weekday (UTC)</label>{" "}
            <select id="hotzone-day" name="day">
              <option value="" selected={day === null}>
                Full week
              </option>
              {DAY_TOKENS.map((token, index) => (
                <option value={token} selected={token === day}>
                  {WEEKDAY_NAMES[index]}
                </option>
              ))}
            </select>{" "}
          </>
        ) : null}
        <button type="submit">Apply</button>
        <p id="hotzone-season-help">
          Enter all for all available data, a year such as 2026, a month such as 2026-02, or a
          quarter such as 2026-Q2. Shortcuts use UTC.
        </p>
      </form>
      <p>
        <a href={`${action}${hotzoneQuery(month, day)}`}>This month</a> ·{" "}
        <a href={`${action}${hotzoneQuery(quarter, day)}`}>This quarter</a> ·{" "}
        <a href={`${action}${hotzoneQuery("all", day)}`}>All available data</a>
        {day ? (
          <>
            {" "}
            · <a href={`${action}${hotzoneQuery(season, null)}`}>Return to full week</a>
          </>
        ) : null}
      </p>
    </section>
  );
};

// Kit's server-only loaders reuse this escaped JSX string for the identical
// picker, rather than shipping a second renderer in the client bundle.
export const renderPeriodPicker = (
  action: string,
  season: string,
  weekday?: { day: DayToken | null },
) => (<PeriodPicker action={action} season={season} weekday={weekday} />).toString();

export const HotzonesIndexPage: FC<{
  appUrl: string;
  season: string;
  joins: HeatGrid;
  joinsTotal: number;
  eventCount: number;
  voice: HeatGrid;
  games: HeatGrid;
  retentionNote?: string | null;
}> = ({ appUrl, season, joins, joinsTotal, eventCount, voice, games, retentionNote }) => {
  // Every signal link keeps the selected season; absent/all stays canonical
  // with no query, matching the canonical URL and login return-to.
  const qs = season === "all" ? "" : `?season=${season}`;
  return (
    <Layout
      title="Hot zones — Together We Own"
      canonical={canonicalUrl(appUrl, `/hotzones${qs}`)}
      shareDescription="When the community is most active, by hour and weekday."
      robots="noindex, follow"
      theme="schedule"
    >
      <SiteHeader active="events" loginReturnTo={`/hotzones${qs}`}>
        <a class="btn" href="/discord">
          Open Discord
        </a>
      </SiteHeader>
      <main class="events-page" id="main" tabindex={-1}>
        <p class="strap">Activity rhythms</p>
        <h1>Hot zones</h1>
        <p>
          Aggregate activity by hour and weekday for season {season}: {joinsTotal} joins across{" "}
          {eventCount} scheduled gatherings.
        </p>
        <p>
          Successful joins only (added or already a member); denied, error and degraded attempts
          never count.
        </p>
        {retentionNote ? <p>{retentionNote}</p> : null}
        <PeriodPicker action="/hotzones" season={season} />
        <nav aria-label="Signals">
          <ul>
            <li>
              <a href={`/hotzones/joins${qs}`}>Joins heatmap</a>
            </li>
            <li>
              <a href={`/hotzones/voice${qs}`}>Voice heatmap</a>
            </li>
            <li>
              <a href={`/hotzones/games${qs}`}>Games heatmap</a>
            </li>
          </ul>
        </nav>
        <section aria-labelledby="hotzones-joins-heading">
          <h2 id="hotzones-joins-heading">
            <a href={`/hotzones/joins${qs}`}>Joins</a>
          </h2>
          <Grid cells={joins} caption={`Join activity for season ${season}`} />
        </section>
        <section aria-labelledby="hotzones-voice-heading">
          <h2 id="hotzones-voice-heading">
            <a href={`/hotzones/voice${qs}`}>Voice</a>
          </h2>
          <p>
            Season-independent seeded estimates of voice activity (estimates until calibration).
          </p>
          <Grid cells={voice} caption="Season-independent seeded estimate of voice activity" />
        </section>
        <section aria-labelledby="hotzones-games-heading">
          <h2 id="hotzones-games-heading">
            <a href={`/hotzones/games${qs}`}>Games</a>
          </h2>
          <p>
            Season-independent seeded estimates of games activity (estimates until calibration).
          </p>
          <Grid cells={games} caption="Season-independent seeded estimate of games activity" />
        </section>
      </main>
      <SiteFooter />
    </Layout>
  );
};

export const HotzoneSignalPage: FC<{
  appUrl: string;
  signal: HotzoneSignal;
  season: string;
  cells: HeatGrid;
  total: number;
  eventCount?: number;
  retentionNote?: string | null;
  day?: DayToken | null;
}> = ({ appUrl, signal, season, cells, total, eventCount, retentionNote, day = null }) => {
  const qs = season === "all" ? "" : `?season=${season}`;
  const path = `/hotzones/${signal}${qs}`;
  // The weekday is a reading mode of the same board: the canonical URL stays
  // the full-week page, while sign-in returns to the exact view.
  const dayQs = hotzoneQuery(season, day);
  const estimated = signal !== "joins";
  const caption = estimated
    ? `Season-independent seeded estimate of ${signal} activity`
    : `Join activity for season ${season}`;
  return (
    <Layout
      title={`${signal} hot zone — Together We Own`}
      canonical={canonicalUrl(appUrl, path)}
      shareDescription={`When ${signal} activity peaks, by hour and weekday.`}
      robots="noindex, follow"
      theme="schedule"
    >
      <SiteHeader active="events" loginReturnTo={`/hotzones/${signal}${dayQs}`}>
        <a class="btn" href="/discord">
          Open Discord
        </a>
      </SiteHeader>
      <main class="events-page" id="main" tabindex={-1}>
        <p class="strap">Activity rhythms</p>
        <h1>{signal} hot zone</h1>
        {estimated ? (
          <p>
            Season-independent seeded estimates of {signal} activity (estimates until bot
            event-store calibration). Total estimate: {total}.
          </p>
        ) : (
          <>
            <p>
              Join activity for season {season}: {total} joins
              {eventCount !== undefined ? ` across ${eventCount} scheduled gatherings` : ""}.
            </p>
            <p>
              Successful joins only (added or already a member); denied, error and degraded attempts
              never count.
            </p>
            {retentionNote ? <p>{retentionNote}</p> : null}
          </>
        )}
        <PeriodPicker action={`/hotzones/${signal}`} season={season} weekday={{ day }} />
        <p>
          <a href={`/hotzones${qs}`}>All hot zones</a> ·{" "}
          <a href={`/hotzones/joins${dayQs}`}>joins</a> ·{" "}
          <a href={`/hotzones/voice${dayQs}`}>voice</a> ·{" "}
          <a href={`/hotzones/games${dayQs}`}>games</a>
        </p>
        {day ? (
          <DayReader cells={cells} caption={caption} day={day} />
        ) : (
          <Grid cells={cells} caption={caption} />
        )}
      </main>
      <SiteFooter />
    </Layout>
  );
};

const capitalize = (signal: HotzoneSignal) => signal.charAt(0).toUpperCase() + signal.slice(1);

// In-context hotzone recovery, shared by the bad-season 400 and the
// unknown-signal 404: the index plus every signal, each pinned by test id.
// The signal list is the shared HOTZONE_SIGNALS vocabulary, never a fork.
const HotzoneRecoveryNav: FC = () => (
  <nav aria-label="Hot zone signals">
    <ul>
      {HOTZONE_SIGNALS.map((signal) => (
        <li>
          <a href={`/hotzones/${signal}`} data-testid={`error-hotzone-${signal}`}>
            {capitalize(signal)} heatmap
          </a>
        </li>
      ))}
    </ul>
  </nav>
);

const HotzoneRecoveryActions: FC = () => (
  <p class="recovery-actions">
    <a class="btn" href="/hotzones" data-testid="error-hotzones">
      Browse all hot zones
    </a>{" "}
    <a href="/" data-testid="error-home">
      Back to the homepage
    </a>
  </p>
);

// Bad-season 400 with a hotzone way forward. Keeps the branded shell and the
// twin-agreed 400 title (the bad-season acceptance pins the heading
// byte-equal to kitErrorCopy(400)); the lead names the season grammar and the
// recovery nav links the index plus all three signals. Served before any
// throttle spend, DB open or board-view insert.
export const HotzoneBadSeasonPage: FC = () => (
  <RecoveryShell
    code="400"
    title="Check your request"
    headingId="error-heading"
    robots="noindex, nofollow"
  >
    <p class="lead">
      That season did not match. Use all for every season, a year like 2026, a month like 2026-09,
      or a quarter like 2026-Q3.
    </p>
    <HotzoneRecoveryActions />
    <HotzoneRecoveryNav />
  </RecoveryShell>
);

// Unknown-signal 404 with a hotzone way forward. Names joins, voice and games
// with links plus the index link; the season grammar is still checked first,
// so a bad season on an unknown signal answers 400, never here.
export const HotzoneSignalNotFoundPage: FC = () => (
  <RecoveryShell
    code="404"
    title="We cannot find that page"
    headingId="error-heading"
    robots="noindex, nofollow"
  >
    <p class="lead">
      Unknown hot zone signal. The signals are joins, voice and games — pick one below, or browse
      every hot zone.
    </p>
    <HotzoneRecoveryActions />
    <HotzoneRecoveryNav />
  </RecoveryShell>
);
