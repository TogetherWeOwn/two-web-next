import type { PublicEvent } from "../../src/events/reads";
import type { CalendarState, DiscordTransient } from "../../src/islands/contracts";
import type { KitEventsLoadData } from "../../src/kit-events";

export const cancellationState: CalendarState = {
  view: "calendar",
  month: "2099-01",
  q: "",
  past: true,
  page: 1,
};
export const cancellationPath = "/events?view=calendar&month=2099-01&past=1";

export function cancellationEvent(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const startsAt = new Date("2099-01-15T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAA",
    title: "Chess night",
    game: null,
    description: null,
    startsAt,
    endsAt: new Date("2099-01-15T22:00:00Z"),
    timezone: "Europe/London",
    location: "Chess room",
    capacity: 100,
    status: "cancelled",
    rsvpOpen: true,
    goingCount: 73,
    goingOccupancy: 73,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: startsAt,
    updatedAt: startsAt,
    ...overrides,
  };
}

export const publishedScheduleEvent = (): PublicEvent =>
  cancellationEvent({
    id: 2,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAB",
    title: "Published chess",
    status: "published",
    startsAt: new Date("2099-01-17T20:00:00Z"),
    endsAt: new Date("2099-01-17T22:00:00Z"),
    capacity: null,
    goingCount: 7,
    goingOccupancy: 7,
  });

export const discordScheduleEvent = (): DiscordTransient => ({
  discordId: "123456789012345678",
  status: "scheduled",
  title: "Discord chess",
  description: null,
  location: null,
  startsAt: new Date("2099-01-16T20:00:00Z"),
  endsAt: new Date("2099-01-16T22:00:00Z"),
});

export function cancellationData(member = false): KitEventsLoadData {
  return {
    state: { ...cancellationState },
    upcoming: [cancellationEvent(), discordScheduleEvent(), publishedScheduleEvent()],
    past: [
      cancellationEvent({
        id: 3,
        eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAC",
        title: "Past cancelled chess",
        startsAt: new Date("2020-01-15T20:00:00Z"),
        endsAt: new Date("2020-01-15T22:00:00Z"),
      }),
    ],
    zone: "Europe/London",
    now: new Date("2099-01-01T12:00:00Z"),
    totalPages: 1,
    emptyState: null,
    discordFailed: false,
    member,
    moderator: false,
    inviteUrl: "https://discord.gg/example",
    appUrl: "https://next.example.test",
    canonical: "https://next.example.test/events?view=calendar&month=2099-01&past=1",
    loginReturnTo: cancellationPath,
    joinResult: null,
    queryTooLong: false,
  };
}

export function renderedCard(html: string, key: string): string {
  return (
    html.match(
      new RegExp(`<article\\b[^>]*data-event-key="${key}"[^>]*>[\\s\\S]*?</article>`),
    )?.[0] ?? ""
  );
}

export function renderedText(html: string): string {
  return html
    .replace(/<[^>]*>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
