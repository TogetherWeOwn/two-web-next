// Draft ICS must stamp TENTATIVE, not CONFIRMED.
// Builder-owned regression tests (unit-level, no DB).
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { eventIcs, eventsIcsCollection } from "../src/events/feeds";

const APP_URL = "https://next.example.test";
const KEY = "01J0000000000000000000ABCD";
const row = (o: Partial<typeof events.$inferSelect> = {}) =>
  ({
    id: 1,
    icsSequence: 1782907200n,
    eventKey: KEY,
    title: "Friday night Helldivers",
    game: null,
    description: "Bring stims.",
    purpose: null,
    startsAt: new Date("2026-07-15T18:00:00Z"),
    endsAt: new Date("2026-07-15T20:00:00Z"),
    timezone: "Europe/London",
    location: "Voice: General",
    capacity: null,
    status: "published",
    rsvpOpen: true,
    updatedAt: new Date("2026-07-01T12:00:00Z"),
    ...o,
  }) as typeof events.$inferSelect;

describe("draft ICS status mapping", () => {
  it.each([
    ["draft", "STATUS:TENTATIVE"],
    ["cancelled", "STATUS:CANCELLED"],
    ["published", "STATUS:CONFIRMED"],
  ] as const)("maps status %s to %s in per-event ICS", (status, line) => {
    const out = eventIcs(row({ status }), APP_URL);
    expect(out).toContain(`${line}\r\n`);
  });

  it("maps draft to TENTATIVE in the collection feed", () => {
    const out = eventsIcsCollection([row({ status: "draft" })], APP_URL);
    expect(out).toContain("STATUS:TENTATIVE\r\n");
    expect(out).not.toContain("STATUS:CONFIRMED");
  });
});
