<script lang="ts">
import { onMount } from "svelte";
import TimeBlock from "../../web/src/lib/TimeBlock.svelte";
import { watchTimeSnapshot } from "../../web/src/lib/time-freshness";

const data = { asOf: "2026-11-07T19:20:00Z", start: "2026-11-07T19:30:00Z" };
let _stale = $state(true);
let _state = $state<"upcoming" | "live">("upcoming");
let _viewerZone = $state<string | undefined>("Europe/Paris");
let asOf = $state(data.asOf as string);
let watcher: ReturnType<typeof watchTimeSnapshot>;

onMount(() => {
  _stale = false;
  watcher = watchTimeSnapshot(
    {
      asOf: Date.parse(asOf),
      staleAt: Date.parse(asOf) + 60_000,
      responseStart: 0,
      snapshotAgeAtResponseStart: 0,
    },
    () => {
      _stale = true;
    },
  );
  return () => watcher.dispose();
});

function _replace() {
  _state = "live";
  asOf = new Date(Date.now()).toISOString();
  _stale = false;
  watcher.replace({
    asOf: Date.parse(asOf),
    staleAt: Date.parse(asOf) + 60_000,
    responseStart: performance.now(),
    snapshotAgeAtResponseStart: 0,
  });
}
</script>

<TimeBlock start={data.start} {asOf} state={_state} stale={_stale} roomCount={8} refreshHref="/events" />
<button onclick={_replace}>Replace snapshot</button>

<TimeBlock start={data.start} {asOf} state="ended" viewerZone={_viewerZone} />
<button onclick={() => (_viewerZone = undefined)}>Clear viewer zone</button>
