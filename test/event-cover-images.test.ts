import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { FeaturedFormPage } from "../src/admin/pages";
import type { FeaturedRow } from "../src/admin/store";
import { EventGonePage, EventPage, EventsCalendarPage, PastEventsPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import type { CalendarEmptyState, CalendarState } from "../src/islands/contracts";

// TOG-12104: fail-closed cover-image layout tripwires (ports legacy TOG-7331,
// tests/Feature/Events/EventCoverImagesTest.php).
//
// Next matches the audited legacy premise: events carry no image/cover column
// (only featured_contents.image_url exists) and the calendar list, event
// detail, gone and archive surfaces render no <img> at all — they are
// text-only. These scans are tripwires in that style: if anyone adds a cover
// image to an event surface, the page-level scan goes red until the tag
// carries a reserved box (an aspect-ratio utility or explicit width+height).
// A text-only surface passes vacuously today; the presence assertions beside
// each scan prove the surface actually rendered, so the tripwire is never a
// pass over an empty page.
//
// Divergence from legacy: Next reserves the featured box with explicit
// width="640" height="360" (16:9) attributes, not an inline aspect-ratio:16/9
// style. The scan accepts either; the preview test below pins the dimensions.
//
// DB-free: renders the real page shells directly, no database or network.

function imgTags(html: string): string[] {
  return html.match(/<img\b[^>]*>/g) ?? [];
}

function tagHasBox(tag: string): boolean {
  return (
    tag.includes("aspect-video") ||
    tag.includes("aspect-[") ||
    tag.includes("aspect-ratio") ||
    (tag.includes('width="') && tag.includes('height="'))
  );
}

function expectBoxed(html: string, page: string) {
  const unboxed = imgTags(html).filter((tag) => !tagHasBox(tag));
  expect(unboxed, `${page} renders dimensionless content images (TOG-7331)`).toEqual([]);
}

const APP_URL = "https://next.example.test";
const NOW = new Date("2030-01-10T20:00:00Z");

function event(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: "friday-helldivers",
    title: "Friday night Helldivers",
    game: "Helldivers",
    description: "Bring a friend.",
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: "Voice channel",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    goingCount: 3,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
    syncRevision: 1,
    syncedRevision: 0,
    ...overrides,
  };
}

const listState: CalendarState = { view: "list", month: "2030-01", q: "", past: true };
const pastEvent = () =>
  event({
    id: 2,
    eventKey: "old-valorant",
    title: "Last week's Valorant night",
    status: "past",
    startsAt: new Date("2030-01-03T20:00:00Z"),
    endsAt: new Date("2030-01-03T22:00:00Z"),
  });
const calendarProps = (state: CalendarState) => ({
  state,
  upcoming: [event()],
  past: [pastEvent()],
  zone: "UTC",
  now: NOW,
  emptyState: null as CalendarEmptyState,
  discordFailed: false,
  member: false,
  inviteUrl: "https://discord.gg/fixture",
  appUrl: APP_URL,
});

describe("event cover-image layout boxes (TOG-7331 tripwires)", () => {
  it("calendar list and month grid carry no dimensionless images", async () => {
    const list = await jsx(EventsCalendarPage, calendarProps(listState)).toString();
    expect(list).toContain('data-testid="event-card"');
    expectBoxed(list, "GET /events (list)");

    const grid = await jsx(
      EventsCalendarPage,
      calendarProps({ ...listState, view: "calendar" }),
    ).toString();
    expect(grid).toContain('data-testid="events-calendar-grid"');
    expectBoxed(grid, "GET /events (calendar)");
  });

  it("event detail carries no dimensionless images", async () => {
    const html = await jsx(EventPage, {
      e: event(),
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: APP_URL,
      jsonLd: "{}",
    }).toString();
    expect(html).toContain("Friday night Helldivers");
    expectBoxed(html, "GET /e/{event_key}");
  });

  it("gone page carries no dimensionless images", async () => {
    const html = await jsx(EventGonePage, {
      e: event({ status: "cancelled" }),
      jsonLd: "{}",
    }).toString();
    expect(html).toContain('data-testid="event-cancelled"');
    expectBoxed(html, "GET /e/{event_key} (410)");
  });

  it("past archive carries no dimensionless images", async () => {
    const html = await jsx(PastEventsPage, {
      rows: [event({ status: "past" })],
      page: 1,
      hasMore: false,
      totalPages: 1,
      appUrl: APP_URL,
    }).toString();
    expect(html).toContain('data-testid="past-events-list"');
    expectBoxed(html, "GET /events/past");
  });
});

const previewNow = new Date("2026-09-30T20:00:00Z");
const previewBefore = new Date(previewNow.getTime() - 1);
const previewAfter = new Date(previewNow.getTime() + 1);
const previewRow: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Community night on Friday",
  body: "Everyone is welcome.",
  url: null,
  imageUrl: "https://cdn.discordapp.com/photo.jpg",
  imageAlt: "Friends playing together",
  isPublished: true,
  position: 0,
  startsAt: previewBefore,
  endsAt: previewAfter,
  createdBy: "moderator",
  createdAt: previewBefore,
  updatedAt: previewBefore,
};
const previewHtml = (row: FeaturedRow) =>
  jsx(FeaturedFormPage, {
    mode: "edit",
    row,
    values: {},
    errors: {},
    now: previewNow,
    appUrl: APP_URL,
  }).toString();

describe("featured admin preview image box", () => {
  it("reserves an explicit-dimension 16:9 box on the preview image", async () => {
    const html = await previewHtml(previewRow);
    expect(html).toContain('data-testid="featured-preview"');
    const match = html.match(/<img\b[^>]*src="https:\/\/cdn\.discordapp\.com\/photo\.jpg"[^>]*>/);
    expect(match, "no preview <img> found for the featured image URL").not.toBeNull();
    const tag = match![0];
    expect(tag).toContain('width="640"');
    expect(tag).toContain('height="360"');
    expect(tag).toContain('loading="lazy"');
    expect(tag).toContain('decoding="async"');
    expect(tag).toMatch(/alt="[^"]+"/);
    expectBoxed(html, "GET /admin/featured/:id/edit");
  });

  it.each([
    ["empty", null],
    ["blocked host", "https://images.example.test/photo.jpg"],
  ])("preview with %s image renders no dimensionless images", async (_label, imageUrl) => {
    const html = await previewHtml({ ...previewRow, imageUrl });
    expect(html).toContain('data-testid="featured-preview"');
    if (imageUrl) expect(html).not.toContain(imageUrl);
    expectBoxed(html, "GET /admin/featured/:id/edit (no image)");
  });
});
