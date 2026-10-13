// Hot-zone HTML pages.
//
// Aggregates only: 7x24 grids of counts, weekday names, no per-user rows, no
// timestamps, no discord_id/created_at strings. Voice/games grids always carry
// an estimate label until bot event-store calibration.
import type { FC } from "hono/jsx";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import { canonicalUrl } from "../seo";
import type { HeatGrid } from "./aggregates";
import { WEEKDAY_NAMES } from "./aggregates";
import type { HotzoneSignal } from "./aggregates";

const HOURS = Array.from({ length: 24 }, (_, h) => h);

const Grid: FC<{ cells: HeatGrid; caption: string }> = ({ cells, caption }) => (
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
