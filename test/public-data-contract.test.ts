import { describe, expect, it } from "vitest";
import {
  PUBLIC_DATA_BOUNDS,
  PUBLIC_DATA_ERROR_CODES,
  PUBLIC_DATA_EXCLUSIONS,
  PUBLIC_EVENT_STATUS,
  parsePublicEventId,
} from "../src/public-data/contracts";

describe("public data contract", () => {
  it("bounds collection reads to the established default and maximum page sizes", () => {
    expect(PUBLIC_DATA_BOUNDS).toEqual({ defaultPageSize: 20, maxPageSize: 100 });
  });

  it("defines the only public event status and canonicalizes case-variant ULID keys", () => {
    expect(PUBLIC_EVENT_STATUS).toBe("published");
    expect(parsePublicEventId("01J00000000000000000000001")).toBe("01J00000000000000000000001");
    expect(parsePublicEventId("01j00000000000000000000001")).toBe("01J00000000000000000000001");
    expect(parsePublicEventId("Y1J00000000000000000000001")).toBeNull();
    expect(parsePublicEventId("987654321")).toBeNull();
  });

  it("keeps one public read error vocabulary and documents data exclusions", () => {
    expect(PUBLIC_DATA_ERROR_CODES).toEqual([
      "internal",
      "invalid_request",
      "not_found",
      "rate_limited",
      "unavailable",
    ]);
    expect(PUBLIC_DATA_EXCLUSIONS).toContain("attendee identities and RSVP records");
    expect(PUBLIC_DATA_EXCLUSIONS).toContain("raw Discord identifiers");
    expect(PUBLIC_DATA_EXCLUSIONS).toContain("viewer-specific RSVP or waitlist state");
  });
});
