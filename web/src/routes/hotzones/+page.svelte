<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import { WEEKDAY_NAMES } from "../../../../src/hotzones/aggregates";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const { season, joins, joinsTotal, eventCount, voice, games, appUrl } = $derived(data);
const destination = $derived(season === "all" ? "/hotzones" : `/hotzones?season=${season}`);
const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
</script>

<Shell
  title="Hot zones"
  canonical={canonicalUrl(appUrl, destination)}
  robots="noindex, follow"
  description="When the community is most active, by hour and weekday."
  theme="schedule"
  activeNav="events"
  mainClass="events-page"
  loginReturnTo={destination}
>
  <p class="strap">Activity rhythms</p>
  <h1>Hot zones</h1>
  <p>Aggregate activity by hour and weekday for season {season}: {joinsTotal} joins across {eventCount} scheduled gatherings.</p>
  <nav aria-label="Signals">
    <ul>
      <li><a href="/hotzones/joins">Joins heatmap</a></li>
      <li><a href="/hotzones/voice">Voice heatmap</a></li>
      <li><a href="/hotzones/games">Games heatmap</a></li>
    </ul>
  </nav>
  <section aria-labelledby="hotzones-joins-heading">
    <h2 id="hotzones-joins-heading"><a href="/hotzones/joins">Joins</a></h2>
    <table>
      <caption>Join activity for season {season}</caption>
      <thead><tr><th scope="col">Day</th>{#each hours as h}<th scope="col">{h}</th>{/each}</tr></thead>
      <tbody>
        {#each WEEKDAY_NAMES as day, weekday}
          <tr><th scope="row">{day}</th>{#each joins[weekday] as n}<td>{n}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  </section>
  <section aria-labelledby="hotzones-voice-heading">
    <h2 id="hotzones-voice-heading"><a href="/hotzones/voice">Voice</a></h2>
    <p>Estimated voice activity (estimates until calibration).</p>
    <table>
      <caption>Estimated voice activity for season {season}</caption>
      <thead><tr><th scope="col">Day</th>{#each hours as h}<th scope="col">{h}</th>{/each}</tr></thead>
      <tbody>
        {#each WEEKDAY_NAMES as day, weekday}
          <tr><th scope="row">{day}</th>{#each voice[weekday] as n}<td>{n}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  </section>
  <section aria-labelledby="hotzones-games-heading">
    <h2 id="hotzones-games-heading"><a href="/hotzones/games">Games</a></h2>
    <p>Estimated games activity (estimates until calibration).</p>
    <table>
      <caption>Estimated games activity for season {season}</caption>
      <thead><tr><th scope="col">Day</th>{#each hours as h}<th scope="col">{h}</th>{/each}</tr></thead>
      <tbody>
        {#each WEEKDAY_NAMES as day, weekday}
          <tr><th scope="row">{day}</th>{#each games[weekday] as n}<td>{n}</td>{/each}</tr>
        {/each}
      </tbody>
    </table>
  </section>
</Shell>
