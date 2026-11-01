<script lang="ts">
import { effectiveZone, fmt } from "../../../src/events/date-format";
import type { PastArchiveEvent } from "../../../src/kit-past-events";
import { archiveEventHref, type ArchiveContext } from "../../../src/events/attendee-paths";
import { goingCountText } from "../../../src/islands/contracts";

// Same markup contract as Card in src/events/pages.tsx, including the
// schedule-row chrome and the month/day date badge. The prop is the
// anonymous-safe slice the past load projects (never the full row), so a
// new rendered field fails typecheck here instead of silently widening the
// __data.json payload. During a search the slice also carries the
// pre-segmented title spans and the bounded description passage, never
// the description itself; the segment authority stays server-side.
let {
  e,
  q = "",
  archive,
}: { e: PastArchiveEvent; q?: string; archive?: ArchiveContext } = $props();

function dateParts(date: Date, zone: string): { month?: string; day?: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: zone,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }).formatToParts(date);
  }
  return {
    month: parts.find((p) => p.type === "month")?.value,
    day: parts.find((p) => p.type === "day")?.value,
  };
}
// Time line uses the upcoming-card shape (time · zone · location), mirroring
// Card in src/events/pages-past.tsx: zone always, location only when present.
// (Kept here, not in the template, so the note costs zero client bytes.)
const badge = $derived(dateParts(e.startsAt, e.timezone));
// Same compact host line as the Hono twins: trimmed public organizer from the
// projected row (no new read); blank/missing renders no node.
const host = $derived((e.organizer_name ?? "").trim());
// A stored zone Intl rejects reads as UTC, so the label matches the clock.
const zone = $derived(effectiveZone(e.timezone));
</script>

<li class="schedule-row" data-testid="event-card" data-event-key={e.eventKey}>
  <span class="schedule-date" aria-hidden="true"><span>{badge.month}</span><strong>{badge.day}</strong></span>
  <div class="schedule-info">
    <h2>
      <a href={archiveEventHref(e.eventKey, archive)}>{#if q && e.titleSpans}<span>{#each e.titleSpans as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</span>{:else}{e.title}{/if}</a>
    </h2>
    <p><time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, zone)}</time>{" "}<span>{zone}</span>{#if e.location}{" · "}<span>{e.location}</span>{/if}</p>
    {#if e.game}<p>{e.game}</p>{/if}
    {#if host}<p data-testid="event-card-host">Hosted by {host}</p>{/if}{#if q && e.passage}<p class="archive-passage">{#each e.passage as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>{/if}
  </div>
  <span class="schedule-attendance">{goingCountText(e.goingCount, e.capacity)}</span>
</li>
