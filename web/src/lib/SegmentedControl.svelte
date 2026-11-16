<script lang="ts">
let {
  label,
  items,
}: {
  label: string;
  items: { href: string; label: string; current?: boolean; count?: number }[];
} = $props();
</script>

<nav aria-label={label} class="segments">
  {#each items as item (item.href)}
    <a href={item.href} aria-current={item.current ? "page" : undefined}>
      {item.label}
      {#if item.count !== undefined}<span class="count">{item.count}</span>{/if}
    </a>
  {/each}
</nav>

<style>
  @import "../ember-theme.css" reference;

  .segments {
    display: inline-flex;
    padding: --theme(--space-1);
    border: 1px solid --theme(--color-hair1);
    border-radius: --theme(--radius-pill);
    background: var(--g1);
  }

  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: --theme(--space-2);
    min-height: 36px;
    padding: 0 --theme(--space-4);
    border-radius: --theme(--radius-pill);
    color: var(--t2);
    font-family: --theme(--font-ui);
    font-size: --theme(--text-small);
    font-weight: --theme(--font-weight-medium);
    text-decoration: none;
  }

  a[aria-current="page"] { background: var(--g3); color: var(--t1); }
  a:focus-visible { outline: --theme(--focus-width) solid var(--focus-ring); outline-offset: --theme(--focus-offset); }
  .count { font-family: --theme(--font-data); }

  @media (hover: hover) {
    a:hover { color: var(--t1); }
  }

  @media (max-width: 390px) {
    .segments { display: flex; width: 100%; }
    a { flex: 1; }
  }

  @media (forced-colors: active) {
    a[aria-current="page"] { outline: 1px solid CanvasText; outline-offset: -1px; }
  }
</style>
