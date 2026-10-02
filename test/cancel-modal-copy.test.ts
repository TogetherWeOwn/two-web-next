// TOG-12105: pin the cancellation dialog copy/state contract.
//
// Ledger docs/w15-events-acceptance-ledger.md (`Unit/EventCancelModalCopyTest`
// row): the cancellation dialog copy/state is not covered by the server
// transition guard. In Next there is deliberately no modal: mutating buttons
// submit immediately (docs/moderator-admin-guide.md: "there is no
// action-confirmation dialog"). This suite pins that replacement contract
// from the island contract (src/islands/contracts.ts) and its agreement with
// the server guard (src/admin/validation.ts: cancelled is terminal, no
// reopen/republish, past-banner coexistence).
//
// Hermetic: pure renders + pure guard functions, no DATABASE_URL. Runs on
// agent-testdb runners and CI Postgres alike. Test-only: contracts.ts is hot
// (PR #61) — do not edit it here; if copy drifts, park blocked with the diff.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { parseEventListQuery } from "../src/admin/event-list";
import { EventFormPage, EventsPage } from "../src/admin/pages";
import type { EventListRow, EventRow } from "../src/admin/store";
import { ValidationError, isMirrored, nextStatus } from "../src/admin/validation";
import { EventGonePage, EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  EVENT_CANCELLED_TESTID,
  RSVP_CLOSED_TESTID,
  rsvpClosedCopy,
} from "../src/islands/contracts";

const APP_URL = "https://next.example.test";
const QUERY = parseEventListQuery({});

const errors = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return e.fields;
    throw e;
  }
  throw new Error("expected a ValidationError");
};

function listRow(status: EventListRow["status"], eventKey: string): EventListRow {
  const at = new Date("2026-06-15T00:30:00Z");
  return {
    id: 1, eventKey, title: eventKey, game: null, description: null,
    startsAt: at, endsAt: new Date("2026-06-15T02:30:00Z"), timezone: "UTC", location: null,
    capacity: null, status, discordEventId: null, discordSyncFailedAt: null,
    discordSyncFailureCode: null, createdBy: null, rsvpOpen: true, recurrenceFrequency: null,
    recurrenceCount: null, recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: at, updatedAt: at, icsSequence: 0n, goingCount: 0, syncRevision: 1, syncedRevision: 0,
  };
}

function editRow(status: EventRow["status"]): EventRow {
  const { goingCount: _dropped, ...rest } = listRow(status, `cancel-${status}`);
  return rest;
}

function publicEvent(over: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2030-01-10T20:00:00Z");
  return {
    id: 1, icsSequence: 0n, eventKey: "01ARZ3NDEKTSV4RRFFQ69G5FAV", title: "Chess night",
    game: null, description: null, startsAt: start, endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC", location: null, capacity: null, status: "published", rsvpOpen: true,
    discordEventId: null, discordSyncFailedAt: null, discordSyncFailureCode: null,
    createdBy: null, recurrenceFrequency: null, recurrenceCount: null,
    recurrenceEndsOn: null, parentEventId: null, recurrenceIndex: null,
    createdAt: start, updatedAt: start, goingCount: 0, syncRevision: 1, syncedRevision: 0, ...over,
  };
}

function listHtml(status: EventListRow["status"]): string {
  const key = `cancel-${status}`;
  return String(jsx(EventsPage, { rows: [listRow(status, key)], query: QUERY, hasNext: false }));
}

function editHtml(status: EventRow["status"]): string {
  return String(jsx(EventFormPage, { mode: "edit", row: editRow(status), values: {}, errors: {} }));
}

function eventHtml(over: Partial<PublicEvent> = {}): string {
  return String(
    jsx(EventPage, {
      e: publicEvent(over),
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: APP_URL,
      jsonLd: "{}",
    }),
  );
}

function goneHtml(): string {
  return String(jsx(EventGonePage, { e: publicEvent({ status: "cancelled" }), jsonLd: "{}" }));
}

