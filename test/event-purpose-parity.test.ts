import { describe, expect, it } from "vitest";
import { mdEvent, type MdEvent } from "../src/ai-friendly/md";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type { PublicEvent } from "../src/events/reads";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";

const appUrl = "https://example.test";
const startsAt = new Date("2030-01-10T20:00:00Z");
const endsAt = new Date("2030-01-10T22:00:00Z");
const eventKey = "01ARZ3NDEKTSV4RRFFQ69G5FAV";

const markdownEvent = (over: Partial<MdEvent> = {}): MdEvent => ({
  eventKey,
  title: "Chess night",
  game: "Chess",
  description: "Bring a friend & a board.",
  startsAt,
  endsAt,
  timezone: "UTC",
  location: "The lobby",
  capacity: null,
  goingCount: 3,
  goingOccupancy: 3,
  status: "published",
  ...over,
});

function publicEvent(purpose: string | null): PublicEvent {
  return {
    id: 7,
    icsSequence: 4n,
    eventKey,
    title: "Chess night",
    game: "Chess",
    description: "Bring a friend & a board.",
    purpose,
    startsAt,
    endsAt,
    timezone: "UTC",
    location: "The lobby",
    capacity: null,
    status: "published",
    rsvpOpen: true,
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
    goingCount: 3,
    goingOccupancy: 3,
  } as PublicEvent;
}

const guest: KitRequestSession = { status: "guest", session: null };

function kitStore(event: PublicEvent): KitEventDetailStore {
  return {
    dbForFn: async () => ({}) as never,
    getEventFn: async () => event,
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    attendeesFn: async () => [],
    viewerRsvpFn: async () => null,
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
}

async function resolve(purpose: string | null) {
  return resolveKitEventDetail({
    key: eventKey,
    search: "",
    path: `/e/${eventKey}`,
    env: { APP_URL: appUrl } as unknown as Env,
    session: guest,
    joinResult: null,
    setHeaders: () => {},
    store: kitStore(publicEvent(purpose)),
  });
}

describe("event purpose parity", () => {
  it("includes a labelled purpose in the Markdown event alternate", () => {
    const purpose = "A welcoming intro & [practice] <script>alert('x')</script>";
    const markdown = mdEvent(appUrl, markdownEvent({ purpose } as Partial<MdEvent>));
    expect(markdown).toContain("## Purpose");
    expect(markdown).toContain(
      "A welcoming intro & \\[practice\\] &lt;script&gt;alert('x')&lt;/script&gt;",
    );
    expect(markdown).toContain("## About this event");
  });

  it("carries purpose into the Kit event-detail presentation model", async () => {
    const purpose = "A welcoming intro for new players.";
    const outcome = await resolve(purpose);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("Expected event detail");
    expect(outcome.model).toHaveProperty("purpose", purpose);
  });

  it.each([null, "", " \t\n "])(
    "omits blank purpose from the Markdown alternate (%s)",
    (purpose) => {
      const markdown = mdEvent(appUrl, markdownEvent({ purpose } as Partial<MdEvent>));
      expect(markdown).not.toContain("## Purpose");
      expect(markdown).toContain("## About this event");
    },
  );
});
