<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { WEEKDAY_NAMES } from "../../../../../src/hotzones/weekday-names";
import { canonicalUrl } from "../../../../../src/seo";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
// gridHtml comes only from the escaped server-side renderHotzoneGrid output.
const {
  signal,
  season,
  gridHtml,
  total,
  eventCount,
  retentionNote,
  estimated,
  appUrl,
  available,
  peak,
} = $derived(data);
const destination = $derived(
  season === "all" ? `/hotzones/${signal}` : `/hotzones/${signal}?season=${season}`,
);
// Only the joins signal reads the database, so only it renders the outage.
const unavailable = !available && !estimated;

// Peak summary copy mirrors the Hono PeakLine exactly (src/hotzones/pages.tsx).
type Peak = { weekday: number; hour: number; count: number };
const peakLine = (peak: Peak, estimated: boolean, unit?: string): string =>
  `${estimated ? "Estimated peak: " : "Peak: "}${WEEKDAY_NAMES[peak.weekday]} ${String(peak.hour).padStart(2, "0")}:00 (${peak.count}${unit ? ` ${unit}` : ""}).`;
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
  {#snippet accountChrome()}
    <a class="btn" href="/discord">Open Discord</a>
  {/snippet}
  <p class="strap">Activity rhythms</p>
  <h1>{signal} hot zone</h1>
  {#if estimated}
    <p>Estimated {signal} activity for season {season} (estimates until bot event-store calibration). Total estimate: {total}.</p>
  {:else}
    <p>Join activity for season {season}: {total} joins across {eventCount} scheduled gatherings.</p>
    <p>Successful joins only (added or already a member); denied, error and degraded attempts never count.</p>
    {#if retentionNote}<p>{retentionNote}</p>{/if}
  {/if}
  <p><a href="/hotzones">All hot zones</a> · <a href="/hotzones/joins">joins</a> · <a href="/hotzones/voice">voice</a> · <a href="/hotzones/games">games</a></p>
  {#if unavailable}
    <p role="status">Join activity is temporarily unavailable.</p>
  {:else}
    {#if peak}<p>{peakLine(peak, estimated, estimated ? undefined : "joins")}</p>{/if}
    {@html gridHtml}
  {/if}
</Shell>
