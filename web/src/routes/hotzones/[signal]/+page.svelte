<script lang="ts">
import Shell from "#lib/Shell.svelte";
import { canonicalUrl } from "../../../../../src/seo";
import type { PageProps } from "./$types";

let { data }: PageProps = $props();
// gridHtml and periodPickerHtml come only from the escaped server-side
// renderHotzoneGrid/renderPeriodPicker output.
const {
  signal,
  season,
  gridHtml,
  total,
  eventCount,
  retentionNote,
  estimated,
  appUrl,
  periodPickerHtml,
} = $derived(data);
const destination = $derived(
  season === "all" ? `/hotzones/${signal}` : `/hotzones/${signal}?season=${season}`,
);
// Back and cross-signal links keep the selected season; absent/all stays canonical.
const qs = $derived(season === "all" ? "" : `?season=${season}`);
</script>

<Shell
  restoredWrite={data.restoredWrite}
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
    <p>Season-independent seeded estimates of {signal} activity (estimates until bot event-store calibration). Total estimate: {total}.</p>
  {:else}
    <p>Join activity for season {season}: {total} joins across {eventCount} scheduled gatherings.</p>
    <p>Successful joins only (added or already a member); denied, error and degraded attempts never count.</p>
    {#if retentionNote}<p>{retentionNote}</p>{/if}
  {/if}
  {@html periodPickerHtml}
  <nav aria-label="Hot zones">
    <p><a href="/hotzones{qs}">All hot zones</a> · <a href="/hotzones/joins{qs}" aria-current={signal === "joins" ? "page" : undefined}>joins</a> · <a href="/hotzones/voice{qs}" aria-current={signal === "voice" ? "page" : undefined}>voice</a> · <a href="/hotzones/games{qs}" aria-current={signal === "games" ? "page" : undefined}>games</a></p>
  </nav>
  {@html gridHtml}
</Shell>
