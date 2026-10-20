// ZAP 10096 (Unix timestamp disclosure) flags any 10-digit body run in
// [now-10y, now+10y]. The stored ICS revision is epoch-derived by
// design (the events_ics_sequence trigger owns it; legacy two-web parity), so
// the builder must never emit it raw. Pure builder tests, no DATABASE_URL.
import { describe, expect, it } from "vitest";
import { events } from "../src/db/admin-schema";
import { eventIcs, eventsIcsCollection } from "../src/events/feeds";

const APP_URL = "https://next.example.test";

// ZAP pscanrules TimestampDisclosureScanRule unix pattern.
const ZAP_UNIX = /\b(?:1\d|2[0-2])\d{8}\b(?!%)/;

const row = (icsSequence: bigint) =>
  ({
    id: 1,
    icsSequence,
    eventKey: "01J0000000000000000000ABCD",
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
  }) as typeof events.$inferSelect;

describe("ICS SEQUENCE carries no unix-timestamp shape", () => {
  it.each([1782907200n, 1790975605n, 2147483647n])(
    "epoch-backed revision %s emits no ZAP-flaggable run",
    (icsSequence) => {
      for (const body of [
        eventIcs(row(icsSequence), APP_URL),
        eventsIcsCollection([row(icsSequence)], APP_URL),
      ]) {
        expect(body).not.toMatch(ZAP_UNIX);
      }
    },
  );

  it("preserves revision ordering across the shift", () => {
    const seq = (n: bigint) => {
      const found = eventIcs(row(n), APP_URL).match(/^SEQUENCE:(\d+)$/m)?.[1];
      expect(found).toBeDefined();
      return BigInt(found!);
    };
    expect(seq(1790975606n)).toBeGreaterThan(seq(1790975605n));
    expect(seq(1790975605n)).toBeGreaterThan(seq(1782907200n));
  });

  it("maps pre-base revisions to zero instead of leaking them", () => {
    expect(eventIcs(row(1670000000n), APP_URL)).toContain("SEQUENCE:0\r\n");
  });
});
