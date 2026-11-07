import { jsx } from "hono/jsx/jsx-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Db } from "../src/db/index";
import type { Env } from "../src/env";
import { EventMetadata, withEventDetailHtml } from "../src/events/detail-leaves";
import { resolveKitEventDetail, type KitEventDetailStore } from "../src/events/kit-detail";
import { ATTENDEE_PAGE_SIZE, type PublicEvent } from "../src/events/reads";
import type { KitSession } from "../src/kit-session";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const now = new Date("2030-01-10T20:00:00Z");
const member: KitSession = {
  userId: "100000000000000001",
  username: "Moderator",
  avatar: null,
  member: true,
  moderator: true,
};
const event: PublicEvent = {
  id: 7,
  icsSequence: 4n,
  eventKey: KEY,
  title: "Chess night",
  game: "Chess",
  description: "Bring a board.",
  startsAt: now,
  endsAt: new Date("2030-01-10T22:00:00Z"),
  timezone: "UTC",
  location: "Hall",
  capacity: 10,
  status: "published",
  rsvpOpen: true,
  goingCount: 0,
  goingOccupancy: 0,
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
  createdAt: now,
  updatedAt: now,
};

async function resolve(
  overrides: Partial<PublicEvent> = {},
  viewer: KitSession | null = member,
  search = "",
) {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  const store: KitEventDetailStore = {
    dbForFn: async () => ({}) as Db,
    getEventFn: async () => ({ ...event, ...overrides }),
    neighborsFn: async () => ({ previous: null, next: null }),
    relatedFn: async () => [],
    seriesFn: async () => null,
    attendeesFn: vi.fn(async () =>
      Array.from({ length: ATTENDEE_PAGE_SIZE + 1 }, (_, n) => ({
        id: `owner-${n}`,
        name: `<img src=x>${n}`,
      })),
    ),
    viewerRsvpFn: vi.fn(async () => null),
    waitlistFn: async () => null,
    suggestionsFn: async () => [],
  };
  const outcome = await resolveKitEventDetail({
    key: KEY,
    path: `/e/${KEY}`,
    search,
    env: { APP_URL: "https://next.example.test" } as Env,
    session: viewer
      ? { status: "authenticated", session: viewer }
      : { status: "guest", session: null },
    joinResult: null,
    setHeaders: () => {},
    store,
  });
  if (outcome.kind !== "ok") throw new Error(`Expected detail, got ${outcome.kind}`);
  return { model: outcome.model, store };
}

afterEach(() => vi.useRealTimers());

