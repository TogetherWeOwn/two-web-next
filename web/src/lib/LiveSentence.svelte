<script lang="ts">
import Button from "./Button.svelte";
import {
  freshnessLabel,
  liveSentence,
  type LiveVoiceEvent,
  type NextVoiceEvent,
  type VoiceView,
} from "./voice-view";

let {
  view,
  nextEvent,
  liveEvent,
}: {
  view: VoiceView;
  nextEvent?: NextVoiceEvent | null;
  liveEvent?: LiveVoiceEvent;
} = $props();
let sentence = $derived(liveSentence(view, nextEvent, liveEvent));
let frozen = $derived(view.snapshot?.freshness === "frozen");
</script>

<div class="sentence">
  {#if view.snapshot}
    <p class="freshness" class:frozen>
      <span aria-hidden="true"></span>From our Discord · {freshnessLabel(view.snapshot)}
    </p>
  {/if}
  <h1>{sentence.lead}{#if sentence.accent}{" "}<em>{sentence.accent}</em>{/if}</h1>
  <div class="action">
    {#if view.audience === "guest"}
      <Button size="lg" variant="primary" href="/join/discord">Join with Discord</Button>
      <p>One tap. The bot adds you to the server, gives you your first rank and brings you back here.</p>
    {:else if frozen}
      <Button size="lg" href="/discord">Open Discord</Button>
    {:else}
      <Button size="lg" href="/events">See what's on</Button>
    {/if}
  </div>
</div>

<style>
  .sentence { min-inline-size: 0; }
  .freshness { display: flex; align-items: center; gap: var(--two-space-2); color: var(--two-color-text-secondary); font: var(--two-font-size-label)/var(--two-line-height-label) var(--two-font-data); }
  .freshness span { flex: none; inline-size: var(--two-size-live-dot); block-size: var(--two-size-live-dot); border-radius: var(--two-radius-pill); background: var(--two-color-state-ok); }
  .frozen span { background: var(--two-color-state-warn); }
  h1 {
    margin: var(--two-space-3) 0 var(--two-space-6);
    color: var(--two-color-text-primary);
    font: var(--two-font-weight-display) var(--two-font-size-hero)/var(--two-line-height-display) var(--two-font-display);
    letter-spacing: var(--two-tracking-display);
    text-transform: none;
    text-wrap: balance;
    overflow-wrap: anywhere;
  }
  h1 em { font-family: var(--two-font-accent); font-weight: var(--two-font-weight-regular); color: var(--two-color-text-accent); }
  .action { display: flex; align-items: center; flex-wrap: wrap; gap: var(--two-space-3); }
  .action p { max-inline-size: 34ch; margin: 0; color: var(--two-color-text-secondary); font-size: var(--two-font-size-ui); }
  @media (max-width: 820px) {
    .action { align-items: stretch; flex-direction: column; }
  }
  @media (prefers-reduced-motion: no-preference) {
    h1 { animation: enter var(--two-motion-duration-enter) var(--two-motion-ease) both; }
    @keyframes enter { from { opacity: 0; transform: translateY(var(--two-motion-distance-enter)); } }
  }
</style>
