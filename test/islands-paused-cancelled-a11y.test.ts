// Announcement + focus pins for paused and cancelled event member states.
//
// Functional coverage for these states already exists (paused-holder leave,
// full-holder SSR with paused RSVP, the `event-cancelled` notice); what was
// missing is the assistive-tech contract: every member-facing announcement is
// a polite `role="status"`, never a `role="alert"`, and no state steals
// focus to its notice. Hermetic: pure SSR renders, no DATABASE_URL.
import { describe, expect, it } from "vitest";
import { jsx } from "hono/jsx/jsx-runtime";
import { RsvpButton } from "../src/events/rsvp-button";
import { EventGonePage, EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import { EventFormPage } from "../src/admin/pages";
import type { EventRow } from "../src/admin/store";
import {
  EVENT_CANCELLED_TESTID,
  RSVP_COPY,
  RSVP_PAUSED_TESTID,
  RSVP_WITHDRAW_TESTID,
  RSVP_GOING_TESTID,
  WAITLIST_JOIN_TESTID,
  WAITLIST_CLAIM_TESTID,
  WAITLIST_LEAVE_TESTID,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";

function publicEvent(over: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1,
    icsSequence: 0n,
    eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
    title: "Squad night",
    game: null,
    description: null,
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: 4,
    status: "published",
    rsvpOpen: true,
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
    goingCount: 1,
    syncRevision: 1,
    syncedRevision: 0,
    goingOccupancy: 1,
    ...over,
  };
}

function editRow(status: EventRow["status"], rsvpOpen: boolean): EventRow {
  // The pause/reopen action only renders while the event has not ended.
  const at = new Date("2030-06-15T00:30:00Z");
  return {
    id: 1,
    eventKey: `pause-${status}-${rsvpOpen ? "open" : "paused"}`,
    title: "Squad night",
    game: null,
    description: null,
    startsAt: at,
    endsAt: new Date("2030-06-15T02:30:00Z"),
    timezone: "UTC",
    location: null,
    capacity: null,
    status,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    rsvpOpen,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: at,
    updatedAt: at,
    icsSequence: 0n,
    syncRevision: 1,
    syncedRevision: 0,
  };
}

describe("paused RSVP member states announce politely and keep focus put", () => {
  it("paused SSR (no answer) announces the hold as status, never alert, with no join control", () => {
    const html = String(
      RsvpButton({
        e: publicEvent({ rsvpOpen: false }),
        member: true,
        answer: null,
        returnTo: "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
        now: new Date("2029-01-01"),
      }),
    );
    expect(html).toContain(`role="status" data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).toContain(RSVP_COPY.paused);
    expect(html).not.toContain('role="alert"');
    // The hold is announced on browse; it never yanks focus to itself.
    expect(html).not.toContain(`tabindex="-1" data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).not.toContain(`data-testid="${RSVP_GOING_TESTID}"`);
    expect(html).not.toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
  });

  it("full-holder SSR with paused RSVP keeps the leave control, the paused status and no alert", () => {
    const html = String(
      RsvpButton({
        e: publicEvent({ rsvpOpen: false, goingCount: 4 }),
        member: true,
        answer: { status: "going", syncedToDiscordAt: null },
        returnTo: "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
        now: new Date("2029-01-01"),
      }),
    );
    expect(html).toContain(`role="status" data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).toContain(`data-testid="${RSVP_WITHDRAW_TESTID}"`);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain(`data-testid="${RSVP_GOING_TESTID}"`);
    expect(html).not.toContain(`data-testid="${WAITLIST_JOIN_TESTID}"`);
    expect(html).not.toContain(`data-testid="${WAITLIST_CLAIM_TESTID}"`);
  });

  it("paused waitlisted holder SSR keeps leave, the paused status and no alert", () => {
    const html = String(
      RsvpButton({
        e: publicEvent({ rsvpOpen: false }),
        member: true,
        answer: { status: "waitlisted", syncedToDiscordAt: null },
        returnTo: "/e/01ARZ3NDEKTSV4RRFFQ69G5FAV",
        now: new Date("2029-01-01"),
      }),
    );
    expect(html).toContain(`role="status" data-testid="${RSVP_PAUSED_TESTID}"`);
    expect(html).toContain(`data-testid="${WAITLIST_LEAVE_TESTID}"`);
    expect(html).not.toContain('role="alert"');
  });
});

describe("cancelled event member notices announce politely and never as alerts", () => {
  it("cancelled detail announces Cancelled as status on a static notice that steals no focus", () => {
    const html = String(
      jsx(EventPage, {
        e: publicEvent({ status: "cancelled" }),
        neighbors: { previous: null, next: null },
        related: [],
        appUrl: APP_URL,
        jsonLd: "{}",
      }),
    );
    expect(html).toContain(`role="status" data-testid="${EVENT_CANCELLED_TESTID}"`);
    expect(html).not.toContain('role="alert"');
    expect(html).not.toContain("autofocus");
  });

  it("gone page announces Cancelled as status with a way back and no alert", () => {
    const html = String(
      jsx(EventGonePage, { e: publicEvent({ status: "cancelled" }), jsonLd: "{}" }),
    );
    expect(html).toContain(`role="status" data-testid="${EVENT_CANCELLED_TESTID}"`);
    expect(html).not.toContain('role="alert"');
    expect(html).toContain('href="/events">See upcoming events</a>');
  });
});

describe("admin pause/cancel controls expose their names on native buttons", () => {
  it("names Pause RSVPs and Cancel event on a published event", () => {
    const html = String(
      jsx(EventFormPage, {
        mode: "edit",
        row: editRow("published", true),
        values: {},
        errors: {},
      }),
    );
    expect(html).toContain('<button type="submit" class="btn" data-testid="rsvp-pause">');
    expect(html).toContain(">Pause RSVPs</button>");
    expect(html).toContain('<button type="submit" class="btn" data-testid="cancel-event">');
    expect(html).toContain(">Cancel event</button>");
    // Native buttons with visible-text names: no aria-label override and no
    // focus removal on the controls themselves, so assistive tech announces
    // the same name sighted members see and keyboard members can reach them.
    // (The page shell keeps its own skip-link `tabindex="-1"` on `<main>`.)
    for (const testid of ["rsvp-pause", "cancel-event"]) {
      const tag = new RegExp(`<button[^>]*data-testid="${testid}"[^>]*>`).exec(html)?.[0] ?? "";
      expect(tag, testid).not.toContain("aria-label");
      expect(tag, testid).not.toContain("tabindex");
    }
  });

  it("names Reopen RSVPs once paused, keeping Cancel event beside it", () => {
    const html = String(
      jsx(EventFormPage, {
        mode: "edit",
        row: editRow("published", false),
        values: {},
        errors: {},
      }),
    );
    expect(html).toContain('<button type="submit" class="link" data-testid="rsvp-reopen">');
    expect(html).toContain(">Reopen RSVPs</button>");
    expect(html).toContain(">Cancel event</button>");
    expect(html).not.toContain("Pause RSVPs");
  });
});
