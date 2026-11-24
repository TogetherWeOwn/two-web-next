<script lang="ts">
import VoicePanel from "./VoicePanel.svelte";
import type { VoiceView } from "./voice-view";

let {
  enabled = false,
  eventKey,
  view,
}: {
  enabled?: boolean;
  eventKey: string;
  /** A trusted audience projection. The placement has no runtime reader. */
  view?: VoiceView;
} = $props();

let eventView = $derived.by((): VoiceView | undefined => {
  if (!enabled || !view?.snapshot) return;
  if (view.audience === "guest") return view;

  const rooms = view.snapshot.rooms.filter((room) => room.eventKey === eventKey);
  if (rooms.length > 0) return { audience: "member", snapshot: { ...view.snapshot, rooms } };
});
</script>

{#if eventView}
  <VoicePanel view={eventView} eventDetail />
{/if}