describe("shared event detail server leaves", () => {
  it.each([null, { ...member, member: false }])(
    "keeps member rows out of guest/nonmember HTML",
    async (viewer) => {
      const { model, store } = await resolve({}, viewer);
      expect(store.attendeesFn).not.toHaveBeenCalled();
      expect(store.viewerRsvpFn).not.toHaveBeenCalled();
      expect(model.attendees).toEqual([]);
      expect(model.detailHtml.roster).not.toContain("owner-");
      expect(model.detailHtml.roster).toContain(
        viewer ? "event-roster-members-only" : "event-roster-guest-nudge",
      );
      expect(model.detailHtml.rsvp).not.toContain("<form");
    },
  );

  it("escapes fields, slices lookahead and preserves paging/auth actions", async () => {
    const { model } = await resolve(
      { location: '<svg onload="bad">', organizer_name: "<script>host</script>" },
      member,
      "?attendees=2&bad=secret",
    );
    expect(model.detailHtml.metadata).toContain("&lt;svg");
    expect(model.detailHtml.metadata).toContain("&lt;script&gt;host&lt;/script&gt;");
    expect(model.detailHtml.roster).toContain("&lt;img src=x&gt;0");
    expect(model.detailHtml.roster).not.toMatch(/<(?:img|svg|script)\b/);
    expect(model.detailHtml.roster).toContain(`owner-${ATTENDEE_PAGE_SIZE - 1}`);
    expect(model.detailHtml.roster).not.toContain(`owner-${ATTENDEE_PAGE_SIZE}`);
    expect(model.detailHtml.roster).toContain(`href="/e/${KEY}?attendees=3"`);
    expect(model.detailHtml.roster).toContain("event-attendees-current-page");
    expect(model.detailHtml.roster).not.toContain("Who&#39;s going (");
    expect(model.detailHtml.rsvp).toContain(`action="/e/${KEY}/rsvp?attendees=2"`);
    expect(model.detailHtml.rsvp).toContain('data-login-url="/join/discord?next=%2Fe%2F');
    expect(model.detailHtml.rsvp).not.toContain("secret");
    const fallback = await resolve({}, member, "?attendees=2junk");
    expect(fallback.model.detailHtml.rsvp).toContain(`action="/e/${KEY}/rsvp"`);
  });

  it.each(["going", "waitlisted", "maybe", "not_going"])(
    "uses the shared focusable %s control after overrides",
    async (status) => {
      const { model } = await resolve();
      const html = withEventDetailHtml({
        ...model,
        answer: { status, syncedToDiscordAt: null },
        waitlistPosition: 2,
      }).detailHtml.rsvp;
      expect(html).toContain('tabindex="-1"');
      expect(html).toContain('name="status" value="withdraw"');
      expect(html).toContain(
        status === "going"
          ? "rsvp-confirmed"
          : status === "waitlisted"
            ? "waitlist-position"
            : `rsvp-${status === "maybe" ? "maybe" : "not-going"}`,
      );
      expect(html).toContain('data-island="rsvp-button"');
    },
  );

  it("uses occupancy, paused and server-end verdicts without a viewer clock", async () => {
    const full = await resolve({ goingCount: 1, goingOccupancy: 10 });
    expect(full.model.detailHtml.rsvp).toContain("waitlist-join");
    expect(full.model.detailHtml.metadata).toContain("1 of 10 going");
    const paused = await resolve({ rsvpOpen: false });
    expect(paused.model.detailHtml.rsvp).toContain("rsvp-paused");
    expect(paused.model.detailHtml.rsvp).not.toContain('type="submit"');
    const ended = await resolve({ endsAt: now });
    expect(ended.model.rsvpClosed).toBe("past");
    expect(ended.model.detailHtml.rsvp).toContain("rsvp-closed");
    expect(ended.model.detailHtml.rsvp).not.toContain("<form");
    expect(ended.model.detailHtml.metadata).not.toContain('data-testid="event-spots-left"');
    const open = await resolve();
    expect(open.model.rsvpClosed).toBeNull();
    expect(open.model.detailHtml.rsvp).toContain("data-rsvp-form");
    expect(open.model.detailHtml.rsvp).not.toContain("rsvp-closed");
    expect(open.model.detailHtml.metadata).toContain('data-testid="event-spots-left"');

    // Re-render the actual leaves after the viewer clock moves: the captured
    // server verdict governs, so neither leaf flips with the clock.
    vi.setSystemTime(new Date(0));
    expect(Date.now()).toBeLessThan(Date.parse(ended.model.endsAt));
    const endedAgain = withEventDetailHtml(ended.model).detailHtml;
    expect(endedAgain).toEqual(ended.model.detailHtml);
    expect(endedAgain.rsvp).toContain("rsvp-closed");
    expect(endedAgain.rsvp).not.toContain("<form");
    expect(endedAgain.metadata).not.toContain('data-testid="event-spots-left"');
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    expect(Date.now()).toBeGreaterThan(Date.parse(open.model.endsAt));
    const openAgain = withEventDetailHtml(open.model).detailHtml;
    expect(openAgain).toEqual(open.model.detailHtml);
    expect(openAgain.rsvp).toContain("data-rsvp-form");
    expect(openAgain.rsvp).not.toContain("rsvp-closed");
    expect(openAgain.metadata).toContain('data-testid="event-spots-left"');

    // Negative controls: the leaf does read the supplied verdict, so swapping
    // it (with the clock unchanged) flips both leaves.
    const forcedClosed = withEventDetailHtml({ ...open.model, rsvpClosed: "past" }).detailHtml;
    expect(forcedClosed.rsvp).toContain("rsvp-closed");
    expect(forcedClosed.rsvp).not.toContain("<form");
    expect(forcedClosed.metadata).not.toContain('data-testid="event-spots-left"');
    vi.setSystemTime(new Date(0));
    const forcedOpen = withEventDetailHtml({ ...ended.model, rsvpClosed: null }).detailHtml;
    expect(forcedOpen.rsvp).toContain("data-rsvp-form");
    expect(forcedOpen.rsvp).not.toContain("rsvp-closed");
    expect(forcedOpen.metadata).toContain('data-testid="event-spots-left"');
  });

  it("keeps review form-free and the cancelled hidden-row difference explicit", async () => {
    const { model } = await resolve({ status: "cancelled" }, member, "?review=1");
    expect(model.detailHtml.rsvp).toContain("RSVP is disabled in preview.");
    expect(model.detailHtml.rsvp).not.toContain("<form");
    expect(model.detailHtml.rsvp).not.toContain("data-island");
    expect(model.detailHtml.metadata).toContain("data-event-time-from-now");
    const hono = jsx(EventMetadata, {
      model,
      showTimeFromNow: false,
      showSpotsLeft: false,
    }).toString();
    expect(hono).not.toContain("data-event-time-from-now");
  });

  it("retains fallback times, wire-year text, timezone mounts and empty-roster copy", async () => {
    const { model } = await resolve({
      startsAt: new Date(NaN),
      endsAt: new Date(NaN),
      timezone: "Invalid/Zone",
    });
    const empty = withEventDetailHtml({ ...model, attendees: [] });
    expect(empty.detailHtml.metadata).toContain("Time unavailable");
    expect(empty.detailHtml.metadata).toContain("(UTC)");
    for (const mount of [
      "data-event-device-timezone",
      "data-event-chosen-timezone",
      "data-event-time-from-now",
    ]) {
      expect(empty.detailHtml.metadata).toContain(mount);
    }
    expect(empty.detailHtml.roster).toContain("No one is listed as going yet.");
    const wire = await resolve({
      startsAt: new Date("+010000-01-10T20:00:00Z"),
      endsAt: new Date("+010000-01-10T22:00:00Z"),
    });
    expect(wire.model.googleCalendarUrl).toBeNull();
    expect(wire.model.detailHtml.metadata).toContain("+010000-01-10T20:00:00.000Z");
  });
});
