// TOG-12862: pin admin zero-row empty states across event/featured/roster tables.
// Pure render pins only: no database, no network, no guard/resource reads.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EVENT_PAGE_SIZE, eventEmptyText, parseEventListQuery } from "../src/admin/event-list";
import { EventFormPage, EventsPage, FeaturedPage } from "../src/admin/pages";
import type { EventRow, FeaturedRow } from "../src/admin/store";
import type { RosterEntry } from "../src/admin/reads";
import {
  featuredEmptyText,
  parseFeaturedListQuery,
  parseRosterQuery,
  rosterEmptyText,
} from "../src/admin/table-list";

const at = new Date("2026-09-30T20:00:00Z");
const eventRow: EventRow = {
  id: 1,
  eventKey: "empty-state-event",
  title: "Friday games",
  game: null,
  description: null,
  startsAt: at,
  endsAt: new Date("2026-09-30T22:00:00Z"),
  timezone: "UTC",
  location: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  agentGrantId: null,
  proofMarker: null,
  agentVersion: 1,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  icsSequence: 0n,
  syncRevision: 0,
  syncedRevision: 0,
  rsvpOpen: true,
  createdBy: null,
  createdAt: at,
  updatedAt: at,
};
const featuredRow: FeaturedRow = {
  id: 1,
  legacyId: null,
  title: "Friday games",
  body: "Bring a friend.",
  url: null,
  imageUrl: null,
  imageAlt: null,
  isPublished: true,
  position: 0,
  startsAt: null,
  endsAt: null,
  createdBy: "moderator",
  createdAt: at,
  updatedAt: at,
};
const rosterEntry: RosterEntry = {
  userId: "100000000000000101",
  username: "Alice",
  status: "going",
  answeredAt: at,
};

describe("admin zero-row empty-state copy", () => {
  it("events names filtered empties and keeps the genuine empty", () => {
    expect(eventEmptyText(parseEventListQuery({}))).toBe("No events yet.");
    for (const params of [
      { q: "missing" },
      { status: "published" },
      { series: "parent" },
      { fill: "full" },
      { rsvp_open: "1" },
    ] as const) {
      expect(eventEmptyText(parseEventListQuery(params))).toBe("No events match these filters.");
    }
  });

  it("featured and roster distinguish filtered empties from genuine empties", () => {
    expect(featuredEmptyText(parseFeaturedListQuery({}))).toBe("No featured content yet.");
    expect(featuredEmptyText(parseFeaturedListQuery({ q: "absent" }))).toBe(
      "No featured content matches these filters.",
    );
    expect(featuredEmptyText(parseFeaturedListQuery({ published: "1" }))).toBe(
      "No featured content matches these filters.",
    );
    expect(rosterEmptyText(parseRosterQuery({}))).toBe("No RSVPs yet.");
    expect(rosterEmptyText(parseRosterQuery({ roster_q: "absent" }))).toBe(
      "No RSVPs match this member search.",
    );
  });

  it("keeps 25-row event pagination", () => {
    expect(EVENT_PAGE_SIZE).toBe(25);
  });
});

describe("admin zero-row tables degrade instead of crashing", () => {
  it("renders the events empty state inside its scroll region with usable navigation", () => {
    const html = String(
      jsx(EventsPage, { rows: [], query: parseEventListQuery({}), hasNext: false }),
    );
    expect(html).toContain('data-testid="events-table"');
    expect(html).toContain('data-testid="events-table-scroll"');
    expect(html).toContain('colspan="5" data-testid="events-empty"');
    expect(html).toContain("No events yet.");
    expect(html).toContain("Page 1");
    expect(html).not.toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
    // Filters, sort headers and the create action survive the empty state.
    expect(html).toContain('action="/admin/events" class="filters"');
    expect(html).toContain('data-testid="new-event"');
    expect(html).toContain("Sort by title");
  });

  it("renders the filtered events empty state on later pages with a way back", () => {
    const html = String(
      jsx(EventsPage, {
        rows: [],
        query: parseEventListQuery({ q: "missing", page: "2" }),
        hasNext: false,
      }),
    );
    expect(html).toContain('data-testid="events-empty"');
    expect(html).toContain("No events match these filters.");
    expect(html).toContain("Page 2");
    expect(html).toContain('rel="prev"');
    expect(html).not.toContain('rel="next"');
  });

  it("renders the featured empty states inside their scroll region", () => {
    const empty = String(
      jsx(FeaturedPage, { rows: [], query: parseFeaturedListQuery({}), now: at }),
    );
    expect(empty).toContain('data-testid="featured-table"');
    expect(empty).toContain('data-testid="featured-table-scroll"');
    expect(empty).toContain('colspan="5" data-testid="featured-empty"');
    expect(empty).toContain("No featured content yet.");
    expect(empty).toContain('data-testid="new-featured"');
    const filtered = String(
      jsx(FeaturedPage, { rows: [], query: parseFeaturedListQuery({ q: "absent" }), now: at }),
    );
    expect(filtered).toContain("No featured content matches these filters.");
  });

  it("renders the roster empty states with their counts and search intact", () => {
    const empty = String(
      EventFormPage({
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster: [],
        rosterQuery: parseRosterQuery({}),
      }),
    );
    expect(empty).toContain('data-testid="roster-table"');
    expect(empty).toContain('data-testid="roster-table-scroll"');
    expect(empty).toContain('colspan="3" data-testid="roster-empty"');
    expect(empty).toContain("No RSVPs yet.");
    expect(empty).toContain("RSVPs (0)");
    expect(empty).toContain('name="roster_q"');
    const searched = String(
      EventFormPage({
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster: [],
        rosterQuery: parseRosterQuery({ roster_q: "absent" }),
      }),
    );
    expect(searched).toContain("No RSVPs match this member search.");
  });

  it("still renders populated tables without any empty state", () => {
    const events = String(
      jsx(EventsPage, {
        rows: [{ ...eventRow, goingCount: 1 }],
        query: parseEventListQuery({}),
        hasNext: false,
      }),
    );
    expect(events).not.toContain("events-empty");
    const featured = String(
      jsx(FeaturedPage, { rows: [featuredRow], query: parseFeaturedListQuery({}), now: at }),
    );
    expect(featured).not.toContain("featured-empty");
    const roster = String(
      EventFormPage({
        mode: "edit",
        row: eventRow,
        values: {},
        errors: {},
        roster: [rosterEntry],
        rosterQuery: parseRosterQuery({}),
      }),
    );
    expect(roster).not.toContain("roster-empty");
    expect(roster).toContain("RSVPs (1)");
  });
});
