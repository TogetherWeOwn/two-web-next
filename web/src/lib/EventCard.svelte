<script lang="ts">
  import { fmt } from "../../../src/events/pages";
  import type { PublicEvent } from "../../../src/events/reads";
  import { goingCountText } from "../../../src/islands/contracts";

  // Same markup contract as Card in src/events/pages.tsx.
  let { e }: { e: PublicEvent } = $props();
</script>

<li data-testid="event-card" data-event-key={e.eventKey}>
  <h2>
    <a href={`/e/${e.eventKey}`}>{e.title}</a>
  </h2>
  <p><time datetime={e.startsAt.toISOString()}>{fmt(e.startsAt, e.timezone)}</time>{e.game ? ` · ${e.game}` : ""}</p>
  <p>{goingCountText(e.goingCount, e.capacity)}</p>
</li>
