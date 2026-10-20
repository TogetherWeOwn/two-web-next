// Shared native attendee-page URL builders: the Hono form action, the
// detail-page refresh link and the refusal return link rebuild the same
// rooted destinations. Hermetic: pure string builders plus SSR renders, no
// DATABASE_URL.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { attendeePageHref, rsvpActionHref, rsvpPageReturnPath } from "../src/events/attendee-paths";
import { EventPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  attendeePageHref as readsHref,
  rsvpPageReturnPath as readsReturn,
} from "../src/events/reads";
import { RsvpButton } from "../src/events/rsvp-button";
import { rsvpRefusalModelFor } from "../src/events/rsvp-refusal";

const KEY = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
// Route-input keys that must survive encoding: slash, percent, space, Unicode.
const TRICKY = "a/b%c d-é";

const start = new Date("2030-01-10T20:00:00Z");
function publicEvent(over: Partial<PublicEvent> = {}): PublicEvent {
  return {
    id: 1,
    icsSequence: 1n,
    eventKey: KEY,
    title: "Squad night",
    game: null,
    description: null,
    startsAt: start,
    endsAt: new Date("2030-01-10T22:00:00Z"),
    timezone: "UTC",
    location: null,
    capacity: 10,
    status: "published",
    rsvpOpen: true,
    goingCount: 1,
    goingOccupancy: 1,
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
    ...over,
  };
}

const formAction = (html: string) => html.match(/<form[^>]*action="([^"]*)"/)?.[1];
const refreshHref = (html: string) =>
  html.match(/<a[^>]*href="([^"]*)"[^>]*data-testid="event-attendees-refresh"/)?.[1] ??
  html.match(/data-testid="event-attendees-refresh"[^>]*href="([^"]*)"/)?.[1];

describe("attendee page builders", () => {
  it("keeps page one bare and later pages queried", () => {
    expect(attendeePageHref(KEY, 1)).toBe(`/e/${KEY}`);
    expect(attendeePageHref(KEY, 0)).toBe(`/e/${KEY}`);
    expect(attendeePageHref(KEY, -2)).toBe(`/e/${KEY}`);
    expect(attendeePageHref(KEY, 2)).toBe(`/e/${KEY}?attendees=2`);
  });

  it("encodes route-input keys on the return path", () => {
    expect(rsvpPageReturnPath(TRICKY, 1)).toBe(`/e/${encodeURIComponent(TRICKY)}`);
    expect(rsvpPageReturnPath(TRICKY, 2)).toBe(`/e/${encodeURIComponent(TRICKY)}?attendees=2`);
  });

  it("falls back to the bare return path for invalid pages", () => {
    const bare = `/e/${encodeURIComponent(TRICKY)}`;
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(rsvpPageReturnPath(TRICKY, page)).toBe(bare);
    }
  });

  it("places /rsvp before the page query on the form action", () => {
    const enc = encodeURIComponent(TRICKY);
    expect(rsvpActionHref(TRICKY, 1)).toBe(`/e/${enc}/rsvp`);
    expect(rsvpActionHref(TRICKY, 2)).toBe(`/e/${enc}/rsvp?attendees=2`);
    expect(rsvpActionHref(TRICKY, 0)).toBe(`/e/${enc}/rsvp`);
    expect(rsvpActionHref(TRICKY, Number.NaN)).toBe(`/e/${enc}/rsvp`);
    expect(rsvpActionHref(TRICKY, 1.5)).toBe(`/e/${enc}/rsvp`);
  });

  it("keeps the reads.ts exports compatible", () => {
    expect(readsHref(KEY, 2)).toBe(attendeePageHref(KEY, 2));
    expect(readsReturn(TRICKY, 2)).toBe(rsvpPageReturnPath(TRICKY, 2));
    expect(readsReturn(TRICKY, 1)).toBe(rsvpPageReturnPath(TRICKY, 1));
  });
});

describe("renderer parity", () => {
  it("renders the shared form action on the RSVP button", () => {
    const e = publicEvent();
    const page1 = RsvpButton({ e, member: true, answer: null, returnTo: `/e/${KEY}` })!.toString() as string;
    expect(formAction(page1)).toBe(`/e/${KEY}/rsvp`);
    const page2 = RsvpButton({
      e,
      member: true,
      answer: null,
      returnTo: `/e/${KEY}`,
      attendeePage: 2,
    })!.toString() as string;
    expect(formAction(page2)).toBe(`/e/${KEY}/rsvp?attendees=2`);
    const tricky = RsvpButton({
      e: publicEvent({ eventKey: TRICKY }),
      member: true,
      answer: null,
      returnTo: "/e/x",
      attendeePage: 3,
    })!.toString() as string;
    expect(formAction(tricky)).toBe(`/e/${encodeURIComponent(TRICKY)}/rsvp?attendees=3`);
  });

  it("renders the shared refresh link on the detail page", () => {
    const e = publicEvent();
    const base = {
      e,
      neighbors: { previous: null, next: null },
      related: [],
      appUrl: "https://next.example.test",
      jsonLd: '{"@type":"Event"}',
      member: true,
      attendees: [{ id: "u1", name: "Ada" }],
    };
    const page1 = EventPage({
      ...base,
      attendeesPaging: { page: 1, prevHref: null, nextHref: null },
    })!.toString() as string;
    expect(refreshHref(page1)).toBe(`/e/${KEY}`);
    const page2 = EventPage({
      ...base,
      attendeesPaging: { page: 2, prevHref: `/e/${KEY}`, nextHref: null },
    })!.toString() as string;
    expect(refreshHref(page2)).toBe(`/e/${KEY}?attendees=2`);
  });

  it("rebuilds the refusal return path from the shared builder", () => {
    expect(rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: KEY }).returnPath).toBe(
      `/e/${KEY}`,
    );
    expect(
      rsvpRefusalModelFor({ status: 429, retryAfter: "30", eventKey: KEY, attendeePage: 2 })
        .returnPath,
    ).toBe(`/e/${KEY}?attendees=2`);
    expect(
      rsvpRefusalModelFor({ status: 503, retryAfter: null, eventKey: TRICKY, attendeePage: 2 })
        .returnPath,
    ).toBe(`/e/${encodeURIComponent(TRICKY)}?attendees=2`);
    for (const page of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
      expect(
        rsvpRefusalModelFor({ status: 403, retryAfter: null, eventKey: KEY, attendeePage: page })
          .returnPath,
      ).toBe(`/e/${KEY}`);
    }
  });
});

describe("module boundaries", () => {
  const src = (name: string) =>
    readFileSync(new URL(`../src/events/${name}`, import.meta.url), "utf8");

  it("keeps the path builders dependency-free", () => {
    expect(src("attendee-paths.ts")).not.toMatch(/^import /m);
  });

  it("keeps the refusal core off the reads layer", () => {
    const refusal = src("rsvp-refusal.ts");
    expect(refusal).not.toContain("./reads");
    expect(refusal).not.toContain("drizzle");
    expect(refusal).not.toContain("hono/jsx");
  });
});
