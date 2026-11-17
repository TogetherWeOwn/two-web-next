<script lang="ts">
import {
  EVENTS_EMPTY_COPY,
  EVENT_CANCELLED_TESTID,
  EVENT_CARD_HOST_TESTID,
  EVENT_CARD_TESTID,
  EVENT_DISCORD_RSVP_TESTID,
  EVENT_DRAFT_TESTID,
  EVENT_ONGOING_TESTID,
  SCHEDULE_AVAILABILITY_TESTID,
  SPOTS_LEFT_TESTID,
  cardDayLabel,
  cardTimeLabel,
  existingResponsesText,
  goingCountText,
  loginUrl,
  spotsLeftText,
  wallDateIso,
  wallTimeHm,
} from "../../../src/islands/contracts";
import { effectiveZone } from "../../../src/events/date-format";
import { ONGOING_COPY } from "../../../src/events/ongoing";
import type { CalendarListCard, CalendarViewer } from "./calendar-list";

// Same markup contract as CalCard in src/events/pages-calendar-card.tsx. The
// zone-aware wall-clock labels are computed here from the instants; every
// verdict (availability, search spans) arrives already decided.
const DESCRIPTION_LIMIT = 240; // code points, never UTF-16 units

let {
  e,
  isPast,
  member,
  inviteUrl,
  loginReturnTo,
}: { e: CalendarListCard; isPast: boolean } & CalendarViewer = $props();

const transient = $derived(e.kind === "discord");
const cancelled = $derived(e.kind === "event" && e.status === "cancelled");
const draft = $derived(e.kind === "event" && e.status === "draft");
const tz = $derived(effectiveZone(e.zone));
const availability = $derived(e.availability);
const host = $derived(e.kind === "event" ? e.host.trim() : "");
const startDay = $derived(wallDateIso(e.startsAt, tz));
const endDay = $derived(e.endsAt ? wallDateIso(e.endsAt, tz) : null);
const endLabel = $derived.by(() => {
  if (!e.endsAt || endDay === null) return "";
  if (endDay === startDay) return wallTimeHm(e.endsAt, tz);
  // Drop the trailing "-MM-DD" only when the month and year also differ.
  const year = endDay.slice(0, -6) !== startDay.slice(0, -6) ? ` ${endDay.slice(0, -6)}` : "";
  return `${cardDayLabel(e.endsAt, tz)}${year}, ${wallTimeHm(e.endsAt, tz)}`;
});
const badge = $derived.by(() => {
  const options = { day: "2-digit", month: "short" } as const;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: tz }).formatToParts(
      e.startsAt,
    );
  } catch {
    parts = new Intl.DateTimeFormat("en-GB", { ...options, timeZone: "UTC" }).formatToParts(
      e.startsAt,
    );
  }
  return {
    month: parts.find((p) => p.type === "month")?.value,
    day: parts.find((p) => p.type === "day")?.value,
  };
});
// Hono never marks matches in the past drawer (isPast clears the query), so
// spans a caller leaves on a past card are ignored rather than rendered.
const titleSegments = $derived(isPast ? null : e.titleSegments);
const passage = $derived(isPast ? null : e.passage);
const descriptionPoints = $derived([...(e.description ?? "")]);
const full = $derived(
  e.kind === "event" &&
    !cancelled &&
    !isPast &&
    availability?.state !== "past" &&
    e.capacity !== null &&
    e.goingOccupancy >= e.capacity,
);
</script>

{#snippet marked(segments: { text: string; match: boolean }[])}{#each segments as part}{#if part.match}<mark>{part.text}</mark>{:else}{part.text}{/if}{/each}{/snippet}

<li>
  <article class="schedule-row" id={`event-${e.key}`} data-event-key={e.key} data-testid={EVENT_CARD_TESTID} tabindex="-1">
    <span class="schedule-date" aria-hidden="true"><span>{badge.month}</span><strong>{badge.day}</strong></span>
    <div class="schedule-info">
      <!-- Cancelled and transient rows have no detail page (410 / none), so the title is plain text. -->
      <h3>
        {#if e.kind === "event" && e.status !== "cancelled"}<a href={`/e/${e.eventKey}`}>{#if titleSegments}<span>{@render marked(titleSegments)}</span>{:else}{e.title}{/if}</a>{:else if titleSegments}<span>{@render marked(titleSegments)}</span>{:else}{e.title}{/if}
      </h3>
      {#if e.kind === "event" && e.game}<p>{e.game}</p>{/if}
      {#if host !== ""}<p data-testid={EVENT_CARD_HOST_TESTID}>Hosted by {host}</p>{/if}
      {#if draft}{" "}<span class="schedule-badge" data-testid={EVENT_DRAFT_TESTID}>Draft</span>{" "}{/if}
      {#if cancelled}{" "}<span class="schedule-badge" data-testid={EVENT_CANCELLED_TESTID}>Cancelled</span>{" "}{/if}
      {#if availability?.ongoing}{" "}<span class="schedule-badge" data-testid={EVENT_ONGOING_TESTID}>{ONGOING_COPY}</span>{" "}{/if}
      <p>
        <time datetime={e.startsAt.toISOString()}>{cardTimeLabel(e.startsAt, tz)}</time>{#if e.endsAt}{" · "}<time datetime={e.endsAt.toISOString()}>{endLabel}</time>{/if}{" "}<span>{tz}</span>{#if e.location}{" · "}<span>{e.location}</span>{/if}
      </p>
      {#if descriptionPoints.length > DESCRIPTION_LIMIT}
        <details class="schedule-text">
          <summary>
            <span class="schedule-excerpt">{#if passage}{@render marked(passage)}{:else}{`${descriptionPoints.slice(0, DESCRIPTION_LIMIT).join("")}…`}{/if}<br /></span>
            Full description
          </summary>
          <p>{e.description}</p>
        </details>
      {:else if e.description}
        <p class="schedule-text">{#if passage}{@render marked(passage)}{:else}{e.description}{/if}</p>
      {/if}
    </div>
    <div class="schedule-actions">
      {#if e.kind === "event"}
        <span class="schedule-attendance">
          <span data-testid="event-going-count">{cancelled ? existingResponsesText(e.goingCount) : goingCountText(e.goingCount, e.capacity)}{#if full && e.capacity !== null}{" · "}<span data-testid={SPOTS_LEFT_TESTID}>{spotsLeftText(e.goingOccupancy, e.capacity)}</span>{/if}</span>{#if !cancelled && availability && availability.state !== "full"}{" · "}<span data-testid={SCHEDULE_AVAILABILITY_TESTID}>{availability.text}</span>{/if}
        </span>
      {:else if availability}
        <span class="schedule-attendance" data-testid={SCHEDULE_AVAILABILITY_TESTID}>{availability.text}</span>
      {/if}{" "}
      {#if isPast}
        <!-- The past drawer never invites participation. -->
      {:else if transient}
        <a href={inviteUrl} data-testid={EVENT_DISCORD_RSVP_TESTID}>{EVENTS_EMPTY_COPY.discordRsvp}</a>
      {:else if !member && !cancelled}
        <a href={loginUrl(loginReturnTo)} data-testid="signin">{EVENTS_EMPTY_COPY.signIn}</a>
      {/if}
    </div>
  </article>
</li>
