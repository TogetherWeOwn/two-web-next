<script lang="ts">
import LiveDot from "../../lib/LiveDot.svelte";
import Tag from "../../lib/Tag.svelte";
import { onMount } from "svelte";

let count = $state(0);
let hydrated = $state(false);
onMount(() => {
  hydrated = true;
});
</script>

<svelte:head>
  <title>Tag gallery evidence</title>
</svelte:head>

<main class="base-theme" data-hydrated={hydrated ? "yes" : "no"}>
  <h1>Tag gallery evidence</h1>
  <p data-tag="neutral"><Tag>Neutral</Tag></p>
  <p data-tag="live"><Tag variant="live" dot>Live</Tag></p>
  <p data-tag="you"><Tag variant="you">You</Tag></p>
  <p data-tag="echo"><Tag variant="echo">Echo</Tag></p>
  <p data-tag="ok"><Tag variant="ok">OK</Tag></p>
  <p data-tag="warn"><Tag variant="warn">Warning</Tag></p>
  <p data-dot="live"><LiveDot /> Live now</p>
  <p data-dot="presence"><LiveDot kind="presence" /> Present</p>
  <button type="button" onclick={() => (count += 1)}>Clicked {count}</button>
</main>
