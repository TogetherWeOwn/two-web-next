<script lang="ts">
import type { Snippet } from "svelte";

let {
  variant = "ghost",
  size = "md",
  type = "button",
  href,
  disabled = false,
  loading = false,
  loadingLabel = "Working…",
  disabledReason,
  ariaLabel,
  undoLabel = "change",
  fullWidth = false,
  onclick,
  children,
}: {
  variant?: "primary" | "ghost" | "quiet" | "saved" | "on-accent";
  size?: "sm" | "md" | "lg";
  type?: "button" | "submit" | "reset";
  href?: string;
  disabled?: boolean;
  loading?: boolean;
  loadingLabel?: string;
  disabledReason?: string;
  ariaLabel?: string;
  undoLabel?: string;
  fullWidth?: boolean;
  onclick?: (event: MouseEvent) => void;
  children: Snippet;
} = $props();

let appearance = $derived(disabled && variant === "primary" ? "quiet" : variant);
let accessibleLabel = $derived(
  loading
    ? undefined
    : ariaLabel && disabled && disabledReason
      ? `${ariaLabel} · ${disabledReason}`
      : ariaLabel,
);
let showSpinner = $state(false);

$effect(() => {
  if (!loading) {
    showSpinner = false;
    return;
  }
  const timer = setTimeout(() => {
    showSpinner = true;
  }, 1000);
  return () => clearTimeout(timer);
});
</script>

{#snippet content()}
  {#if loading}
    {#if showSpinner}<span class="spinner" aria-hidden="true"></span>{/if}
    {loadingLabel}
  {:else}
    {@render children()}{#if disabled && disabledReason} · {disabledReason}{:else if variant === "saved"}<span class="undo"> · {undoLabel}</span>{/if}
  {/if}
{/snippet}

{#if href !== undefined}
<a
  href={disabled || loading ? undefined : href}
  role={disabled || loading ? "link" : undefined}
  tabindex={disabled || loading ? 0 : undefined}
  aria-disabled={disabled || loading || undefined}
  aria-busy={loading || undefined}
  aria-label={accessibleLabel}
  onclick={(event) => { if (!disabled && !loading) onclick?.(event); }}
  class="pill"
  class:primary={appearance === "primary"}
  class:quiet={appearance === "quiet"}
  class:saved={appearance === "saved"}
  class:on-accent={appearance === "on-accent"}
  class:sm={size === "sm"}
  class:lg={size === "lg"}
  class:full-width={fullWidth}
>{@render content()}</a>
{:else}
<button
  class="pill"
  type={disabled || loading ? "button" : type}
  onclick={(event) => {
    if (disabled || loading) {
      event.preventDefault();
      return;
    }
    onclick?.(event);
  }}
  aria-disabled={disabled || loading || undefined}
  aria-busy={loading || undefined}
  aria-label={accessibleLabel}
  class:primary={appearance === "primary"}
  class:quiet={appearance === "quiet"}
  class:saved={appearance === "saved"}
  class:on-accent={appearance === "on-accent"}
  class:sm={size === "sm"}
  class:lg={size === "lg"}
  class:full-width={fullWidth}
>
  {@render content()}
</button>
{/if}

<style>
  .pill {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 0 var(--space-5);
    border: 0;
    border-radius: var(--radius-pill);
    background: transparent;
    box-shadow: inset 0 0 0 1px var(--color-hair2);
    color: var(--t1);
    font-family: var(--font-ui);
    font-size: var(--text-ui);
    font-weight: var(--font-weight-semibold);
    font-stretch: var(--font-width-button);
    cursor: pointer;
    text-decoration: none;
  }

  .sm { min-height: 36px; padding-inline: var(--space-inset-room); font-size: var(--text-small); }
  .lg { min-height: 56px; padding-inline: var(--space-inset-card-lg); font-size: var(--text-body); }
  .full-width { width: 100%; }
  .undo { display: none; }
  .saved:focus-visible .undo { display: inline; }
  .spinner {
    width: 16px;
    height: 16px;
    margin-right: var(--space-2);
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 50%;
  }
  @media (prefers-reduced-motion: no-preference) {
    .spinner { animation: spin 1s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  }
  .primary { background: var(--ember); box-shadow: none; color: var(--on-accent); }
  .quiet { background: var(--g2); box-shadow: none; }
  .saved { background: var(--ok-bg); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ok) 40%, transparent); color: var(--ok); }
  .on-accent { background: var(--on-accent); box-shadow: none; color: var(--t1); }
  .pill:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
  .pill[aria-disabled="true"] { background: var(--g2); box-shadow: none; color: var(--t3); cursor: not-allowed; }

  @media (hover: hover) {
    .pill:not([aria-disabled="true"]):hover { background: var(--g2); }
    .primary:not([aria-disabled="true"]):hover { background: var(--accent-hi); }
    .saved:not([aria-disabled="true"]):hover { background: var(--ok-bg); }
    .saved:not([aria-disabled="true"]):hover .undo { display: inline; }
    .on-accent:not([aria-disabled="true"]):hover { background: var(--on-accent); }
  }

  @media (forced-colors: active) {
    .pill { border: 1px solid ButtonText; }
    .pill[aria-disabled="true"] { border-color: GrayText; }
  }
</style>
