<script lang="ts">
let { state }: { state: "upcoming" | "live" | "mine" | "past" } = $props();
</script>

<!-- The containing row must also express the state in text. -->
<svg class:live={state === "live"} class:mine={state === "mine"} class="state-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
  {#if state === "past"}
    <circle cx="8" cy="8" r="7" fill="currentColor" />
  {:else}
    {#if state === "live"}
      <path d="M8 1a7 7 0 0 0 0 14Z" fill="currentColor" />
    {/if}
    <circle cx="8" cy="8" r="7" fill="none" stroke="currentColor" stroke-width="2" />
    {#if state === "mine"}
      <circle cx="8" cy="8" r="3" fill="currentColor" />
    {/if}
  {/if}
</svg>

<style>
  .state-glyph {
    width: 16px;
    height: 16px;
    flex: none;
    color: var(--t3);
  }

  .live { color: var(--live); }
  .mine { color: var(--ember); }

  @media (max-width: 390px) {
    .state-glyph { display: none; }
  }
</style>
