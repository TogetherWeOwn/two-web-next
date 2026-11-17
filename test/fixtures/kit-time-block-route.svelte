<script lang="ts">
import EmberShell from "#lib/EmberShell.svelte";
import SiteMetadata from "#lib/SiteMetadata.svelte";
import TimeBlock from "#lib/TimeBlock.svelte";

// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
const start = "2026-11-07T19:30:00Z";
// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
const asOf = "2026-11-07T19:20:00Z";
</script>

<SiteMetadata title="Event times" theme="home" />
<EmberShell activeNav="events" member={false}>
  <h1>Event times</h1>
  <h2>Upcoming</h2>
  <TimeBlock {start} {asOf} state="upcoming" stale={false} refreshHref="/events" />
  <h2>Live</h2>
  <TimeBlock {start} asOf="2026-11-07T19:35:00Z" state="live" stale={false} roomCount={8} refreshHref="/events" />
  <h2>Stale</h2>
  <TimeBlock {start} asOf="2026-11-07T19:35:00Z" state="live" stale={true} roomCount={8} refreshHref="/events" />
  <h2>Ended</h2>
  <TimeBlock {start} end="2026-11-07T21:00:00Z" {asOf} state="ended" />
  <h2>Cancelled</h2>
  <TimeBlock {start} {asOf} state="cancelled" />
  <h2>Unconfirmed</h2>
  <TimeBlock start="invalid" {asOf} state="upcoming" />
</EmberShell>
