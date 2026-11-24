<script lang="ts">
import { loginUrl, RSVP_CTA_COPY, RSVP_GUEST_CTA_COPY } from "../../src/islands/contracts-rsvp-button";
import Button from "../../web/src/lib/Button.svelte";
import EmberShell from "../../web/src/lib/EmberShell.svelte";
import EventVoicePlacement from "../../web/src/lib/EventVoicePlacement.svelte";
import SiteMetadata from "../../web/src/lib/SiteMetadata.svelte";
import type { VoiceView } from "../../web/src/lib/voice-view";
import { voiceViews } from "./kit-voice-views";

const { state }: { state: string | null } = $props();
const event = voiceViews.member.liveEvent;
const path = `/e/${event.key}`;
const { view: memberView } = voiceViews.member;
const otherEventRoom = {
  name: "Friday Raid lobby",
  count: 2,
  occupants: [{ name: "Cedar" }],
  eventKey: "friday-raid",
};
type Fixture = { member: boolean; enabled?: boolean; view?: VoiceView };
const beforeGuest: Fixture = { member: false, enabled: true };
const cases: Record<string, Fixture> = {
  beforeGuest,
  beforeMember: { member: true, view: voiceViews.member.view },
  guest: { member: false, enabled: true, view: voiceViews.guest.view },
  member: {
    member: true,
    enabled: true,
    view: {
      ...memberView,
      snapshot: { ...memberView.snapshot, rooms: [...memberView.snapshot.rooms, otherEventRoom] },
    },
  },
  suppressed: { member: false, enabled: true, view: voiceViews.absent.view },
  unrelated: {
    member: true,
    enabled: true,
    view: { ...memberView, snapshot: { ...memberView.snapshot, rooms: [otherEventRoom] } },
  },
  unlinkedOnly: { member: true, enabled: true, view: voiceViews.quiet.view },
  frozen: { member: true, enabled: true, view: voiceViews.frozen.view },
};
const fixture = $derived(state && Object.hasOwn(cases, state) ? cases[state] ?? beforeGuest : beforeGuest);
</script>

<SiteMetadata title={event.title} theme="event" />
<EmberShell activeNav="event" member={fixture.member} authenticated={fixture.member} menuFallbackOnly>
  <div class="event-placement">
    <div class="event-composition">
      <div class="event-overview">
        <a href="/events">← All events</a>
        <h1>{event.title}</h1>
        <p><time datetime="2026-10-22T19:00:00Z">Thu 22 Oct, 19:00 UTC</time></p>
      </div>
      <div class="event-rail">
        <section class="seat-card" aria-labelledby="seat-heading">
          <h2 id="seat-heading">Save a seat</h2>
          {#if fixture.member}
            <form method="post" action="{path}/rsvp">
              <Button variant="primary" type="submit" fullWidth>{RSVP_CTA_COPY}</Button>
            </form>
          {:else}
            <Button variant="primary" href={loginUrl(path)} fullWidth>{RSVP_GUEST_CTA_COPY}</Button>
          {/if}
          <a href="/events/{event.key}.ics">Add to calendar</a>
        </section>
        <dl class="event-facts">
          <div><dt>Game</dt><dd>Deep Rock Galactic</dd></div>
        </dl>
        <EventVoicePlacement enabled={fixture.enabled} eventKey={event.key} view={fixture.view} />
      </div>
      <section class="event-about">
        <h2>About this event</h2>
        <p>Meet in the lobby at 19:00 for a casual co-op night.</p>
        <a href="/events">See more events</a>
      </section>
    </div>
  </div>
</EmberShell>

<style>
  .event-placement { container-type: inline-size; }
  .event-composition, .event-rail { display: grid; gap: var(--space-4); }
  .event-overview { grid-area: overview; }
  .event-overview h1 { margin: var(--space-4) 0; font-size: var(--text-h1); }
  .event-rail { grid-area: rail; min-inline-size: 0; }
  .event-about { grid-area: about; }
  .event-composition { grid-template-areas: "overview" "rail" "about"; }
  .seat-card, .event-facts {
    background: var(--color-g2);
    border-radius: var(--radius-l);
    padding: var(--space-inset-card);
  }
  .seat-card { display: grid; gap: var(--space-3); }
  .seat-card h2, .event-facts, .event-facts dd { margin: 0; }
  .seat-card h2, .event-about h2 { font-size: var(--text-title); }
  .event-facts div { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--space-2); }
  .event-facts dt { color: var(--color-t3); font-family: var(--font-data); }
  @container (min-width: 740px) {
    .event-composition {
      grid-template-columns: minmax(0, 1fr) var(--two-layout-rail-seat);
      grid-template-areas: "overview rail" "about rail";
      column-gap: var(--space-9);
      align-items: start;
    }
  }
</style>
