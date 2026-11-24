<script lang="ts">
import VoicePanel from "./VoicePanel.svelte";
import type { VoiceView } from "./voice-view";

let {
  enabled = false,
  eventKey,
  publicLive = false,
  view,
}: {
  enabled?: boolean;
  eventKey: string;
  /** The caller has admitted the public socket for this document. */
  publicLive?: boolean;
  /** A trusted audience projection. */
  view?: VoiceView;
} = $props();

let eventView = $derived.by((): VoiceView | undefined => {
  if (!enabled || !view?.snapshot) return;
  if (view.audience === "guest") return view;

  const rooms = view.snapshot.rooms.filter((room) => room.eventKey === eventKey);
  if (rooms.length > 0) return { audience: "member", snapshot: { ...view.snapshot, rooms } };
});
</script>

{#if enabled && publicLive && !view}
  <VoicePanel eventDetail publicLive />
{:else if eventView}
  <VoicePanel view={eventView} eventDetail />
{/if}
