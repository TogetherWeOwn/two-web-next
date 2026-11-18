<script lang="ts">
// The consuming document supplies the styles, including without JS.
let {
  label,
  items,
}: {
  label: string;
  items: { href: string; label: string; current?: boolean; count?: number; testId?: string }[];
} = $props();
</script>

<nav aria-label={label} class="segments">
  {#each items as item (item.href)}
    <a href={item.href} aria-current={item.current ? "page" : undefined} data-testid={item.testId}>
      {item.label}{#if item.count !== undefined}<span class="count">{item.count}</span>{/if}
    </a>
  {/each}
</nav>
