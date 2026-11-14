<script lang="ts">
import { rowTimeModel, type RowTimeInput } from "#lib/structured-time";

// Row presentation of structured time (Kit C1 time column). Pure and static:
// SSR and hydration render identical text in the stored zone, so there is no
// effect, timer or store. The block presentation (C4) is not implemented here.
let input: RowTimeInput = $props();
const m = $derived(rowTimeModel(input));
</script>

<div class="row-time" data-state={m.available ? input.state : "unavailable"}>
  {#if m.available}
    <p class="line1">
      {#if m.struck}<s><time datetime={m.iso}>{m.line1}</time></s>{:else}<time datetime={m.iso}>{m.line1}</time>{/if}
      {#if m.cancelled}<span class="word">Cancelled</span>{/if}
    </p>
    <p class="line2">{m.line2}</p>
  {:else}
    <p class="line1">{m.line1}</p>
  {/if}
</div>

<style>
  /* Kit C1 time column: keep the two lines at every width. */
  .row-time { display: flex; flex-direction: column; gap: var(--space-1); }
  p { margin: 0; }
  .line1 { font-family: var(--font-ui); font-size: var(--text-ui); color: var(--t1); }
  .word { margin-left: var(--space-2); font-weight: var(--font-weight-semibold); }
  .line2 { font-family: var(--font-data); font-size: var(--text-label); color: var(--t3); }
</style>
