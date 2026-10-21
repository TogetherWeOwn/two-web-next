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

const HOURS = Array.from({ length: 24 }, (_, h) => h);

// The 7x24 grid keeps its 42rem floor (public/schedule-theme.css) for the
// desktop presentation; the scroll wrapper contains it so the 390px viewport
// scrolls inside the region instead of overflowing the page. The table tag
// stays bare: ci/kit-parity-gates.mjs pins a literal "<table>" in the HTML.
// The region mirrors the calendar scroll wrapper (focusable with a label) so
// keyboard users can pan the grid. Both renderers share this markup through
// renderHotzoneGrid.
const Grid: FC<{ cells: HeatGrid; caption: string }> = ({ cells, caption }) => (
  <div data-hotzone-scroll role="region" aria-label={caption} tabindex={0}>
    <table>
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Day</th>
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

// Kit's server-only loaders reuse this escaped JSX, rather than shipping a
// second table renderer in the client bundle. Never accept pre-rendered input.
export const renderHotzoneGrid = (cells: HeatGrid, caption: string) =>
  (<Grid cells={cells} caption={caption} />).toString();

export const HotzonesIndexPage: FC<{
  appUrl: string;
  season: string;
  joins: HeatGrid;
  joinsTotal: number;
  eventCount: number;
  voice: HeatGrid;
  games: HeatGrid;
  retentionNote?: string | null;
}> = ({ appUrl, season, joins, joinsTotal, eventCount, voice, games, retentionNote }) => (
  <Layout
    title="Hot zones — Together We Own"
    canonical={canonicalUrl(appUrl, season === "all" ? "/hotzones" : `/hotzones?season=${season}`)}
    shareDescription="When the community is most active, by hour and weekday."
    robots="noindex, follow"
    theme="schedule"
  >
    <SiteHeader
      active="events"
      loginReturnTo={season === "all" ? "/hotzones" : `/hotzones?season=${season}`}
    >
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
        Successful joins only (added or already a member); denied, error and degraded attempts never
        count.
      </p>
      {retentionNote ? <p>{retentionNote}</p> : null}
      <nav aria-label="Signals">
        <ul>
          <li>
            <a href="/hotzones/joins">Joins heatmap</a>
          </li>
          <li>
            <a href="/hotzones/voice">Voice heatmap</a>
          </li>
          <li>
            <a href="/hotzones/games">Games heatmap</a>
          </li>
        </ul>
      </nav>
      <section aria-labelledby="hotzones-joins-heading">
        <h2 id="hotzones-joins-heading">
          <a href="/hotzones/joins">Joins</a>
        </h2>
        <Grid cells={joins} caption={`Join activity for season ${season}`} />
      </section>
      <section aria-labelledby="hotzones-voice-heading">
        <h2 id="hotzones-voice-heading">
          <a href="/hotzones/voice">Voice</a>
        </h2>
        <p>Estimated voice activity (estimates until calibration).</p>
        <Grid cells={voice} caption={`Estimated voice activity for season ${season}`} />
      </section>
      <section aria-labelledby="hotzones-games-heading">
        <h2 id="hotzones-games-heading">
          <a href="/hotzones/games">Games</a>
        </h2>
        <p>Estimated games activity (estimates until calibration).</p>
        <Grid cells={games} caption={`Estimated games activity for season ${season}`} />
      </section>
    </main>
    <SiteFooter />
  </Layout>
);

export const HotzoneSignalPage: FC<{
  appUrl: string;
  signal: HotzoneSignal;
  season: string;
  cells: HeatGrid;
  total: number;
  eventCount?: number;
  retentionNote?: string | null;
}> = ({ appUrl, signal, season, cells, total, eventCount, retentionNote }) => {
  const path = season === "all" ? `/hotzones/${signal}` : `/hotzones/${signal}?season=${season}`;
  const estimated = signal !== "joins";
  return (
    <Layout
      title={`${signal} hot zone — Together We Own`}
      canonical={canonicalUrl(appUrl, path)}
      shareDescription={`When ${signal} activity peaks, by hour and weekday.`}
      robots="noindex, follow"
      theme="schedule"
    >
      <SiteHeader active="events" loginReturnTo={path}>
        <a class="btn" href="/discord">
          Open Discord
        </a>
      </SiteHeader>
      <main class="events-page" id="main" tabindex={-1}>
        <p class="strap">Activity rhythms</p>
        <h1>{signal} hot zone</h1>
        {estimated ? (
          <p>
            Estimated {signal} activity for season {season} (estimates until bot event-store
            calibration). Total estimate: {total}.
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
        <p>
          <a href="/hotzones">All hot zones</a> · <a href="/hotzones/joins">joins</a> ·{" "}
          <a href="/hotzones/voice">voice</a> · <a href="/hotzones/games">games</a>
        </p>
        <Grid
          cells={cells}
          caption={
            estimated
              ? `Estimated ${signal} activity for season ${season}`
              : `Join activity for season ${season}`
          }
        />
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
