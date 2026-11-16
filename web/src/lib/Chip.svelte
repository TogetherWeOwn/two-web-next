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
  @import "../ember-theme.css" reference;

  a {
    display: inline-flex;
    align-items: center;
    gap: --theme(--space-2);
    min-height: 36px;
    padding: 0 --theme(--space-inset-room);
    border-radius: --theme(--radius-pill);
    box-shadow: inset 0 0 0 1px --theme(--color-hair2);
    color: var(--t2);
    font-family: --theme(--font-ui);
    font-size: --theme(--text-small);
    font-weight: --theme(--font-weight-medium);
    text-decoration: none;
    white-space: nowrap;
  }

  a[aria-current="true"] {
    background: var(--g2);
    box-shadow: inset 0 0 0 1px var(--border);
    color: var(--t1);
  }

  .count { font-family: --theme(--font-data); }
  a:focus-visible { outline: --theme(--focus-width) solid var(--focus-ring); outline-offset: --theme(--focus-offset); }

  @media (hover: hover) {
    a:hover { color: var(--t1); }
  }

  @media (forced-colors: active) {
    a { border: 1px solid ButtonText; }
    a[aria-current="true"] { border: 2px solid Highlight; }
  }
</style>
