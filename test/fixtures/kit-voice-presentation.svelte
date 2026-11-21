<script lang="ts">
import LiveSentence from "../../web/src/lib/LiveSentence.svelte";
import VoicePanel from "../../web/src/lib/VoicePanel.svelte";
import type { LiveVoiceEvent, NextVoiceEvent, VoiceView } from "../../web/src/lib/voice-view";

let {
  data: _data,
}: { data: { view: VoiceView; nextEvent?: NextVoiceEvent | null; liveEvent?: LiveVoiceEvent } } =
  $props();
</script>

<div class="voice-hero">
  <LiveSentence view={_data.view} nextEvent={_data.nextEvent} liveEvent={_data.liveEvent} />
  <VoicePanel view={_data.view} />
</div>

<style>
  .voice-hero {
    display: grid;
    grid-template-columns: minmax(0, 1fr) var(--two-layout-hero-panel);
    gap: var(--two-space-9);
    align-items: end;
  }
  @media (max-width: 820px) {
    .voice-hero { grid-template-columns: minmax(0, 1fr); gap: var(--two-space-6); }
  }
</style>