describe("cancel action copy (no confirmation dialog)", () => {
  it("pins the island testids for the cancelled banner and the closed RSVP control", () => {
    expect(EVENT_CANCELLED_TESTID).toBe("event-cancelled");
    expect(RSVP_CLOSED_TESTID).toBe("rsvp-closed");
  });

  it("names the closed reason in words: cancelled, draft, been-and-gone", () => {
    expect(rsvpClosedCopy("cancelled")).toBe("Cancelled");
    expect(rsvpClosedCopy("draft")).toBe("Not published yet");
    expect(rsvpClosedCopy("past")).toBe("This one has been and gone");
  });

  it("offers Cancel on the list only for drafts and published events", () => {
    for (const status of ["draft", "published"] as const) {
      const html = listHtml(status);
      expect(html).toContain(`action="/admin/events/cancel-${status}/cancel"`);
      expect(html).toContain(">Cancel</button>");
    }
    for (const status of ["cancelled", "past"] as const) {
      const html = listHtml(status);
      expect(html).not.toContain(`action="/admin/events/cancel-${status}/cancel"`);
      expect(html).not.toContain(">Cancel</button>");
      expect(html).not.toContain(">Cancel event</button>");
    }
  });

  it("offers Cancel event on the edit screen only for drafts and published events", () => {
    for (const status of ["draft", "published"] as const) {
      const html = editHtml(status);
      expect(html).toContain('data-testid="cancel-event">Cancel event');
    }
    for (const status of ["cancelled", "past"] as const) {
      const html = editHtml(status);
      expect(html).not.toContain('data-testid="cancel-event"');
      expect(html).not.toContain(">Cancel event</button>");
    }
  });

  it("keeps the editor Cancel leave-link distinct from the Cancel event action", () => {
    const html = editHtml("published");
    expect(html).toContain('<a href="/admin/events">Cancel</a>');
    expect(html).toContain('data-testid="cancel-event">Cancel event');
  });

  it("submits cancellations immediately: POST forms, no dialog wiring", () => {
    for (const status of ["draft", "published", "cancelled", "past"] as const) {
      const html = listHtml(status) + editHtml(status);
      expect(html).not.toContain("<dialog");
      expect(html).not.toContain("data-confirm");
      expect(html).not.toContain("showModal");
      expect(html).not.toContain("window.confirm");
    }
    const html = editHtml("published");
    expect(html).toContain('<form method="post" action="/admin/events/cancel-published/cancel">');
    expect(html).toContain('<button type="submit" class="link" data-testid="cancel-event">Cancel event</button>');
  });

  it("offers Publish only for drafts, so a cancelled event cannot be republished from the UI", () => {
    expect(editHtml("draft")).toContain('data-testid="publish-event">Publish');
    for (const status of ["published", "cancelled", "past"] as const) {
      expect(editHtml(status)).not.toContain('data-testid="publish-event"');
    }
  });
});

describe("cancelled banner copy and past-banner coexistence", () => {
  it("shows exactly one status banner per stored status", () => {
    const cancelled = eventHtml({ status: "cancelled" });
    expect(cancelled).toContain('data-testid="event-cancelled">Cancelled');
    expect(cancelled).not.toContain('data-testid="event-draft"');
    expect(cancelled).not.toContain('data-testid="event-past"');

    const past = eventHtml({ status: "past" });
    expect(past).toContain('data-testid="event-past">Past event');
    expect(past).not.toContain('data-testid="event-cancelled"');

    const draft = eventHtml({ status: "draft" });
    expect(draft).toContain('data-testid="event-draft">Draft');
    expect(draft).not.toContain('data-testid="event-cancelled"');
  });

  it("keeps the Cancelled banner on an ended cancelled event instead of swapping to Past", () => {
    const html = eventHtml({
      status: "cancelled",
      startsAt: new Date("2020-01-04T20:00:00Z"),
      endsAt: new Date("2020-01-04T22:00:00Z"),
    });
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).not.toContain('data-testid="event-past"');
  });

  it("does not invent a past banner for an ended-but-still-published row", () => {
    const html = eventHtml({
      status: "published",
      startsAt: new Date("2020-01-04T20:00:00Z"),
      endsAt: new Date("2020-01-04T22:00:00Z"),
    });
    expect(html).not.toContain('data-testid="event-past"');
    expect(html).not.toContain('data-testid="event-cancelled"');
  });

  it("keeps the gone page on the cancelled copy with a way back to upcoming", () => {
    const html = goneHtml();
    expect(html).toContain('data-testid="event-cancelled">Cancelled');
    expect(html).toContain("This event was cancelled");
    expect(html).toContain('href="/events">See upcoming events</a>');
  });
});

describe("server guard agreement (cancel terminal, no reopen/republish)", () => {
  it("lets drafts publish and drafts/published cancel", () => {
    expect(nextStatus("draft", "published")).toBe("published");
    expect(nextStatus("draft", "cancelled")).toBe("cancelled");
    expect(nextStatus("published", "cancelled")).toBe("cancelled");
  });

  it("keeps cancelled terminal: no republish and no re-cancel", () => {
    expect(errors(() => nextStatus("cancelled", "published"))).toMatchObject({
      status: "A cancelled event stays cancelled — Discord was already told.",
    });
    expect(errors(() => nextStatus("cancelled", "cancelled"))).toMatchObject({
      status: "A cancelled event stays cancelled — Discord was already told.",
    });
  });

  it("refuses to cancel a past event and to republish one", () => {
    expect(errors(() => nextStatus("past", "cancelled"))).toMatchObject({
      status: "Only a draft or a published event can be cancelled.",
    });
    expect(errors(() => nextStatus("past", "published"))).toMatchObject({
      status: "Only a draft can be published.",
    });
    expect(errors(() => nextStatus("published", "published"))).toMatchObject({
      status: "Only a draft can be published.",
    });
  });

  it("keeps the Discord mirror on published and cancelled only", () => {
    expect(isMirrored("published")).toBe(true);
    expect(isMirrored("cancelled")).toBe(true);
    expect(isMirrored("draft")).toBe(false);
    expect(isMirrored("past")).toBe(false);
  });
});
