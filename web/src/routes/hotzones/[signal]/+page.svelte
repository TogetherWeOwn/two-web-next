<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../../../src/seo";
import { WEEKDAY_NAMES } from "../../../../../../src/hotzones/aggregates";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
const { signal, season, cells, total, eventCount, estimated, appUrl } = $derived(data);
const destination = $derived(
  season === "all" ? `/hotzones/${signal}` : `/hotzones/${signal}?season=${season}`,
);
const hours = Array.from({ length: 24 }, (_, h) => String(h).padStart(2, "0"));
</script>

<Shell
  title="{signal} hot zone"
  canonical={canonicalUrl(appUrl, destination)}
  robots="noindex, follow"
  description="When {signal} activity peaks, by hour and weekday."
  theme="schedule"
  activeNav="events"
  mainClass="events-page"
  loginReturnTo={destination}
>
  <p class="strap">Activity rhythms</p>
  <h1>{signal} hot zone</h1>
  {#if estimated}
    <p>Estimated {signal} activity for season {season} (estimates until bot event-store calibration). Total estimate: {total}.</p>
  {:else}
    <p>Join activity for season {season}: {total} joins across {eventCount} scheduled gatherings.</p>
  {/if}
  <p><a href="/hotzones">All hot zones</a> · <a href="/hotzones/joins">joins</a> · <a href="/hotzones/voice">voice</a> · <a href="/hotzones/games">games</a></p>
  <table>
    <caption>{estimated ? `Estimated ${signal} activity for season ${season}` : `Join activity for season ${season}`}</caption>
    <thead><tr><th scope="col">Day</th>{#each hours as h}<th scope="col">{h}</th>{/each}</tr></thead>
    <tbody>
      {#each WEEKDAY_NAMES as day, weekday}
        <tr><th scope="row">{day}</th>{#each cells[weekday] as n}<td>{n}</td>{/each}</tr>
      {/each}
    </tbody>
  </table>
</Shell>
