<script lang="ts">
import { onMount } from "svelte";
import { z } from "zod";
import { createBrowserLiveTopic } from "../../src/live/browser-topic";
import { createLiveTopic } from "../../src/live/client-topic";

const memberProjection = z.strictObject({
  rooms: z.array(
    z.strictObject({
      name: z.string(),
      count: z.number().int().nonnegative(),
      occupants: z.array(z.string()),
    }),
  ),
});
const memberFrame = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("unavailable") }),
  z.strictObject({
    kind: z.enum(["snapshot", "patch"]),
    seq: z.number().int().positive(),
    value: memberProjection,
  }),
]);

export let view:
  | { audience: "guest"; snapshot: { count: number | null } | null }
  | { audience: "member"; snapshot: z.infer<typeof memberProjection> };

async function readProjection(audience: typeof view.audience, signal: AbortSignal) {
  const response = await fetch(`/__fixture_${audience}_projection__`, {
    redirect: "error",
    signal,
  });
  return response.ok && response.status !== 204 ? response.json() : null;
}

// The member projection exercises the shared store on its own synthetic socket.
const live =
  view.audience === "guest"
    ? createBrowserLiveTopic(view.snapshot, (signal) => readProjection("guest", signal))
    : createLiveTopic(view.snapshot, {
        open: () => new WebSocket("wss://live-client-fixture.test/__fixture_member_socket__"),
        command: (socket, type) => socket.send(JSON.stringify({ type })),
        decode: (data) => memberFrame.parse(JSON.parse(String(data))),
        async poll(signal) {
          const value = await readProjection("member", signal);
          return value === null ? null : memberProjection.parse(value);
        },
      });

onMount(() => live.start());
</script>

<main aria-label="Synthetic voice projection">
  <p role="status" data-source={$live.source}>
    {#if $live.value === null}
      Voice unavailable
    {:else if $live.source === "poll"}
      Voice data may be a few seconds old
    {:else}
      Voice observed
    {/if}
  </p>
  {#if view.audience === "guest" && $live.value && "count" in $live.value}
    {#if $live.value.count === null}
      <p>Voice count withheld</p>
    {:else}
      <p data-testid="guest-count">{$live.value.count} in voice</p>
    {/if}
  {:else if view.audience === "member" && $live.value && "rooms" in $live.value}
    <ul aria-label="Visible rooms">
      {#each $live.value.rooms as room (room.name)}
        <li>{room.name} ({room.count}){room.occupants.length ? `: ${room.occupants.join(", ")}` : ""}</li>
      {/each}
    </ul>
  {/if}
</main>
