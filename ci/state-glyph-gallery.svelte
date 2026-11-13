<script lang="ts">
import StateGlyph from "../../lib/StateGlyph.svelte";
</script>

<svelte:head>
  <title>State glyph evidence</title>
</svelte:head>

<main class="base-theme">
  <h1>State glyph evidence</h1>
  {#each ["upcoming", "live", "mine", "past"] as const as state}
    <p data-state={state}><StateGlyph {state} /> <span>{state}</span></p>
  {/each}
</main>
