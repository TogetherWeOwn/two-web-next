<script lang="ts">
import { onMount } from "svelte";
import { structuredTime, toInstant, type Instant } from "./structured-time";
import TextLink from "./TextLink.svelte";

// Only a no-store SSR caller with its own native watcher may opt into a dated
// Live snapshot before mount. All other callers start withdrawn on the server.
let {
  start,
  end,
  echoFrozen = false,
  viewerZone: preferredZone,
  state: eventState,
  asOf,
  stale = true,
  roomCount,
  refreshHref,
  serverLive,
}: {
  start: Instant;
  end?: Instant;
  echoFrozen?: boolean;
  viewerZone?: string | null;
  state: "upcoming" | "live" | "ended" | "cancelled";
  asOf: Instant;
  stale?: boolean;
  roomCount?: number;
  refreshHref?: string;
  serverLive?: { eventZone: string; endLabel: string };
} = $props();

let mounted = $state(false);
let browserZone = $state<string | undefined>();
let viewerZone = $derived((eventState === "live" && serverLive?.eventZone) || preferredZone);
let time = $derived(structuredTime(start, viewerZone || browserZone));
let endedTime = $derived(structuredTime(end, viewerZone || browserZone));
let snapshot = $derived(structuredTime(asOf, viewerZone || browserZone));
let startInstant = $derived(toInstant(start));
let shortDate = $derived(
  startInstant && time
    ? new Intl.DateTimeFormat("en-GB", {
        timeZone: time.zone,
        day: "numeric",
        month: "short",
      }).format(startInstant)
    : "",
);
let snapshotInstant = $derived(toInstant(asOf));
let offsets = $derived.by(() => {
  if (eventState !== "live" || !time || !startInstant || !snapshotInstant) return null;
  const formatter = new Intl.DateTimeFormat("en-GB", { timeZone: time.zone, timeZoneName: "shortOffset" });
  const offset = (at: Date) => formatter.formatToParts(at).find((part) => part.type === "timeZoneName")?.value;
  const startOffset = offset(startInstant);
  const snapshotOffset = offset(snapshotInstant);
  return startOffset && snapshotOffset && startOffset !== snapshotOffset ? { startOffset, snapshotOffset } : null;
});
let sinceLabel = $derived(offsets ? `${time?.localTime} ${offsets.startOffset}` : time?.localTime);
let snapshotLabel = $derived.by(() => {
  if (!time || !snapshot || !startInstant || !snapshotInstant) return "";
  const dateKey = new Intl.DateTimeFormat("en-GB", {
    timeZone: time.zone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const date = new Intl.DateTimeFormat("en-GB", {
    timeZone: time.zone,
    day: "numeric",
    month: "short",
  });
  const clock = offsets ? `${snapshot.localTime} ${offsets.snapshotOffset}` : snapshot.localTime;
  return dateKey.format(startInstant) === dateKey.format(snapshotInstant)
    ? clock
    : `${date.format(snapshotInstant)} ${clock}`;
});
let remaining = $derived(
  startInstant && snapshotInstant ? startInstant.getTime() - snapshotInstant.getTime() : NaN,
);
let minutes = $derived(Math.ceil(remaining / 60000));
let countdown = $derived(
  !Number.isFinite(remaining) || remaining <= 0 || remaining > 86400000
    ? null
    : remaining < 900000
      ? `starts in ${minutes} m`
      : minutes < 60
        ? `in ${minutes} m`
        : `in ${Math.floor(minutes / 60)} h ${minutes % 60} m`,
);
let hasClaim = $derived(eventState === "live" || (eventState === "upcoming" && !!countdown));
let nativeLive = $derived(eventState === "live" && !!serverLive && !stale && !!snapshot);
let withdrawn = $derived(!nativeLive && (!mounted || stale || !snapshot));
// Restrict the recovery link to a same-origin path, without URL parser surprises.
let refreshPath = $derived(
  refreshHref?.startsWith("/") &&
    !refreshHref.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(refreshHref)
    ? refreshHref.split("#", 1)[0]
    : undefined,
);

onMount(() => {
  browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  mounted = true;
});
</script>

{#snippet refreshLink(path: string)}
  <!-- A fragment-only difference must not let Kit reuse the stale snapshot. -->
  <span data-sveltekit-reload><TextLink href={path}>Refresh<span class="sr-only"> the event time</span></TextLink></span>
{/snippet}

{#if time}
  <div class="time-block" data-state={eventState}>
    <time datetime={time.datetime} class:cancelled={eventState === "cancelled"}>{#if nativeLive}<span data-live-fresh>Live</span><span hidden data-live-stale>{time.localTime}</span>{:else}{eventState === "ended" ? shortDate : eventState === "live" && !withdrawn ? "Live" : time.localTime}{/if}</time>
    <div class="details">
      <div>{time.localDate}{#if eventState !== "live" || !serverLive}{#if (viewerZone || browserZone) && time.zone === (viewerZone || browserZone)}, your time{#if browserZone && !viewerZone}{" (from your browser)"}{/if}{:else}, UTC fallback{/if}{/if}</div>
      <div class="anchor">
        {time.zone}{" · "}{time.utcTime} UTC{#if nativeLive}<span data-live-fresh>{" · "}since {sinceLabel}</span>{:else if eventState === "upcoming" && countdown && !withdrawn}{" · "}{countdown}{:else if eventState === "live" && !withdrawn}{" · "}since {sinceLabel}{#if roomCount !== undefined && Number.isSafeInteger(roomCount) && roomCount >= 0}{" · "}{roomCount} in the room{/if}{:else if eventState === "ended"}{" · "}{endedTime ? `ended ${endedTime.localTime}` : "Ended"}{#if echoFrozen}{" · "}Echo frozen{/if}{:else if eventState === "cancelled"}{" · "}Cancelled{/if}{#if hasClaim && snapshot}{" · "}{#if nativeLive}<span data-live-fresh>as of</span><span hidden data-live-stale>live as of</span>{:else}{withdrawn && eventState === "live" ? "live as of" : "as of"}{/if} <time datetime={snapshot.datetime}>{snapshotLabel}</time>{#if nativeLive}<span id="kit-live-refresh"></span>{:else if withdrawn && refreshPath}{" · "}{@render refreshLink(refreshPath)}{/if}{:else if eventState === "live" && !snapshot}{" · "}Live status unavailable{#if refreshPath}{" · "}{@render refreshLink(refreshPath)}{/if}{/if}
      </div>
      {#if eventState === "live" && serverLive && endedTime}<p>Ends <time datetime={endedTime.datetime}>{serverLive.endLabel}</time></p>{/if}
    </div>
  </div>
{:else}
  <div class="time-block">Time to be confirmed</div>
{/if}

<style>
  .time-block { border-top: 1px solid var(--two-color-hair-2); padding-top: var(--two-space-inset-card-lg); display: flex; align-items: baseline; gap: var(--two-space-4); flex-wrap: wrap; color: var(--two-color-text-primary); font-size: var(--two-font-size-body-reading); }
  .time-block > time { font-family: var(--two-font-display); font-size: var(--two-font-size-figure); font-weight: var(--two-font-weight-display); letter-spacing: var(--two-tracking-figure); font-variant-numeric: tabular-nums; }
  time.cancelled { text-decoration: line-through; }
  .details { color: var(--two-color-text-primary); font-size: var(--two-font-size-body-reading); }
  .details p { margin: 0; }
  .anchor { color: var(--two-color-text-tertiary); font-family: var(--two-font-data); font-size: var(--two-font-size-label); }
  @media (max-width: 390px) { .details { flex-basis: 100%; } }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
</style>
