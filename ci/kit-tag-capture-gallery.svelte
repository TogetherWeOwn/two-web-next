<script lang="ts">
import LiveDot from "../../lib/LiveDot.svelte";
import Tag from "../../lib/Tag.svelte";
import { onMount } from "svelte";

let _count = $state(0);
let _hydrated = $state(false);
onMount(() => {
  _hydrated = true;
});
</script>

<svelte:head>
  <title>Tag gallery evidence</title>
</svelte:head>

<style>
  @font-face {
    font-family: 'Fragment Mono';
    /* Capture waits for the face instead of accepting optional-display fallback. */
    font-display: block;
    src: url('/__tag_evidence_fonts/fragment-mono-latin-400.woff2') format('woff2');
    unicode-range: U+20-7E, U+00A0, U+2013-2014, U+2018-2019, U+201C-201D, U+2026, U+20AC, U+2122;
  }
</style>

<main class="base-theme" data-hydrated={_hydrated ? "yes" : "no"}>
  <h1>Tag gallery evidence</h1>
  <p data-tag="neutral"><Tag>Neutral</Tag></p>
  <p data-tag="live"><Tag variant="live" dot>Live</Tag></p>
  <p data-tag="you"><Tag variant="you">You</Tag></p>
  <p data-tag="echo"><Tag variant="echo">Echo</Tag></p>
  <p data-tag="ok"><Tag variant="ok">OK</Tag></p>
  <p data-tag="warn"><Tag variant="warn">Warning</Tag></p>
  <p data-dot="live"><LiveDot /> Live now</p>
  <p data-dot="presence"><LiveDot kind="presence" /> Present</p>
  <button type="button" onclick={() => (_count += 1)}>Clicked {_count}</button>
</main>
