<script lang="ts">
import { onMount } from "svelte";
import { structuredTime, toInstant, type Instant } from "./structured-time";
import TextLink from "./TextLink.svelte";

// The page owns the snapshot, freshness watcher and cache policy. Start stale
// on the server so a cached or no-JavaScript response never claims to be live.
let {
  start,
  end,
  echoFrozen = false,
  viewerZone,
  state: eventState,
  asOf,
  stale = true,
  roomCount,
  refreshHref,
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
} = $props();

let mounted = $state(false);
let browserZone = $state<string | undefined>();
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
  return dateKey.format(startInstant) === dateKey.format(snapshotInstant)
    ? snapshot.localTime
    : `${date.format(snapshotInstant)} ${snapshot.localTime}`;
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
let withdrawn = $derived(!mounted || stale || !snapshot);
// Restrict the recovery link to a same-origin path, without URL parser surprises.
let refreshPath = $derived(
  refreshHref?.startsWith("/") &&
    !refreshHref.startsWith("//") &&
    !/[\\\u0000-\u001f\u007f]/.test(refreshHref)
    ? refreshHref.split("#", 1)[0]
    : undefined,
);

onMount(() => {
  if (!viewerZone) browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  mounted = true;
});
</script>

{#if time}
  <div class="time-block" data-state={eventState}>
    <time datetime={time.datetime} class:cancelled={eventState === "cancelled"}>{eventState === "ended" ? shortDate : eventState === "live" && !withdrawn ? "Live" : time.localTime}</time>
    <div class="details">
      <div>{time.localDate}{#if (viewerZone || browserZone) && time.zone === (viewerZone || browserZone)}, your time{#if browserZone && !viewerZone}{" (from your browser)"}{/if}{:else}, UTC fallback{/if}</div>
      <div class="anchor">
        {time.zone}{" · "}{time.utcTime} UTC{#if eventState === "upcoming" && countdown && !withdrawn}{" · "}{countdown}{:else if eventState === "live" && !withdrawn}{" · "}since {time.localTime}{#if roomCount !== undefined && Number.isSafeInteger(roomCount) && roomCount >= 0}{" · "}{roomCount} in the room{/if}{:else if eventState === "ended"}{" · "}{endedTime ? `ended ${endedTime.localTime}` : "Ended"}{#if echoFrozen}{" · "}Echo frozen{/if}{:else if eventState === "cancelled"}{" · "}Cancelled{/if}{#if hasClaim && snapshot}{" · "}{withdrawn && eventState === "live" ? "live as of" : "as of"} <time datetime={snapshot.datetime}>{snapshotLabel}</time>{#if withdrawn && refreshPath}{" · "}<TextLink href={refreshPath}>Refresh<span class="sr-only"> the event time</span></TextLink>{/if}{:else if eventState === "live" && !snapshot}{" · "}Live status unavailable{#if refreshPath}{" · "}<TextLink href={refreshPath}>Refresh<span class="sr-only"> the event time</span></TextLink>{/if}{/if}
      </div>
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
  .anchor { color: var(--two-color-text-tertiary); font-family: var(--two-font-data); font-size: var(--two-font-size-label); }
  @media (max-width: 390px) { .details { flex-basis: 100%; } }
  .sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
</style>
