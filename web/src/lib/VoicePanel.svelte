<script lang="ts">
import MembersDirectoryAvatar from "./MembersDirectoryAvatar.svelte";
import { freshnessLabel, visibleCount, type VoiceView } from "./voice-view";

let { view }: { view: VoiceView } = $props();
const heading = $props.id();
let frozen = $derived(view.snapshot?.freshness === "frozen");
</script>

<aside aria-labelledby={heading} class:frozen>
  <div class="panel-head">
    <h2 id={heading}>{view.snapshot && !frozen ? "In voice now" : "Voice rooms"}</h2>
    {#if view.snapshot && frozen}<p>{freshnessLabel(view.snapshot)}</p>{/if}
  </div>
  {#if !view.snapshot}
    <p class="note">Voice numbers are not available right now.</p>
  {:else if view.audience === "guest"}
    <p class="note count">{view.snapshot.count} in voice{frozen ? " at last sync" : ""}</p>
  {:else if view.snapshot.rooms.length === 0}
    <p class="note">No voice rooms to show.</p>
  {:else}
    {@const count = visibleCount(view.snapshot.rooms)}
    {#if count === 0}
      <p class="note">{frozen ? "The rooms you can see were quiet." : "It's quiet in the rooms you can see."}</p>
    {:else}
      <p class="note count">{view.snapshot.rooms.length} visible {view.snapshot.rooms.length === 1 ? "room" : "rooms"} · {count} {count === 1 ? "person" : "people"}</p>
    {/if}
    <ul class="rooms" role="list">
      {#each view.snapshot.rooms as room}
        <li class="room">
          <div>
            <h3>{room.name}</h3>
            <p class="count">{room.count} {room.count === 1 ? "person" : "people"}</p>
          </div>
          {#if room.occupants.length > 0}
            <ul class="avatars" role="list" aria-label="Members sharing their names">
              {#each room.occupants.slice(0, 4) as occupant}
                <li title={occupant.name}>
                  <MembersDirectoryAvatar name={occupant.name} src={occupant.avatarUrl} compact />
                  <span class="visually-hidden">{occupant.name}</span>
                </li>
              {/each}
              {#if room.occupants.length > 4}
                <li class="count">+{room.occupants.length - 4} more</li>
              {/if}
            </ul>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</aside>

<style>
  aside { padding: var(--two-radius-s); border: 1px solid var(--two-color-line-hairline); border-radius: var(--two-radius-l); background: var(--two-color-bg-surface); color: var(--two-color-text-primary); overflow-wrap: anywhere; }
  .panel-head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: var(--two-space-2); padding: var(--two-space-inset-room); }
  h2, h3, p { margin: 0; }
  h2 { font-size: var(--two-font-size-ui); }
  h3 { font-size: var(--two-font-size-body); }
  h2, h3 { font-weight: var(--two-font-weight-semibold); text-transform: none; letter-spacing: normal; }
  .note { padding: 0 var(--two-space-inset-room) var(--two-space-inset-room); }
  .panel-head p, .count { color: var(--two-color-text-secondary); font: var(--two-font-size-label)/var(--two-line-height-label) var(--two-font-data); }
  ul { padding: 0; margin: 0; list-style: none; }
  .room { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--two-space-2); padding: var(--two-space-inset-room); border-radius: var(--two-radius-m); }
  .room:nth-child(odd) { --room-ground: var(--two-color-bg-raised); background: var(--room-ground); }
  .avatars { display: flex; align-items: center; }
  .avatars li + li { margin-inline-start: calc(-1 * var(--two-space-2)); }
  .avatars :global(.directory-avatar), .avatars .count {
    inline-size: var(--two-size-avatar-xs);
    block-size: var(--two-size-avatar-xs);
    border-radius: var(--two-radius-pill);
    box-shadow: 0 0 0 var(--two-size-box-stroke) var(--room-ground, var(--two-color-bg-surface));
  }
  .avatars :global(.directory-avatar) { font-size: 0; }
  .avatars .count { display: grid; place-items: center; inline-size: auto; padding-inline: var(--two-space-2); background: var(--two-color-bg-overlay); }
  .frozen .count { color: var(--two-color-text-tertiary); }
  .frozen .avatars { filter: grayscale(1); }
  .visually-hidden { position: absolute; inline-size: 1px; block-size: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  @media (forced-colors: active) { aside { border-color: CanvasText; } }
</style>
