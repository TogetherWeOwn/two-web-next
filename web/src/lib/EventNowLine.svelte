<script lang="ts">
import { timeSnapshotIsStale } from "../../../lib/time-freshness-clock";
import { isOngoing } from "../../../src/events/ongoing";
import { structuredTime, toInstant } from "./structured-time";

// Only the public schedule and its server snapshot clock belong here.
let {
  startsAt,
  endsAt,
  zone,
  snapshot,
  renderedAt,
}: {
  startsAt: string;
  endsAt: string;
  zone: string;
  snapshot?: { asOf: string; staleAt: string };
  renderedAt: number;
} = $props();

const heading = $props.id();
const line = $derived.by(() => {
  if (!snapshot || !Number.isFinite(renderedAt)) return;
  const start = toInstant(startsAt);
  const end = toInstant(endsAt);
  const asOf = toInstant(snapshot.asOf);
  const staleAt = toInstant(snapshot.staleAt);
  if (!start || !end || !asOf || !staleAt) return;
  if (!isOngoing({ status: "published", startsAt: start, endsAt: end }, asOf)) return;
  if (+asOf > renderedAt || +staleAt <= +asOf || +staleAt > +end) return;

  const startTime = structuredTime(start, zone);
  const endTime = structuredTime(end, zone);
  const seenTime = structuredTime(asOf, zone);
  if (!startTime || !endTime || !seenTime) return;

  return {
    startTime,
    endTime,
    seenTime,
    marker: ((+asOf - +start) / (+end - +start)) * 100,
    stale: timeSnapshotIsStale(+staleAt, renderedAt),
  };
});
</script>

{#snippet time(stamp: NonNullable<ReturnType<typeof structuredTime>>, includeDate: boolean)}
  <time datetime={stamp.datetime}>{includeDate ? `${stamp.localDate}, ` : ""}{stamp.localTime}</time>
{/snippet}

{#if line}
  {@const includeDate = line.startTime.localDate !== line.endTime.localDate}
  <section class="now-line" aria-labelledby={heading}>
    <div class="line-header">
      <h2 id={heading}>Now Line</h2>
      <p>Schedule snapshot · {line.seenTime.zone}</p>
    </div>
    <p class="observation" class:stale={line.stale}>
      {line.stale ? "Last seen" : "Now · as of"} {@render time(line.seenTime, includeDate)}
    </p>
    <svg aria-hidden="true" viewBox="0 0 100 20" preserveAspectRatio="none">
      <line class="track" x1="0" x2="100" y1="10" y2="10" vector-effect="non-scaling-stroke" />
      <line class="observation marker" class:stale={line.stale} x1={line.marker} x2={line.marker} y1="1" y2="19" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="endpoints">
      <p>Scheduled start {@render time(line.startTime, includeDate)}</p>
      <p>Scheduled end {@render time(line.endTime, includeDate)}</p>
    </div>
  </section>
{/if}

<style>
  .now-line {
    margin-block: var(--space-4);
    padding: var(--space-inset-card);
    border: 1px solid var(--color-hair2);
    border-radius: var(--radius-l);
    background: var(--color-g2);
    color: var(--color-t1);
  }
  .line-header, .endpoints {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2) var(--space-4);
  }
  h2, p { margin: 0; }
  h2 { font-size: var(--text-title); font-weight: var(--font-weight-semibold); }
  p { color: var(--color-t2); font: var(--text-label) / var(--leading-label) var(--font-data); }
  .observation { color: var(--color-ember); }
  p.observation { margin-block-start: var(--space-3); }
  .observation.stale { color: var(--color-warn); }
  svg { display: block; inline-size: 100%; block-size: var(--space-5); overflow: visible; }
  .track { stroke: var(--color-border); stroke-width: 1; }
  .marker { stroke: currentColor; stroke-width: 2; }
  .marker.stale { stroke-dasharray: 3 2; }
  @media (forced-colors: active) {
    .now-line { border-color: CanvasText; }
    .track, .marker { stroke: CanvasText; }
  }
</style>
