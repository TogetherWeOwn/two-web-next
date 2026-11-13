<script lang="ts">
import StateGlyph from "$lib/StateGlyph.svelte";

// biome-ignore lint/correctness/noUnusedVariables: referenced by the Svelte template.
const states = ["upcoming", "live", "mine", "past"] as const;
</script>

<svelte:head>
  <title>State glyph evidence</title>
</svelte:head>

<main class="base-theme">
  <h1>State glyph evidence</h1>
  {#each states as state}
    <p data-state={state}><StateGlyph {state} /> <span>{state}</span></p>
  {/each}
</main>
