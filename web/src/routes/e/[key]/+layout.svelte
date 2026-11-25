<script lang="ts">
import type { Snippet } from "svelte";

// The success page and the 410 boundary share this layout and stylesheet.
let { children }: { children: Snippet } = $props();
</script>

{@render children()}

<style>
  :global {
    /* Each view class replaces the specificity of its former Svelte scope. */
    .kit-event-detail {
      .event-layout-head { grid-area: head; min-width: 0; }
      .lifecycle-time { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); padding-top: var(--space-7); margin-bottom: var(--space-4); border-top: 1px solid var(--color-hair2); }
      .lifecycle-figure { font-size: var(--text-figure); line-height: 1; font-variant-numeric: tabular-nums; }
      .lifecycle-time p { margin: 0; color: var(--color-t3); font: var(--text-small) / var(--leading-label) var(--font-data); }
      .lifecycle-tags { display: flex; flex-wrap: wrap; justify-content: center; gap: var(--space-2); }
      .live-time { margin-bottom: var(--space-4); --two-color-hair-2: var(--color-hair2); --two-color-text-primary: var(--color-t1); --two-color-text-tertiary: var(--color-t3); --two-space-inset-card-lg: var(--space-inset-card-lg); --two-space-4: var(--space-4); --two-font-display: var(--font-display); --two-font-data: var(--font-data); --two-font-size-figure: var(--text-figure); --two-font-size-body-reading: var(--text-body-reading); --two-font-size-label: var(--text-label); --two-font-weight-display: var(--font-weight-display); --two-tracking-figure: var(--tracking-figure); }
      @media (max-width: 820px) {
        .lifecycle-time { flex-direction: column; }
        .lifecycle-figure { font-size: var(--text-figure-compact); }
        .live-time { --two-font-size-figure: var(--text-figure-compact); }
      }
      .event-layout-rail { grid-area: rail; min-width: 0; display: flex; flex-direction: column; gap: var(--space-4); }
      .event-layout-rail > section { border: 0; }
      .event-layout-rail > .event-share { padding: 0; margin-top: var(--space-2); }
      .event-layout-rail > [data-public-voice-panel] {
        --two-radius-s: var(--radius-s);
        --two-radius-l: var(--radius-l);
        --two-color-line-hairline: var(--color-hair1);
        --two-color-bg-surface: var(--color-g1);
        --two-color-text-primary: var(--color-t1);
        --two-color-text-secondary: var(--color-t2);
        --two-space-2: var(--space-2);
        --two-space-inset-room: var(--space-inset-room);
        --two-font-size-ui: var(--text-ui);
        --two-font-size-label: var(--text-label);
        --two-font-weight-semibold: var(--font-weight-semibold);
        --two-line-height-label: var(--leading-label);
        --two-font-data: var(--font-data);
      }
      .event-layout-body { grid-area: body; min-width: 0; }
      .event-theme & .event-layout-body.ended .event-meta > div { padding: var(--space-2); }
      /* Hidden comparison controls still reserve space on the live Hono page. */
      .event-theme & .event-layout-body.ended .event-meta > div[hidden],
      .event-theme & .event-layout-body.ended .event-device-timezone:has(> button[hidden]),
      .event-layout-body .event-time-comparison:has(button[hidden]) { display: none; }
      .seat-card {
        background: var(--color-g2);
        border: 0;
        border-radius: var(--radius-l);
        padding: var(--space-inset-card);
      }
      .event-facts { background: var(--color-g2); border-radius: var(--radius-l); padding: var(--space-2) var(--space-inset-card); }
      .event-facts dl { margin: 0; }
      .event-facts dl > div { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-4); padding: var(--space-inset-tight) 0; }
      .event-facts dl > div + div { border-top: 1px solid var(--color-hair1); }
      .event-facts dt { margin: 0; color: var(--color-t3); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
      .event-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; text-align: right; color: var(--color-t1); font-size: var(--text-ui); }
      .event-facts dd p { margin: 0; }
      .seat-card-head { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: var(--space-2); margin-bottom: var(--space-inset-tight); }
      .seat-card-head h2 { margin: 0; font-size: var(--text-title); font-weight: var(--font-weight-semibold); line-height: var(--leading-title); }
      .seat-card-tag { padding: var(--space-inset-tag-y) var(--space-inset-tag-x); border-radius: var(--radius-s); color: var(--color-warn); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-warn) 45%, transparent); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
      .seat-card-note { margin: var(--space-inset-tight) 0 0; font-size: var(--text-small); color: var(--color-t2); }
      .event-theme & .seat-card .event-rsvp { display: block; margin: 0; }
      .event-theme & .seat-card .event-rsvp > section,
      .event-theme & .seat-card .event-rsvp form { align-items: stretch; gap: var(--space-inset-tight); text-align: left; }
      .event-theme & .seat-card .event-rsvp > section > a,
      .event-theme & .seat-card .event-rsvp button { width: 100%; box-sizing: border-box; }
      .event-theme & .event-detail-grid { grid-template-columns: minmax(0, 1fr); gap: 0; }
      /* Native B4/C5 controls: the Kit pill treatment without a client handler. */
      .seat-action {
        display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
        min-height: 44px; border: 0; border-radius: var(--radius-pill); padding: 0 var(--space-5);
        box-shadow: inset 0 0 0 1px var(--color-hair2); background: transparent; color: var(--color-t1);
        font: var(--font-weight-semibold) var(--text-ui) var(--font-ui);
        font-stretch: var(--font-width-button); text-decoration: none; cursor: pointer;
      }
      .seat-action-primary { background: var(--color-ember); color: var(--color-on-accent); box-shadow: none; }
      .seat-action-icon { min-height: 36px; padding-inline: var(--space-3); }
      .seat-action:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
      .seat-card > .seat-action { width: 100%; margin-top: var(--space-3); }
      @media (forced-colors: active) { .seat-action { border: 1px solid ButtonText; } }
      .seat-open-fallback { display: none; }
      /* C5 owns the initial availability. After an inline write the lineup badge
         takes over, even if the inline join control later returns. */
      .event-layout [data-event-lineup]:has([data-seat-refresh]:not([data-seat-refresh="ready"])) { display: none; }
      .event-layout [data-seat-refresh] [data-spots]:not([hidden])::before { content: " · "; }
      .event-layout:has([data-seat-refresh]:not([data-seat-refresh="initial"])),
      .event-layout:not(:has([data-testid="rsvp-going"])),
      .event-layout:has([data-island="rsvp-button"][data-outcome-unknown]) {
        .seat-open-snapshot { display: none; }
        .seat-open-fallback { display: inline; }
      }
      .event-seat-bar { display: none; }
      /* Kit B4 uses the sheet elevation and keeps the full bar out of the focus viewport. */
      @media (max-width: 820px) {
        .event-seat-bar {
          position: fixed;
          z-index: 2;
          inset: auto 0 0;
          display: flex;
          align-items: center;
          gap: var(--space-2);
          box-sizing: border-box;
          min-height: var(--event-bar-height);
          padding: var(--space-3) var(--space-3) calc(var(--space-3) + var(--event-bar-safe));
          border-top: 1px solid var(--color-hair2);
          background: color-mix(in srgb, var(--color-g1) 94%, transparent);
        }
        .event-seat-bar p { flex: 1; margin: 0; font-size: var(--text-small); color: var(--color-t2); }
        .event-seat-bar strong { color: var(--color-t1); }
        .event-seat-bar form { flex: none; margin: 0; }
        /* The inline island can update without navigation. Never offer a stale B4
           snapshot beside a changed or unconfirmed answer; native B4 POSTs reload. */
        .event-layout:has([data-seat-refresh]:not([data-seat-refresh="initial"])) ~ .event-seat-bar[data-state="open"],
        .event-layout:not(:has([data-testid="rsvp-going"]:enabled)) ~ .event-seat-bar[data-state="open"],
        .event-layout:not(:has([data-testid="rsvp-withdraw"]:enabled)) ~ .event-seat-bar[data-state="saved"] { display: none; }
      }
      /* Kit breakpoint.compact-max, layout.rail.seat, and layout.sticky-offset. */
      @media (min-width: 821px) {
        .event-layout { display: grid; grid-template-columns: minmax(0, 1fr) 380px; grid-template-areas: "head rail" "body rail"; column-gap: var(--space-9); align-items: start; }
        /* Keep the sole scheduled end above the live RSVP action, even in two columns. */
        .event-layout.live-action { grid-template-areas: "head ." "body rail"; }
        .event-layout-rail { position: sticky; top: 92px; }
      }
    }

    @media (max-width: 820px) {
      html:has(.kit-event-detail .event-seat-bar) {
        --event-bar-safe: env(safe-area-inset-bottom, 0px);
        --event-bar-height: calc(max(44px, 3.5rem) + 2 * var(--space-3) + 1px + var(--event-bar-safe));
        /* Keep the focus outline clear of the fixed bar, including at max scroll. */
        --event-bar-clearance: calc(var(--event-bar-height) + var(--space-2));
        scroll-padding-bottom: var(--event-bar-clearance);
        padding-bottom: var(--event-bar-clearance);
      }
    }

    .kit-event-cancelled {
      .event-head { grid-area: head; min-width: 0; }
      .event-rail { grid-area: rail; min-width: 0; display: grid; gap: var(--space-4); }
      .event-recovery { grid-area: recovery; min-width: 0; }
      .event-layout { display: grid; gap: var(--space-4); grid-template-areas: "head" "rail" "recovery"; }
      .scheduled { border-top: 1px solid var(--color-hair1); padding-top: var(--space-5); display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2) var(--space-4); }
      .scheduled > time { font-size: var(--text-figure); line-height: 1; font-variant-numeric: tabular-nums; }
      .scheduled p { margin: 0; }
      .anchor { font: var(--text-label) / var(--leading-label) var(--font-data); color: var(--color-t3); }
      .record, .event-facts { border: 0; border-radius: var(--radius-l); background: var(--color-g2); }
      .record { padding: var(--space-inset-card); }
      .record-head { display: flex; align-items: center; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2); }
      .record-head h2 { margin: 0; font-size: var(--text-title); font-weight: var(--font-weight-semibold); line-height: var(--leading-title); }
      .record p { margin: var(--space-inset-tight) 0; font-size: var(--text-small); color: var(--color-t2); }
      .next-date-link {
        display: inline-flex;
        vertical-align: middle;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        width: 100%;
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
      .next-date-link:focus-visible { outline: var(--focus-width) solid var(--focus-ring); outline-offset: var(--focus-offset); }
      @media (hover: hover) {
        .next-date-link:hover { background: var(--g2); }
      }
      @media (forced-colors: active) {
        .next-date-link { border: 1px solid ButtonText; }
      }
      .event-facts { padding: var(--space-2) var(--space-inset-card); }
      .event-facts dl { margin: 0; }
      .event-facts dl > div { display: flex; justify-content: space-between; gap: var(--space-4); padding: var(--space-inset-tight) 0; }
      .event-facts dl > div + div { border-top: 1px solid var(--color-hair1); }
      .event-facts dt { color: var(--color-t3); font: var(--text-label) / var(--leading-label) var(--font-data); letter-spacing: var(--tracking-label); text-transform: uppercase; }
      .event-facts dd { margin: 0; min-width: 0; overflow-wrap: anywhere; text-align: right; }
      /* Kit breakpoint.compact-max, layout.rail.seat, and layout.sticky-offset. */
      @media (min-width: 821px) {
        .event-layout { grid-template-columns: minmax(0, 1fr) 380px; grid-template-areas: "head rail" "recovery rail"; column-gap: var(--space-9); align-items: start; }
        .event-rail { position: sticky; top: 92px; }
      }
    }
  }
</style>
