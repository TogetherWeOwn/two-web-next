<script lang="ts">
import type { Snippet } from "svelte";

let {
  variant = "neutral",
  dot = false,
  children,
}: {
  variant?: "neutral" | "live" | "you" | "echo" | "ok" | "warn";
  dot?: boolean;
  children: Snippet;
} = $props();
</script>

<span class="tag" class:live={variant === "live"} class:you={variant === "you"} class:echo={variant === "echo"} class:ok={variant === "ok"} class:warn={variant === "warn"}>
  {#if dot}<span class="dot" aria-hidden="true"></span>{/if}
  {@render children()}
</span>

<style>
  .tag {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-inset-tag-y) var(--space-inset-tag-x);
    border-radius: var(--radius-s);
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    color: var(--t2);
    font-family: var(--font-data);
    font-size: var(--text-label);
    letter-spacing: var(--tracking-label);
    text-transform: uppercase;
  }

  .live, .you, .ok, .warn {
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 45%, transparent);
  }

  .live { color: var(--live); }
  .you { color: var(--ember); }
  .ok { color: var(--ok); }
  .warn { color: var(--warn); }
  .echo {
    color: var(--echo);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, currentColor 50%, transparent);
  }

  .dot {
    width: 7px;
    height: 7px;
    flex: none;
    border-radius: 50%;
    background: currentColor;
  }

  @media (forced-colors: active) {
    .tag { outline: 1px solid CanvasText; outline-offset: -1px; }
  }
</style>
