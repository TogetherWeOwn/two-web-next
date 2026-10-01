import { describe, expect, it } from "vitest";
import {
  EVENTS_JSON_URL,
  GOING_COUNT_ISLAND,
  GOING_COUNT_TESTID,
  GOING_UPDATED_EVENT,
  ISLANDS,
  MOUNT_ATTR,
  POLLING,
  SPOTS_LEFT_TESTID,
  applyGoingRefresh,
  goingAnnouncementText,
  goingCountText,
  goingRefreshRequest,
  renderGoingCount,
  rsvpUrl,
  shouldRefreshGoing,
  spotsLeftText,
} from "../src/islands/contracts";

/**
 * TOG-9689 slice 1: GoingCount island drift tests.
 *
 * Each test pins one legacy behavior (two-web `app/Livewire/GoingCount.php`,
 * `going-count.blade.php`, `GoingCountTest.php`) re-expressed against the
 * islands contract: which requests fire, which states render.
 */

describe("going-count island contract", () => {
  it("renders the count against the cap", () => {
    const html = renderGoingCount("ulid-1", {
      going: 2,
      capacity: 4,
      showSpotsLeft: false,
      announcement: null,
    });
    expect(html).toContain("2 of 4 going");
    expect(html).toContain(`data-testid="${GOING_COUNT_TESTID}"`);
  });

  it("renders the count without inventing a cap", () => {
    const html = renderGoingCount("ulid-1", {
      going: 1,
      capacity: null,
      showSpotsLeft: false,
      announcement: null,
    });
    expect(html).toContain("1 going");
    expect(html).not.toContain("1 of");
  });

  it("announces updates politely, never as an alert", () => {
    const html = renderGoingCount("ulid-1", {
      going: 3,
      capacity: 4,
      showSpotsLeft: false,
      announcement: "going",
    });
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
    expect(html).toContain("You're going.");
  });

  it("announces nothing on first render so page load stays quiet", () => {
    const html = renderGoingCount("ulid-1", {
      going: 2,
      capacity: 4,
      showSpotsLeft: false,
      announcement: null,
    });
    const ann = html.match(/<span class="sr-only" data-announcement>(.*?)<\/span>/)?.[1];
    expect(ann ?? "").toBe("");
  });

  it("mounts on the shared mount attribute with an event-key binding", () => {
    const html = renderGoingCount("ulid-7", {
      going: 0,
      capacity: 4,
      showSpotsLeft: false,
      announcement: null,
    });
    expect(html).toContain(`${MOUNT_ATTR}="${GOING_COUNT_ISLAND}"`);
    expect(html).toContain('data-event-key="ulid-7"');
  });

  it("renders spots-left only when the shareable page asks, from the same numbers", () => {
    const withSpots = renderGoingCount("ulid-1", {
      going: 3,
      capacity: 4,
      showSpotsLeft: true,
      announcement: null,
    });
    expect(withSpots).toContain(`data-testid="${SPOTS_LEFT_TESTID}"`);
    expect(withSpots).toContain("1 of 4 spots left");

    const without = renderGoingCount("ulid-1", {
      going: 3,
      capacity: 4,
      showSpotsLeft: false,
      announcement: null,
    });
    expect(without).not.toContain(SPOTS_LEFT_TESTID);
  });

  it("renders Full rather than a negative seat count", () => {
    expect(spotsLeftText(4, 4)).toBe("Full");
    expect(spotsLeftText(9, 4)).toBe("Full");
  });

  it("names every writer outcome in the announcement", () => {
    expect(goingAnnouncementText("going")).toContain("You're going.");
    expect(goingAnnouncementText("waitlisted")).toContain("waitlist");
    expect(goingAnnouncementText("none")).toContain("removed");
    expect(goingAnnouncementText("other")).toBe("");
    expect(goingAnnouncementText(null)).toBe("");
  });
});

describe("going-count refresh discipline: requests fired", () => {
  it("fires exactly one GET against the frozen collection per answered event", () => {
    const req = goingRefreshRequest("ulid-1");
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${EVENTS_JSON_URL}?event_key=ulid-1`);
    expect(req.eventKey).toBe("ulid-1");
  });

  it("re-reads the aggregate for its own event only", () => {
    expect(shouldRefreshGoing("ulid-1", "ulid-1")).toBe(true);
    expect(shouldRefreshGoing("ulid-2", "ulid-1")).toBe(false);
  });

  it("picks its aggregate out of the collection and ignores a missing row", () => {
    const rows = [
      { event_key: "ulid-1", going_count: 3 },
      { event_key: "ulid-2", going_count: 9 },
    ];
    expect(applyGoingRefresh(rows, "ulid-1")).toBe(3);
    expect(applyGoingRefresh(rows, "ulid-9")).toBeNull();
  });

  it("broadcasts on the DOM CustomEvent name pinned in the contract", () => {
    expect(GOING_UPDATED_EVENT).toBe("going-count-updated");
  });
});

describe("explicit polling contract: every island pins poll-or-not", () => {
  it("registers all five islands", () => {
    expect([...ISLANDS].sort()).toEqual(
      ["events-calendar", "going-count", "member-profile", "past-events", "rsvp-button"].sort(),
    );
  });

  it("going-count has no read loop: event-driven refresh only", () => {
    expect(POLLING["going-count"].pollMs).toBeNull();
    expect(POLLING["going-count"].reason).toMatch(/going-count-updated/);
  });

  it("rsvp-button has no read loop: writes only against the singular resource", () => {
    expect(POLLING["rsvp-button"].pollMs).toBeNull();
    expect(rsvpUrl("EVT-1")).toBe("/events/EVT-1/rsvp");
  });

  it("no island polls silently: each states its budget or its reason not to", () => {
    for (const name of ISLANDS) {
      expect(POLLING[name].reason.length, name).toBeGreaterThan(20);
    }
  });
});

describe("count text never invents a cap", () => {
  it("formats with and without capacity", () => {
    expect(goingCountText(2, 4)).toBe("2 of 4 going");
    expect(goingCountText(1, null)).toBe("1 going");
  });
});
