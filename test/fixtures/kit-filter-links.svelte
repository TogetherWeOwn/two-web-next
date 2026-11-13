<script lang="ts">
  import Chip from "../../web/src/lib/Chip.svelte";
  import SegmentedControl from "../../web/src/lib/SegmentedControl.svelte";
</script>

<SegmentedControl label="Event views" items={[
  { href: "/events", label: "Upcoming", current: true, count: 0 },
  { href: "/events/past", label: "Past", count: 2 },
]} />
<Chip href="/events?game=all" selected count={0}>All games</Chip>
<Chip href="/events?game=other">Other games</Chip>
