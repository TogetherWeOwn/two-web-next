<script lang="ts">
import {
  EVENTS_EMPTY_COPY,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  cardTimeLabel,
  goingCountText,
  loginUrl,
  wallTimeHm,
  type DiscordTransient,
} from "../../../src/islands/contracts";
import {
  isTransient,
  rowKey,
  rowLocation,
  rowTitle,
  rowZone,
  type CalRow,
} from "../../../src/events/pages-calendar-row";
import type { PublicEvent } from "../../../src/events/reads";

// Same markup contract as CalCard in src/events/pages-calendar-card.tsx:
// guests get the sign-in link, Discord-native rows get "RSVP in Discord" and
// no going count, cancelled rows keep their title as plain text, and past
// rows suppress the action area entirely.
let {
  e,
  zone,
  isPast,
  member,
  inviteUrl,
  loginReturnTo,
}: {
  e: CalRow;
  zone: string;
  isPast: boolean;
  member: boolean;
  inviteUrl: string;
  loginReturnTo: string | null;
} = $props();

const tz = $derived(rowZone(e, zone));
const transient = $derived(isTransient(e) ? (e as DiscordTransient) : null);
const persisted = $derived(!isTransient(e) ? (e as PublicEvent) : null);
const location = $derived(rowLocation(e));

function dateParts(date: Date, zone: string): { month?: string; day?: string } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: zone,
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      timeZone: "UTC",
    }).formatToParts(date);
  }
  return {
    month: parts.find((p) => p.type === "month")?.value,
    day: parts.find((p) => p.type === "day")?.value,
  };
}
const badge = $derived(dateParts(e.startsAt, tz));
</script>

<li>
  <!-- svelte-ignore a11y_no_noninteractive_tabindex: the card is the focus
    target of grid day-jump links (#event-key), exactly as on the Hono page. -->
  <article
    class="schedule-row"
    id={`event-${rowKey(e)}`}
    data-event-key={rowKey(e)}
    data-testid={EVENT_CARD_TESTID}
    tabindex="-1"
  >
    <span class="schedule-date" aria-hidden="true">
      <span>{badge.month}</span><strong>{badge.day}</strong>
    </span>
    <div class="schedule-info">
      <h3>
        {#if transient || persisted?.status === "cancelled"}
          {rowTitle(e)}
        {:else}
          <a href={`/e/${persisted?.eventKey}`}>{rowTitle(e)}</a>
        {/if}
      </h3>
      {#if persisted?.game}<p>{persisted.game}</p>{/if}
      {#if persisted?.status === "draft"}
        <span class="schedule-badge" data-testid={EVENT_DRAFT_TESTID}>Draft</span>
      {/if}
      {#if persisted?.status === "cancelled"}
        <span class="schedule-badge" data-testid={EVENT_CANCELLED_TESTID}>Cancelled</span>
      {/if}
      <p>
        <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, tz)}</time>
        {#if e.endsAt}
          {" · "}<span>{wallTimeHm(e.endsAt, tz)}</span>
        {/if}
        {" "}<span>{tz}</span>
        {#if location}
          {" · "}<span>{location}</span>
        {/if}
      </p>
      {#if e.description}<p>{e.description}</p>{/if}
    </div>
    <div class="schedule-actions">
      {#if persisted}
        <span class="schedule-attendance" data-testid="event-going-count">
          {goingCountText(persisted.goingCount, persisted.capacity)}
        </span>
      {/if}
      {#if !isPast}
        {#if transient}
          <a href={inviteUrl} data-testid={EVENT_DISCORD_RSVP_TESTID}>
            {EVENTS_EMPTY_COPY.discordRsvp}
          </a>
        {:else if !member}
          <a href={loginUrl(loginReturnTo)} data-testid="signin">
            {EVENTS_EMPTY_COPY.signIn}
          </a>
        {/if}
      {/if}
    </div>
  </article>
</li>
