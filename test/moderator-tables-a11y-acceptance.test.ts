// Acceptance oracle for ux-spec §4a + §4c (moderator tables: named row
// actions, labelled UTC columns). Pins the exact accessible name AND the row
// POST target for every action — including two same-title events in each
// actionable lifecycle state — plus the UTC header/sort labels on both twins
// (Kit pause names arrive pre-rendered from the same builder, asserted here).
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { buildEventListView } from "../src/admin/kit-events";
import { ActivityLogPage } from "../src/admin/pages/activity-log";
import { EventRosterSection } from "../src/admin/pages/event-form-roster";
import { EventsPage } from "../src/admin/pages/events-list";
import { JoinAttemptsPage } from "../src/admin/pages/join-attempts";
import {
  parseActivityLogQuery,
  parseJoinAttemptsQuery,
  parseRosterQuery,
} from "../src/admin/table-list";
import type { EventListRow } from "../src/admin/store";

const ENDS = new Date("2099-11-04T22:00:00Z");
function row(over: Partial<EventListRow> & { eventKey: string }): EventListRow {
  return {
    id: 1,
    title: "Untitled",
    game: null,
    description: null,
    startsAt: new Date("2026-06-15T00:30:00Z"),
    endsAt: ENDS,
    timezone: "UTC",
    location: null,
    capacity: null,
    status: "draft",
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
    createdAt: ENDS,
    updatedAt: ENDS,
    goingCount: 0,
    ...over,
  };
}

// Inner HTML of the POST form for one action, so the name is pinned to the
// row it submits for — a rename that swaps two rows' targets fails here.
function formInner(html: string, action: string): string | null {
  const m = html.match(new RegExp(`<form[^>]*action="${action}"[^>]*>([\\s\\S]*?)</form>`));
  return m ? m[1]! : null;
}

const D1 = "2026-06-15T00:30:00.000Z";
const D2 = "2026-06-16T00:30:00.000Z";
const L1 = "2026-07-01T18:00:00.000Z";
const L2 = "2026-07-02T18:00:00.000Z";

describe("ux-spec §4a: named row actions (no DB)", () => {
  const rows: EventListRow[] = [
    row({ eventKey: "k1", title: "Same Draft", status: "draft", startsAt: new Date(D1) }),
    row({ eventKey: "k2", title: "Same Draft", status: "draft", startsAt: new Date(D2) }),
    row({ eventKey: "k3", title: "Solo Draft", status: "draft", startsAt: new Date(D1) }),
    row({ eventKey: "k4", title: "Same Live", status: "published", startsAt: new Date(L1) }),
    row({ eventKey: "k5", title: "Same Live", status: "published", startsAt: new Date(L2) }),
    row({ eventKey: "k6", title: "Solo Live", status: "published", startsAt: new Date(L1) }),
    row({
      eventKey: "k7",
      title: "Same Paused",
      status: "published",
      rsvpOpen: false,
      startsAt: new Date(L1),
    }),
    row({
      eventKey: "k8",
      title: "Same Paused",
      status: "published",
      rsvpOpen: false,
      startsAt: new Date(L2),
    }),
    row({ eventKey: "k9", title: "Gone Title", status: "cancelled" }),
  ];
  const html = String(jsx(EventsPage, { rows, query: parseEventListQuery({}), hasNext: false }));

  it("names publish/cancel with the row title, disambiguating only same-title rows", () => {
    expect(formInner(html, "/admin/events/k1/publish")).toContain(
      `aria-label="Publish Same Draft (${D1})"`,
    );
    expect(formInner(html, "/admin/events/k1/cancel")).toContain(
      `aria-label="Cancel Same Draft (${D1})"`,
    );
    expect(formInner(html, "/admin/events/k2/publish")).toContain(
      `aria-label="Publish Same Draft (${D2})"`,
    );
    // A unique title takes no suffix even when its instant matches a twin's.
    expect(formInner(html, "/admin/events/k3/publish")).toContain(
      'aria-label="Publish Solo Draft"',
    );
    expect(formInner(html, "/admin/events/k3/publish")).not.toContain("Publish Solo Draft (");
  });

  it("names the pause review and reopen per row, posting back to that row", () => {
    const pause = formInner(html, "/admin/events/k4/rsvp-pause");
    expect(pause).toContain(`aria-label="Pause RSVPs for Same Live (${L1})"`);
    expect(html).toContain(`aria-label="Review pause: Same Live (${L1})"`);
    expect(html).toContain(`aria-label="Review pause: Same Live (${L2})"`);
    const solo = formInner(html, "/admin/events/k6/rsvp-pause");
    expect(solo).toContain('aria-label="Pause RSVPs for Solo Live"');
    expect(solo).not.toContain("Pause RSVPs for Solo Live (");
    expect(formInner(html, "/admin/events/k7/rsvp-reopen")).toContain(
      `aria-label="Reopen RSVPs for Same Paused (${L1})"`,
    );
    expect(formInner(html, "/admin/events/k8/rsvp-reopen")).toContain(
      `aria-label="Reopen RSVPs for Same Paused (${L2})"`,
    );
  });

  it("renders no row actions for a cancelled event", () => {
    expect(html).not.toContain('action="/admin/events/k9/');
  });

  it("pins the Kit pre-rendered pause names to the same builder", () => {
    const view = buildEventListView(
      parseEventListQuery({}),
      rows.filter((r) => ["k4", "k5", "k6"].includes(r.eventKey)),
    );
    expect(view.pauseReviews.k4).toContain(`aria-label="Pause RSVPs for Same Live (${L1})"`);
    expect(view.pauseReviews.k4).toContain('action="/admin/events/k4/rsvp-pause"');
    expect(view.pauseReviews.k5).toContain(`aria-label="Review pause: Same Live (${L2})"`);
    expect(view.pauseReviews.k6).toContain('aria-label="Pause RSVPs for Solo Live"');
    expect(view.pauseReviews.k6).not.toContain("Pause RSVPs for Solo Live (");
  });
});

describe("ux-spec §4c: labelled UTC columns (no DB)", () => {
  it("labels the roster, join-attempts and activity-log headers with their zone", () => {
    const rosterHtml = String(
      jsx(EventRosterSection, {
        eventKey: "k1",
        action: "/admin/events/k1",
        roster: [],
        rosterQuery: parseRosterQuery({}),
      }),
    );
    expect(rosterHtml).toContain("Answered (UTC)");
    expect(rosterHtml).toContain('aria-label="Sort by answered (UTC) ascending"');
    const joinHtml = String(
      jsx(JoinAttemptsPage, {
        rows: [],
        query: parseJoinAttemptsQuery({}),
        hasNext: false,
        outcomes: [],
      }),
    );
    expect(joinHtml).toContain("Attempted (UTC)");
    const activityHtml = String(
      jsx(ActivityLogPage, { rows: [], query: parseActivityLogQuery({}), hasNext: false }),
    );
    expect(activityHtml).toContain("When (UTC)");
    expect(activityHtml).not.toContain("search-dropped-notice");
  });
});
