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
  .segments {
    display: inline-flex;
    box-sizing: border-box;
    padding: var(--space-1);
    border: 1px solid var(--color-hair1);
    border-radius: var(--radius-pill);
    background: var(--g1);
  }

  a {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    min-height: 36px;
    padding: 0 var(--space-4);
    border-radius: var(--radius-pill);
    color: var(--t2);
    font-family: var(--font-ui);
    font-size: var(--text-small);
    font-weight: var(--font-weight-medium);
    text-decoration: none;
  }

  a[aria-current="page"] { background: var(--g3); color: var(--t1); }
  a:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
  .count { font-family: var(--font-data); }

  @media (hover: hover) {
    a:hover { color: var(--t1); }
  }

  @media (max-width: 390px) {
    .segments { display: flex; width: 100%; }
    a { flex: 1; }
  }

  @media (forced-colors: active) {
    a[aria-current="page"] { outline: 1px solid CanvasText; outline-offset: -1px; }
    a[aria-current="page"]:focus-visible { outline: var(--focus-width) solid Highlight; outline-offset: var(--focus-offset); }
  }
</style>
