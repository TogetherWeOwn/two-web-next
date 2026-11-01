import { describe, expect, it } from "vitest";
import {
  EVENTS_SEARCH_TOO_LONG_TITLE,
  eventsTitle,
  hotzonesTitle,
  pastEventsTitle,
} from "../src/seo";

describe("eventsTitle", () => {
  it("keeps the plain list title when the query is omitted", () => {
    expect(eventsTitle({ view: "list", month: "2030-06" })).toBe("Events");
  });

  it.each([undefined, null, "", " \t\n "])(
    "keeps the plain list title for an empty query %j",
    (q) => {
      expect(eventsTitle({ view: "list", month: "2030-06", q })).toBe("Events");
    },
  );

  it.each([
    ["2030-01", "Events — January 2030"],
    ["2030-02", "Events — February 2030"],
    ["2030-03", "Events — March 2030"],
    ["2030-04", "Events — April 2030"],
    ["2030-05", "Events — May 2030"],
    ["2030-06", "Events — June 2030"],
    ["2030-07", "Events — July 2030"],
    ["2030-08", "Events — August 2030"],
    ["2030-09", "Events — September 2030"],
    ["2030-10", "Events — October 2030"],
    ["2030-11", "Events — November 2030"],
    ["2030-12", "Events — December 2030"],
  ])("names the calendar month %s", (month, title) => {
    expect(eventsTitle({ view: "calendar", month })).toBe(title);
  });

  it.each([undefined, null, "", " \t\n "])(
    "preserves the calendar month for an empty query %j",
    (q) => {
      expect(eventsTitle({ view: "calendar", month: "2030-06", q })).toBe("Events — June 2030");
    },
  );

  it.each([
    "",
    "2030-00",
    "2030-13",
    "2030-6",
    "030-06",
    "20300-06",
    "2030-06-01",
    " 2030-06",
    "June 2030",
  ])("falls back to Events for malformed calendar month %j", (month) => {
    expect(eventsTitle({ view: "calendar", month })).toBe("Events");
  });

  it.each([undefined, null])(
    "falls back to Events for runtime-nullish calendar month %j",
    (month) => {
      // @ts-expect-error Deliberately exercise runtime fallback outside the string-only month contract.
      expect(eventsTitle({ view: "calendar", month })).toBe("Events");
    },
  );

  it.each(["list", "calendar"])("gives trimmed search precedence in %s view", (view) => {
    expect(eventsTitle({ view, month: "2030-06", q: " \tRaid night\n " })).toBe(
      "Events matching “Raid night”",
    );
  });

  it("gives search precedence even when the calendar month is malformed", () => {
    expect(eventsTitle({ view: "calendar", month: "not-a-month", q: "Raids" })).toBe(
      "Events matching “Raids”",
    );
  });
});

describe("discovery search title bounds", () => {
  it.each([
    [" 0123456789012345678901234567890123456789 ", "0123456789012345678901234567890123456789"],
    ["01234567890123456789012345678901234567890", "0123456789012345678901234567890123456789…"],
    [" 012345678901234567890123456789012345678🚀 ", "012345678901234567890123456789012345678🚀"],
    ["012345678901234567890123456789012345678🚀x", "012345678901234567890123456789012345678🚀…"],
  ])("trims and caps %j at 40 code points without splitting a surrogate pair", (q, query) => {
    expect(eventsTitle({ view: "calendar", month: "2030-06", q })).toBe(
      `Events matching “${query}”`,
    );
    expect(pastEventsTitle(7, q)).toBe(`Past events matching “${query}”`);
  });

  it("leaves escaping and the site suffix to the renderer", () => {
    const q = '<raid & "friends">';
    expect(eventsTitle({ view: "list", month: "2030-06", q })).toBe(
      'Events matching “<raid & "friends">”',
    );
    expect(pastEventsTitle(1, q)).toBe('Past events matching “<raid & "friends">”');
  });

  it("exports the refused overlong-search title without a site suffix", () => {
    expect(EVENTS_SEARCH_TOO_LONG_TITLE).toBe("Events — search too long");
  });
});

describe("pastEventsTitle", () => {
  it.each([
    [-1, "Past events"],
    [0, "Past events"],
    [1, "Past events"],
    [2, "Past events — page 2"],
    [23, "Past events — page 23"],
  ])("names archive page %i when the query is omitted", (page, title) => {
    expect(pastEventsTitle(page)).toBe(title);
  });

  it.each([undefined, null, "", " \t\n "])(
    "keeps archive pagination for an empty query %j",
    (q) => {
      expect(pastEventsTitle(1, q)).toBe("Past events");
      expect(pastEventsTitle(3, q)).toBe("Past events — page 3");
    },
  );

  it.each([1, 3])("gives trimmed search precedence over archive page %i", (page) => {
    expect(pastEventsTitle(page, " \tRaid night\n ")).toBe("Past events matching “Raid night”");
  });
});

describe("hotzonesTitle", () => {
  it.each([
    ["all", "Hot zones"],
    ["2030-Q1", "Hot zones — 2030-Q1"],
    ["2030-Q4", "Hot zones — 2030-Q4"],
  ])("names the season %s without a site suffix", (season, title) => {
    expect(hotzonesTitle(season)).toBe(title);
  });
});
