// Acceptance (fail-first): event-detail decorative reads fail open, Kit twin.
//
// resolveKitEventDetail must stay ok/200 when the neighbors or related store
// read throws, degrading only that model slice while every viewer slice stays
// intact. Viewer reads (attendees, answer, waitlist) keep failing closed by
// propagating the throw. Hermetic store fakes; no database, no network.
//
// Owned by the acceptance card; the Builder implements on this branch and
// never edits this file. Degraded shape (Builder contract): a throwing
// neighbors read resolves to { previous: null, next: null }; a throwing
// related read resolves to []. Viewer reads are untouched: any throw there
// still rejects.
import { describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import type { KitRequestSession } from "../src/kit-session";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import type {
  EventAttendee,
  EventLink,
  EventNeighbors,
  PublicEvent,
  ViewerRsvp,
} from "../src/events/reads";

const APP_URL = "https://next.example.test";
const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PREV_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAD";
const NEXT_KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAW";
const MEMBER_ID = "100000000000000001";

function link(over: Partial<EventLink> & { eventKey: string }): EventLink {
  return {
    id: 9,
    title: "Chess finals",
    startsAt: new Date("2030-02-01T19:00:00Z"),
    timezone: "UTC",
    location: "The lobby",
    ...over,
  };
}

const EVENT = {
  id: 7,
  icsSequence: 4n,
  eventKey: KEY,
  title: "Chess night",
  description: "Bring a friend & a board.",
  game: "Chess",
  startsAt: new Date("2030-01-10T20:00:00Z"),
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "The lobby",
  capacity: 10,
  status: "published",
  rsvpOpen: true,
  goingCount: 3,
  goingOccupancy: 3,
} as PublicEvent;

const NEIGHBORS: EventNeighbors = {
  previous: link({ eventKey: PREV_KEY, title: "Chess warm-up", id: 6 }),
  next: link({ eventKey: NEXT_KEY, title: "Chess finals", id: 9 }),
};
const RELATED: EventLink[] = [link({ eventKey: NEXT_KEY, title: "Chess finals", id: 9 })];
const ATTENDEES: EventAttendee[] = [
  { id: "100000000000000003", name: "ann" },
  { id: "100000000000000004", name: "bob" },
];
const ANSWER: ViewerRsvp = { status: "going", syncedToDiscordAt: null };

const MEMBER: KitRequestSession = {
  status: "authenticated",
  session: { userId: MEMBER_ID, username: "member", avatar: null, member: true, moderator: false },
};

type ThrowKeys = "neighbors" | "related" | "attendees" | "answer" | "waitlist";

function fakeStore(throwOn?: ThrowKeys): KitEventDetailStore {
  const fail = (name: ThrowKeys) => {
    if (throwOn === name) throw new Error(`${name} down`);
  };
  return {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => EVENT,
    neighborsFn: vi.fn(async () => {
      fail("neighbors");
      return NEIGHBORS;
    }),
    relatedFn: vi.fn(async () => {
      fail("related");
      return RELATED;
    }),
    attendeesFn: vi.fn(async () => {
      fail("attendees");
      return ATTENDEES;
    }),
    viewerRsvpFn: vi.fn(async () => {
      fail("answer");
      return ANSWER;
    }),
    waitlistFn: vi.fn(async () => {
      fail("waitlist");
      return null;
    }),
    suggestionsFn: async () => [],
  };
}

async function resolve(store: KitEventDetailStore) {
  const seen: Record<string, string>[] = [];
  const outcome = await resolveKitEventDetail({
    key: KEY,
    search: "",
    path: `/e/${KEY}`,
    env: { APP_URL } as unknown as Env,
    session: MEMBER,
    joinResult: null,
    setHeaders: (headers) => seen.push(headers),
    store,
  });
  return { outcome, seen };
}

describe("event-detail decorative fail-open (Kit twin)", () => {
  it("neighbors throw: stays ok with viewer slices intact and null neighbors", async () => {
    const store = fakeStore("neighbors");
    const { outcome, seen } = await resolve(store);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.status).toBe(200);
    expect(outcome.headers).toMatchObject({ "cache-control": "private, no-store", vary: "Cookie" });
    expect(seen).toHaveLength(1);
    // Degraded slice only: null neighbors.
    expect(outcome.model.neighbors).toEqual({ previous: null, next: null });
    // Intact slices: viewer reads and the independent related rail.
    expect(outcome.model.related.map((item) => item.key)).toEqual([NEXT_KEY]);
    expect(outcome.model.attendees).toEqual(ATTENDEES);
    expect(outcome.model.answer).toEqual(ANSWER);
    expect(outcome.model.waitlistPosition).toBeNull();
    expect(outcome.model.eventKey).toBe(KEY);
    expect(outcome.model.title).toBe("Chess night");
    expect(outcome.model.viewerMember).toBe(true);
    expect(outcome.model.showJoinPitch).toBe(false);
    expect(store.neighborsFn).toHaveBeenCalledTimes(1);
    expect(store.relatedFn).toHaveBeenCalledTimes(1);
  });

  it("related throw: stays ok with viewer slices and neighbors intact", async () => {
    const store = fakeStore("related");
    const { outcome, seen } = await resolve(store);
    expect(outcome.kind).toBe("ok");
    if (outcome.kind !== "ok") throw new Error("unreachable");
    expect(outcome.status).toBe(200);
    expect(seen).toHaveLength(1);
    // Degraded slice only: empty related rail.
    expect(outcome.model.related).toEqual([]);
    // Intact slices: viewer reads and the full two-sided neighbors.
    expect(outcome.model.neighbors.previous?.key).toBe(PREV_KEY);
    expect(outcome.model.neighbors.next?.key).toBe(NEXT_KEY);
    expect(outcome.model.attendees).toEqual(ATTENDEES);
    expect(outcome.model.answer).toEqual(ANSWER);
    expect(outcome.model.waitlistPosition).toBeNull();
    expect(store.neighborsFn).toHaveBeenCalledTimes(1);
    expect(store.relatedFn).toHaveBeenCalledTimes(1);
  });
});

describe("event-detail viewer reads stay closed (Kit twin)", () => {
  it("attendees throw: still rejects instead of degrading", async () => {
    const store = fakeStore("attendees");
    await expect(resolve(store)).rejects.toThrow("attendees down");
    expect(store.attendeesFn).toHaveBeenCalledTimes(1);
  });

  it("answer throw: still rejects instead of degrading", async () => {
    const store = fakeStore("answer");
    await expect(resolve(store)).rejects.toThrow("answer down");
    expect(store.viewerRsvpFn).toHaveBeenCalledTimes(1);
  });

  it("waitlist throw: still rejects instead of degrading", async () => {
    const store = fakeStore("waitlist");
    await expect(resolve(store)).rejects.toThrow("waitlist down");
    expect(store.waitlistFn).toHaveBeenCalledTimes(1);
  });
});
