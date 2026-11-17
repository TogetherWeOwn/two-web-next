<script lang="ts">
import { onMount } from "svelte";
import TimeBlock from "../../web/src/lib/TimeBlock.svelte";
import { watchTimeSnapshot } from "../../web/src/lib/time-freshness";

let { data } = $props();
// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
let stale = $state(true);
// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
let state = $state<"upcoming" | "live">("upcoming");
let asOf = $state(data.asOf as string);
let watcher: ReturnType<typeof watchTimeSnapshot>;

onMount(() => {
  stale = false;
  watcher = watchTimeSnapshot(
    { asOf: Date.parse(asOf), staleAt: Date.parse(asOf) + 60_000, responseStart: 0 },
    () => {
      stale = true;
    },
  );
  return () => watcher.dispose();
});

// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
function replace() {
  state = "live";
  asOf = new Date(Date.now()).toISOString();
  stale = false;
  watcher.replace({
    asOf: Date.parse(asOf),
    staleAt: Date.parse(asOf) + 60_000,
    responseStart: performance.now(),
  });
}
</script>

<TimeBlock start={data.start} {asOf} {state} {stale} roomCount={8} refreshHref="/events" />
<button onclick={replace}>Replace snapshot</button>
