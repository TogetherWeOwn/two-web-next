<script lang="ts">
import { onMount } from "svelte";
import { z } from "zod";
import { createBrowserLiveTopic } from "../../src/live/browser-topic";

// Reduced synthetic projections, not validators for a deployed endpoint.
const timing = { freshness: z.enum(["fresh", "frozen"]), ageMs: z.number().int().nonnegative() };
const count = z.number().int().nonnegative();
const guest = z.strictObject({ ...timing, count });
const member = z.strictObject({
  ...timing,
  rooms: z.array(z.strictObject({ name: z.string(), count, occupants: z.array(z.string()) })),
});
type GuestVoice = z.infer<typeof guest>;
type MemberVoice = z.infer<typeof member>;
export let view:
  | { audience: "guest"; snapshot: GuestVoice | null }
  | { audience: "member"; snapshot: MemberVoice | null };

const parse = (value: unknown) =>
  view.audience === "guest" ? guest.parse(value) : member.parse(value);
async function poll(signal: AbortSignal) {
  const response = await fetch("/__fixture_poll__", { signal });
  return response.ok && response.status !== 204 ? parse(await response.json()) : null;
}
const live = createBrowserLiveTopic(
  "voice",
  view.snapshot,
  parse,
  view.audience === "member" ? poll : undefined,
);
onMount(() => live.start());
</script>

<main aria-label="Synthetic voice projection">
  <p role="status" data-source={$live.source}>
    {#if $live.value === null}
      Voice unavailable
    {:else}
      {$live.value.freshness === "frozen" ? "Frozen" : "Observed"} · {$live.value.ageMs / 1000} s old
    {/if}
  </p>
  {#if view.audience === "guest" && $live.value && "count" in $live.value}
    <p data-testid="guest-count">{$live.value.count} in voice</p>
  {:else if view.audience === "member" && $live.value && "rooms" in $live.value}
    <ul aria-label="Visible rooms">
      {#each $live.value.rooms as room (room.name)}
        <li>{room.name} ({room.count}): {room.occupants.join(", ")}</li>
      {/each}
    </ul>
  {/if}
</main>
