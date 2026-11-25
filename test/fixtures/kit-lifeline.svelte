<script lang="ts">
import { withEventDetailHtml } from "../../src/events/detail-leaves";
import type { KitEventDetailModel } from "../../src/events/kit-detail";
import EventDetail from "../../web/src/lib/EventDetail.svelte";
import EventLayout from "../../web/src/routes/e/[key]/+layout.svelte";
import { composeLifeline, type LifelineFacts } from "../../web/src/lib/lifeline";

let {
  state,
  showLifeline = true,
  attendeePage = 2,
  savedSeat = false,
  echo,
}: {
  state: "upcoming" | "frozen" | "cancelled" | "ended";
  showLifeline?: boolean;
  attendeePage?: 1 | 2;
  savedSeat?: boolean;
  echo?: LifelineFacts["echo"];
} = $props();

const eventKey = "fixture-raid";
const path = `/e/${eventKey}`;
const secondPage = `${path}?attendees=2`;
const time = (clock: string) => Date.parse(`2026-11-21T${clock}:00Z`);
const iso = (clock: string) => new Date(time(clock)).toISOString();
const fact = (clock: string) => ({ eventKey, at: time(clock) });
const schedule = { eventKey, startsAt: time("20:00"), endsAt: time("21:00") };
const viewerRsvp = fact("18:23");
const terminalSiteReminder = { ...fact("19:32"), sent: 8, unavailable: 2 };
const roomSnapshot = { observedAt: time("20:00"), fetchFailed: false, eventKeys: [eventKey] };
const cancelled = { ...fact("20:01"), reason: "The host cancelled because of severe weather." };
const examples = {
  upcoming: { now: time("19:00"), facts: {} },
  frozen: { now: time("20:12"), facts: { terminalSiteReminder, roomSnapshot } },
  cancelled: { now: time("20:12"), facts: { viewerRsvp, cancelled, roomSnapshot } },
  ended: { now: time("21:50"), facts: { terminalSiteReminder } },
} satisfies Record<typeof state, { now: number; facts: LifelineFacts }>;
const ended = $derived(state === "ended");

const _model: KitEventDetailModel = $derived(
  withEventDetailHtml({
    seatCard: {
      heading: state === "upcoming" || state === "frozen" ? "Your RSVP" : "RSVPs closed",
      tag: state === "frozen" ? { tone: "warn", text: "Paused" } : null,
      note: null,
    },
    eventKey,
    title: "Saturday co-op raid",
    game: "Guild Wars 2",
    description:
      "Bring a level 80 character. New raiders are welcome; we’ll explain each encounter before we start.",
    shareDescription: "A casual co-op raid for new and returning players.",
    accessibilityNotes: null,
    location: "Community Discord",
    directionsUrl: null,
    organizerName: "Raid hosts",
    joinUrl: null,
    joinInstructions: null,
    status: state === "cancelled" ? "cancelled" : "published",
    isDraft: false,
    isPast: ended,
    isOngoing: state === "frozen",
    isEnded: ended,
    lifecycle: ended ? { date: "21 Nov 2026", endTime: "21:00" } : null,
    endedNext: null,
    liveTime: state === "frozen" ? { asOf: iso("20:12"), staleAt: iso("20:14") } : undefined,
    goingCount: 8,
    goingOccupancy: 8,
    capacity: 10,
    rsvpOpen: state === "upcoming",
    rsvpClosed: state === "cancelled" ? "cancelled" : ended ? "past" : null,
    canonical: `https://event-detail.example.test${path}`,
    path,
    attendeesRefreshHref: attendeePage === 2 ? secondPage : path,
    robots: null,
    icsUrl: `/events/${eventKey}.ics`,
    googleCalendarUrl: null,
    copyLink: `https://event-detail.example.test${path}`,
    whenText: "Sat, 21 Nov, 20:00",
    endsWhenText: "Sat, 21 Nov, 21:00",
    durationText: "1h",
    zoneLabel: "Europe/London",
    timeDatetime: iso("20:00"),
    attendees: attendeePage === 1 ? [{ id: "1", name: "Fixture attendee" }] : [],
    attendeesPaging: {
      page: attendeePage,
      prevHref: attendeePage === 2 ? path : null,
      nextHref: attendeePage === 1 ? secondPage : null,
    },
    answer: savedSeat ? { status: "going", syncedToDiscordAt: null } : null,
    waitlistPosition: null,
    neighbors: { previous: null, next: null },
    related: [],
    series: null,
    showJoinPitch: false,
    joinReturnTo: path,
    joinResult: null,
    viewerAuthenticated: true,
    viewerMember: true,
    viewerModerator: false,
    viewerUsername: "Fixture player",
    endsAt: iso("21:00"),
    jsonLd: "{}",
    siteJsonLd: "{}",
  } satisfies Omit<KitEventDetailModel, "detailHtml">),
);

const _steps = $derived(
  showLifeline
    ? composeLifeline(
        { ...schedule, rsvpOpen: state === "upcoming" },
        {
          opened: fact("18:00"),
          ...(savedSeat ? { viewerRsvp } : {}),
          ...examples[state].facts,
          echo,
        },
        examples[state].now,
      )
    : undefined,
);
</script>

<EventLayout><EventDetail model={_model} lifeline={_steps} /></EventLayout>
