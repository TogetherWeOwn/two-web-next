<script lang="ts">
import { fmt } from "../../../src/events/pages";
import type { PublicEvent } from "../../../src/events/reads";
import { goingCountText } from "../../../src/islands/contracts";
import { searchContext } from "../../../src/events/search-context";

// Same markup contract as Card in src/events/pages.tsx, including the
// schedule-row chrome and the month/day date badge.
let { e, q = "" }: { e: PublicEvent; q?: string } = $props();

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
</script>

<li class="schedule-row" data-testid="event-card" data-event-key={e.eventKey}>
  <span class="schedule-date" aria-hidden="true"><span>{badge.month}</span><strong>{badge.day}</strong></span>
  <div class="schedule-info">
    <h2>
      <a href={`/e/${e.eventKey}`}>{#if q}{#each searchContext(e.title, q) as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{:else}{e.title}{/if}</a>
    </h2>
    <p><time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>{" "}<span>{e.timezone}</span>{#if e.location}{" · "}<span>{e.location}</span>{/if}</p>
    {#if e.game}<p>{e.game}</p>{/if}{#if q && e.description}<p class="archive-passage">{#each searchContext(e.description, q, true) as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}</p>{/if}
  </div>
  <span class="schedule-attendance">{goingCountText(e.goingCount, e.capacity)}</span>
</li>
