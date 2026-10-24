// SvelteKit migration card 25/43: production wiring for the Kit event-detail
// read model. The hermetic suite pins the resolver through a fake store; this
// suite pins the real store delegates so the src/events/** function gate stays
// green (the wiring is nine functions that would otherwise read as uncovered).
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/admin/db", () => ({ dbFor: vi.fn() }));
vi.mock("../src/events/reads", () => ({
  ATTENDEE_PAGE_SIZE: 100,
  getPublicEvent: vi.fn(),
  getEventNeighbors: vi.fn(),
  listRelatedEvents: vi.fn(),
  listGoingAttendees: vi.fn(),
  nextAttendeePage: vi.fn(),
  getViewerRsvp: vi.fn(),
}));
vi.mock("../src/events/waitlist", () => ({ waitlistPosition: vi.fn() }));
vi.mock("../src/not-found-suggestions", () => ({ cachedNotFoundSuggestions: vi.fn() }));

import { dbFor } from "../src/admin/db";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import {
  getEventNeighbors,
  getPublicEvent,
  getViewerRsvp,
  listGoingAttendees,
  listRelatedEvents,
} from "../src/events/reads";
import { waitlistPosition } from "../src/events/waitlist";
import { cachedNotFoundSuggestions } from "../src/not-found-suggestions";
import { kitEventDetailStore } from "../src/events/kit-detail";

const env = { APP_URL: "https://next.example.test" } as unknown as Env;
const db = {} as Db;

describe("kit event-detail production store", () => {
  it("forwards each delegate to the Hono handler's twin read", async () => {
    const store = kitEventDetailStore(env);
    const event = { id: 7 } as Parameters<typeof getPublicEvent>[1] extends never
      ? never
      : Awaited<ReturnType<typeof getPublicEvent>>;
    vi.mocked(dbFor).mockResolvedValueOnce(db);
    await expect(store.dbForFn({ env })).resolves.toBe(db);
    expect(dbFor).toHaveBeenCalledWith({ env });

    vi.mocked(getPublicEvent).mockResolvedValueOnce(event);
    await expect(store.getEventFn(db, "key")).resolves.toBe(event);
    expect(getPublicEvent).toHaveBeenCalledWith(db, "key");

    const neighbors = { previous: null, next: null };
    vi.mocked(getEventNeighbors).mockResolvedValueOnce(
      neighbors as Awaited<ReturnType<typeof getEventNeighbors>>,
    );
    await expect(store.neighborsFn(db, { id: 7 } as { id: number })).resolves.toBe(neighbors);

    const related: Awaited<ReturnType<typeof listRelatedEvents>> = [];
    vi.mocked(listRelatedEvents).mockResolvedValueOnce(related);
    await expect(
      store.relatedFn(db, { id: 7, game: null } as { id: number; game: string | null }),
    ).resolves.toBe(related);

    const attendees: Awaited<ReturnType<typeof listGoingAttendees>> = [];
    vi.mocked(listGoingAttendees).mockResolvedValue(attendees);
    // The store concatenates the page and its one-row lookahead probe, so the
    // resolved array is a new reference holding both reads' rows.
    await expect(store.attendeesFn(db, 7, 1)).resolves.toEqual(attendees);

    const answer: Awaited<ReturnType<typeof getViewerRsvp>> = null;
    vi.mocked(getViewerRsvp).mockResolvedValueOnce(answer);
    await expect(store.viewerRsvpFn(db, 7, "user")).resolves.toBe(answer);

    vi.mocked(waitlistPosition).mockResolvedValueOnce(3);
    await expect(store.waitlistFn(db, 7, "user")).resolves.toBe(3);
    expect(waitlistPosition).toHaveBeenCalledWith(db, 7, "user");

    const suggestions: Awaited<ReturnType<typeof cachedNotFoundSuggestions>> = [];
    vi.mocked(cachedNotFoundSuggestions).mockResolvedValueOnce(suggestions);
    await expect(store.suggestionsFn(env, "/e/key")).resolves.toBe(suggestions);
    expect(cachedNotFoundSuggestions).toHaveBeenCalledWith(env, "/e/key");
  });

  it("answers no waitlist position without a signed-in viewer", async () => {
    const store = kitEventDetailStore(env);
    await expect(store.waitlistFn(db, 7, null)).resolves.toBeNull();
    expect(waitlistPosition).not.toHaveBeenCalled();
  });
});
