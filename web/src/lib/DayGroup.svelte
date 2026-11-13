<script lang="ts">
import type { Snippet } from "svelte";

let {
  label,
  headingLevel = 2,
  children,
}: {
  label: string;
  headingLevel?: 2 | 3;
  children: Snippet;
} = $props();
</script>

<section class="day-group">
  {#if headingLevel === 2}
    <h2>{label}</h2>
  {:else}
    <h3>{label}</h3>
  {/if}
  <ul>{@render children()}</ul>
</section>

<style>
  :global(.day-group) + .day-group { margin-top: var(--space-inset-card-lg); }
  h2, h3 {
    margin: 0;
    padding-left: var(--space-4);
    color: var(--t3);
    font-family: var(--font-data);
    font-size: var(--text-label);
    font-weight: var(--font-weight-regular);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
  }
  ul { margin: 0; padding: 0; list-style: none; }
</style>
