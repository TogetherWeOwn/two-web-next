<script lang="ts">
import type { Snippet } from "svelte";

let {
  href,
  variant = "inline",
  children,
}: {
  href: string;
  variant?: "inline" | "value" | "button";
  children: Snippet;
} = $props();
</script>

<a {href} class:value={variant === "value"} class:button={variant === "button"}>
  {@render children()}
</a>

<style>
  a {
    color: inherit;
    text-decoration: underline;
    text-decoration-thickness: 1px;
    text-underline-offset: 3px;
  }

  .value {
    color: var(--ember);
    text-decoration: none;
  }

  .button {
    display: inline-flex;
    align-items: center;
    min-height: 36px;
    padding: var(--space-2);
    color: var(--t2);
    font-family: var(--font-ui);
    font-size: var(--text-small);
    font-weight: var(--font-weight-medium);
  }

  a:focus-visible {
    outline: var(--focus-width) solid var(--focus-ring);
    outline-offset: var(--focus-offset);
  }

  @media (hover: hover) {
    a:hover { color: var(--t1); }
    .value:hover { color: var(--ember); text-decoration: underline; }
  }
</style>
