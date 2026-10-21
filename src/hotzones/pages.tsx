// Hot-zone HTML pages.
//
// Aggregates only: 7x24 grids of counts, weekday names, no per-user rows, no
// timestamps, no discord_id/created_at strings. Voice/games grids always carry
// an estimate label until bot event-store calibration.
import type { FC } from "hono/jsx";
import { Layout, SiteFooter, SiteHeader } from "../pages";
import { canonicalUrl } from "../seo";
import type { HeatGrid } from "./aggregates";
import { peakCell, WEEKDAY_NAMES } from "./aggregates";
import type { HotzonePeak, HotzoneSignal } from "./aggregates";

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

// One peak summary line per grid, computed from already-loaded cells (no new
// reads). Joins peaks never carry the "estimated" qualifier (real data);
// voice/games peaks always do. Kit Svelte mirrors this exact copy.
const PeakLine: FC<{ peak: HotzonePeak; estimated: boolean; unit?: string }> = ({
  peak,
  estimated,
  unit,
}) => (
  <p>
    {estimated ? "Estimated peak: " : "Peak: "}
    {WEEKDAY_NAMES[peak.weekday]} {String(peak.hour).padStart(2, "0")}:00 ({peak.count}
    {unit ? ` ${unit}` : ""}).
  </p>
);

// Joins outage line, same shape as the leaderboards outage line. Rendered only
// for the joins section/signal when the joins read has no database; the joins
// grid hides then (no silent zeros) while priors still render.
const JoinsOutageLine: FC = () => <p role="status">Join activity is temporarily unavailable.</p>;

export const HotzonesIndexPage: FC<{
  appUrl: string;
  season: string;
  joins: HeatGrid;
  joinsTotal: number;
  eventCount: number;
  voice: HeatGrid;
  games: HeatGrid;
  retentionNote?: string | null;
  /** False when the joins read has no database; omitted means available. */
  available?: boolean;
}> = ({
  appUrl,
  season,
  joins,
  joinsTotal,
  eventCount,
  voice,
  games,
  retentionNote,
  available = true,
}) => {
  // Peaks come from the already-loaded cells; no new reads. The joins peak is
  // null when unavailable or empty, so no callout renders either way.
  const joinsPeak = available ? peakCell(joins) : null;
  const voicePeak = peakCell(voice);
  const gamesPeak = peakCell(games);
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
        {available ? (
          <p>
            Aggregate activity by hour and weekday for season {season}: {joinsTotal} joins across{" "}
            {eventCount} scheduled gatherings.
          </p>
        ) : (
          <p>Aggregate activity by hour and weekday for season {season}.</p>
        )}
        <p>
          Successful joins only (added or already a member); denied, error and degraded attempts
          never count.
        </p>
        {retentionNote ? <p>{retentionNote}</p> : null}
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
          {!available ? (
            <JoinsOutageLine />
          ) : (
            <>
              {joinsPeak ? <PeakLine peak={joinsPeak} estimated={false} unit="joins" /> : null}
              <Grid cells={joins} caption={`Join activity for season ${season}`} />
            </>
          )}
        </section>
        <section aria-labelledby="hotzones-voice-heading">
          <h2 id="hotzones-voice-heading">
            <a href={`/hotzones/voice${qs}`}>Voice</a>
          </h2>
          <p>
            Season-independent seeded estimates of voice activity (estimates until calibration).
          </p>
          {voicePeak ? <PeakLine peak={voicePeak} estimated /> : null}
          <Grid cells={voice} caption="Season-independent seeded estimate of voice activity" />
        </section>
        <section aria-labelledby="hotzones-games-heading">
          <h2 id="hotzones-games-heading">
            <a href={`/hotzones/games${qs}`}>Games</a>
          </h2>
          <p>
            Season-independent seeded estimates of games activity (estimates until calibration).
          </p>
          {gamesPeak ? <PeakLine peak={gamesPeak} estimated /> : null}
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
  /** False when the joins read has no database; omitted means available. Only
      the joins signal reads the database, so only it renders the outage. */
  available?: boolean;
}> = ({ appUrl, signal, season, cells, total, eventCount, retentionNote, available = true }) => {
  const qs = season === "all" ? "" : `?season=${season}`;
  const path = `/hotzones/${signal}${qs}`;
  const estimated = signal !== "joins";
  const unavailable = !available && !estimated;
  const peak = unavailable ? null : peakCell(cells);
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
            Season-independent seeded estimates of {signal} activity (estimates until bot
            event-store calibration). Total estimate: {total}.
          </p>
        ) : (
          <>
            {unavailable ? (
              <p>Join activity for season {season}.</p>
            ) : (
              <p>
                Join activity for season {season}: {total} joins
                {eventCount !== undefined ? ` across ${eventCount} scheduled gatherings` : ""}.
              </p>
            )}
            <p>
              Successful joins only (added or already a member); denied, error and degraded attempts
              never count.
            </p>
            {retentionNote ? <p>{retentionNote}</p> : null}
          </>
        )}
        <p>
          <a href={`/hotzones${qs}`}>All hot zones</a> · <a href={`/hotzones/joins${qs}`}>joins</a>{" "}
          · <a href={`/hotzones/voice${qs}`}>voice</a> · <a href={`/hotzones/games${qs}`}>games</a>
        </p>
        {unavailable ? (
          <JoinsOutageLine />
        ) : (
          <>
            {peak ? (
              <PeakLine peak={peak} estimated={estimated} unit={estimated ? undefined : "joins"} />
            ) : null}
            <Grid
              cells={cells}
              caption={
                estimated
                  ? `Season-independent seeded estimate of ${signal} activity`
                  : `Join activity for season ${season}`
              }
            />
          </>
        )}
      </main>
      <SiteFooter />
    </Layout>
  );
};
