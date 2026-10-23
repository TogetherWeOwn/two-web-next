<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
// Only escaped JSX produced by renderHotzoneGrid/renderPeriodPicker in the
// server loader enters these HTML slots; captions, every cell and the picker
// values are escaped by the shared renderer.
const {
  season,
  joinsHtml,
  joinsTotal,
  eventCount,
  gatherings,
  voiceHtml,
  gamesHtml,
  retentionNote,
  appUrl,
  periodPickerHtml,
} = $derived(data);
const destination = $derived(season === "all" ? "/hotzones" : `/hotzones?season=${season}`);
// Every signal link keeps the selected season; absent/all stays canonical.
const qs = $derived(season === "all" ? "" : `?season=${season}`);
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
  {#snippet accountChrome()}
    <a class="btn" href="/discord">Open Discord</a>
  {/snippet}
  <p class="strap">Activity rhythms</p>
  <h1>Hot zones</h1>
  <p>Aggregate activity by hour and weekday for season {season}: {joinsTotal} joins across {eventCount} scheduled gatherings.</p>
  <p>Successful joins only (added or already a member); denied, error and degraded attempts never count.</p>
  {#if retentionNote}<p>{retentionNote}</p>{/if}
  {@html periodPickerHtml}
  <nav aria-label="Signals">
    <ul>
      <li><a href="/hotzones/joins{qs}">Joins heatmap</a></li>
      <li><a href="/hotzones/voice{qs}">Voice heatmap</a></li>
      <li><a href="/hotzones/games{qs}">Games heatmap</a></li>
    </ul>
  </nav>
  <section aria-labelledby="hotzones-joins-heading">
    <h2 id="hotzones-joins-heading"><a href="/hotzones/joins{qs}">Joins</a></h2>
    {@html joinsHtml}
  </section>
  {#if gatherings.length > 0}
    <section data-testid="hotzone-gatherings" aria-labelledby="hotzone-gatherings-heading">
      <h2 id="hotzone-gatherings-heading">Scheduled gatherings</h2>
      {#if eventCount > gatherings.length}
        <p>showing {gatherings.length} of {eventCount} scheduled gatherings</p>
      {/if}
      <ul>
        {#each gatherings as gathering (gathering.eventKey)}
          <li><a data-testid="hotzone-gathering-link" href="/e/{gathering.eventKey}">{gathering.title}</a> <time datetime={new Date(gathering.startsAt).toISOString()}>{new Date(gathering.startsAt).toISOString()}</time></li>
        {/each}
      </ul>
    </section>
  {/if}
  <section aria-labelledby="hotzones-voice-heading">
    <h2 id="hotzones-voice-heading"><a href="/hotzones/voice{qs}">Voice</a></h2>
    <p>Season-independent seeded estimates of voice activity (estimates until calibration).</p>
    {@html voiceHtml}
  </section>
  <section aria-labelledby="hotzones-games-heading">
    <h2 id="hotzones-games-heading"><a href="/hotzones/games{qs}">Games</a></h2>
    <p>Season-independent seeded estimates of games activity (estimates until calibration).</p>
    {@html gamesHtml}
  </section>
</Shell>
