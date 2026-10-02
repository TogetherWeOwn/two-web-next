// TOG-11750: scroll-region and header-scope parity for the admin tables.
// The featured list already renders inside a labelled keyboard-focusable
// scroll region; events, the RSVP roster and join attempts must match it, and
// every join-attempts header cell must carry scope="col" like the rest.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { EventFormPage, EventsPage, JoinAttemptsPage } from "../src/admin/pages";
import type { EventRow } from "../src/admin/store";
import type { JoinAttemptRow, RosterEntry } from "../src/admin/reads";
import { parseJoinAttemptsQuery, parseRosterQuery } from "../src/admin/table-list";

const at = new Date("2026-09-30T20:00:00Z");
const eventRow: EventRow = {
  id: 1, eventKey: "01J0000000000000000000ABCD", title: "Friday games", game: null,
  description: null, startsAt: at, endsAt: new Date("2026-09-30T22:00:00Z"),
  timezone: "UTC", location: null, capacity: null, status: "published",
  discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
  recurrenceFrequency: null, recurrenceCount: null, recurrenceEndsOn: null,
  parentEventId: null, recurrenceIndex: null, icsSequence: 0n,
  rsvpOpen: true, createdBy: null, createdAt: at, updatedAt: at,
};
const roster: RosterEntry[] = [
  { userId: "u1", username: "Alice", status: "going", answeredAt: at },
];
const attempt: JoinAttemptRow = {
  id: 7, outcome: "added", source: "join",
  requestId: "req-1", discordId: "123", createdAt: at,
};

const eventsHtml = () =>
  String(jsx(EventsPage, { rows: [eventRow], query: parseEventListQuery({}), hasNext: false }));
const rosterHtml = () =>
  String(EventFormPage({ mode: "edit", row: eventRow, values: {}, errors: {}, roster, rosterQuery: parseRosterQuery({}) }));
const attemptsHtml = () =>
  String(jsx(JoinAttemptsPage, {
    rows: [attempt], query: parseJoinAttemptsQuery({}), hasNext: false, outcomes: ["added", "denied"],
  }));

// Every real header cell carries scope="col"; <thead> must not trip the check.
const bareHeader = (html: string) => html.match(/<th\b(?![^>]*scope="col")/g);

// Local rows only: these tests never open a database or public/staging endpoint.
describe("admin table scroll-region and header-scope parity", () => {
  it("keeps the events table in a named keyboard-focusable scroll region", () => {
    const html = eventsHtml();
    expect(html).toContain('class="admin-table-scroll" role="region" aria-label="Events list" aria-describedby="events-scroll-hint" tabindex="0"');
    expect(html).toContain('id="events-scroll-hint">Scroll horizontally to see all columns on smaller screens.');
    expect(html).toContain('data-testid="events-table-scroll"');
    expect(html.indexOf('data-testid="events-table-scroll"')).toBeLessThan(html.indexOf('data-testid="events-table"'));
    expect(bareHeader(html)).toBeNull();
  });

  it("keeps the RSVP roster in a named keyboard-focusable scroll region", () => {
    const html = rosterHtml();
    expect(html).toContain('class="admin-table-scroll" role="region" aria-label="RSVP roster list" aria-describedby="roster-scroll-hint" tabindex="0"');
    expect(html).toContain('id="roster-scroll-hint">Scroll horizontally to see all columns on smaller screens.');
    expect(html).toContain('data-testid="roster-table-scroll"');
    expect(html).toContain('data-testid="roster-table"');
    expect(html.indexOf('data-testid="roster-table-scroll"')).toBeLessThan(html.indexOf('data-testid="roster-table"'));
    expect(bareHeader(html)).toBeNull();
  });

  it("keeps join attempts in a named keyboard-focusable scroll region with scoped headers", () => {
    const html = attemptsHtml();
    expect(html).toContain('class="admin-table-scroll" role="region" aria-label="Join attempts list" aria-describedby="join-attempts-scroll-hint" tabindex="0"');
    expect(html).toContain('id="join-attempts-scroll-hint">Scroll horizontally to see all columns on smaller screens.');
    expect(html).toContain('data-testid="join-attempts-table-scroll"');
    expect(html.indexOf('data-testid="join-attempts-table-scroll"')).toBeLessThan(html.indexOf('data-testid="join-attempts-table"'));
    expect(html.match(/<th scope="col">/g)).toHaveLength(5);
    expect(bareHeader(html)).toBeNull();
  });

  it("keeps the native tables and empty states server-rendered inside the regions", () => {
    const emptyEvents = String(jsx(EventsPage, { rows: [], query: parseEventListQuery({}), hasNext: false }));
    expect(emptyEvents).toContain('data-testid="events-table-scroll"');
    expect(emptyEvents).toContain('colspan="4" data-testid="events-empty"');
    const emptyRoster = String(EventFormPage({ mode: "edit", row: eventRow, values: {}, errors: {}, roster: [], rosterQuery: parseRosterQuery({}) }));
    expect(emptyRoster).toContain('data-testid="roster-table-scroll"');
    expect(emptyRoster).toContain('data-testid="roster-empty"');
    const emptyAttempts = String(jsx(JoinAttemptsPage, {
      rows: [], query: parseJoinAttemptsQuery({}), hasNext: false, outcomes: ["added"],
    }));
    expect(emptyAttempts).toContain('data-testid="join-attempts-table-scroll"');
    expect(emptyAttempts).toContain('colspan="5" data-testid="join-attempts-empty"');
  });
});
