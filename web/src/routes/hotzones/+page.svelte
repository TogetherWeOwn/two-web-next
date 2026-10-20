<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { WEEKDAY_NAMES } from "../../../../src/hotzones/weekday-names";
import { canonicalUrl } from "../../../../src/seo";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
// Only escaped JSX produced by renderHotzoneGrid in the server loader enters
// these HTML slots; captions and every cell are escaped by the shared renderer.
const {
  season,
  joinsHtml,
  joinsTotal,
  eventCount,
  voiceHtml,
  gamesHtml,
  retentionNote,
  appUrl,
  available,
  joinsPeak,
  voicePeak,
  gamesPeak,
} = $derived(data);
const destination = $derived(season === "all" ? "/hotzones" : `/hotzones?season=${season}`);

// Peak summary copy mirrors the Hono PeakLine exactly (src/hotzones/pages.tsx):
// joins peaks never carry the "estimated" qualifier, voice/games always do.
type Peak = { weekday: number; hour: number; count: number };
const peakLine = (peak: Peak, estimated: boolean, unit?: string): string =>
  `${estimated ? "Estimated peak: " : "Peak: "}${WEEKDAY_NAMES[peak.weekday]} ${String(peak.hour).padStart(2, "0")}:00 (${peak.count}${unit ? ` ${unit}` : ""}).`;
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
  {#if available}
    <p>Aggregate activity by hour and weekday for season {season}: {joinsTotal} joins across {eventCount} scheduled gatherings.</p>
  {:else}
    <p>Aggregate activity by hour and weekday for season {season}.</p>
  {/if}
  <p>Successful joins only (added or already a member); denied, error and degraded attempts never count.</p>
  {#if retentionNote}<p>{retentionNote}</p>{/if}
  <nav aria-label="Signals">
    <ul>
      <li><a href="/hotzones/joins">Joins heatmap</a></li>
      <li><a href="/hotzones/voice">Voice heatmap</a></li>
      <li><a href="/hotzones/games">Games heatmap</a></li>
    </ul>
  </nav>
  <section aria-labelledby="hotzones-joins-heading">
    <h2 id="hotzones-joins-heading"><a href="/hotzones/joins">Joins</a></h2>
    {#if !available}
      <p role="status">Join activity is temporarily unavailable.</p>
    {:else}
      {#if joinsPeak}<p>{peakLine(joinsPeak, false, "joins")}</p>{/if}
      {@html joinsHtml}
    {/if}
  </section>
  <section aria-labelledby="hotzones-voice-heading">
    <h2 id="hotzones-voice-heading"><a href="/hotzones/voice">Voice</a></h2>
    <p>Estimated voice activity (estimates until calibration).</p>
    {#if voicePeak}<p>{peakLine(voicePeak, true)}</p>{/if}
    {@html voiceHtml}
  </section>
  <section aria-labelledby="hotzones-games-heading">
    <h2 id="hotzones-games-heading"><a href="/hotzones/games">Games</a></h2>
    <p>Estimated games activity (estimates until calibration).</p>
    {#if gamesPeak}<p>{peakLine(gamesPeak, true)}</p>{/if}
    {@html gamesHtml}
  </section>
</Shell>
