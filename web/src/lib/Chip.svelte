<script lang="ts">
import type { Snippet } from "svelte";

let {
  href,
  selected = false,
  count,
  children,
}: {
  href: string;
  selected?: boolean;
  count?: number;
  children: Snippet;
} = $props();
</script>

<a {href} aria-current={selected ? "true" : undefined}>
  {@render children()}
  {#if count !== undefined}<span class="count">{count}</span>{/if}
</a>

<style>
  a {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-inset-room);
    border-radius: var(--radius-pill);
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    color: var(--t2);
    font-family: var(--font-ui);
    font-size: var(--text-small);
    font-weight: var(--font-weight-medium);
    text-decoration: none;
    white-space: nowrap;
  }

  a[aria-current="true"] {
    background: var(--g2);
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--t1);
  }

  .count { font-family: var(--font-data); }
  a:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }

  @media (hover: hover) {
    a:hover { color: var(--t1); }
  }

  @media (forced-colors: active) {
    a { border: 1px solid ButtonText; }
    a[aria-current="true"] { border: 2px solid Highlight; }
  }
</style>
