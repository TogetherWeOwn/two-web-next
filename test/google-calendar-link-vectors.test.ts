import { describe, expect, it } from "vitest";
import type { events } from "../src/db/admin-schema";
import { googleCalendarUrl } from "../src/events/feeds";

type EventRow = typeof events.$inferSelect;

const row = (overrides: Partial<EventRow> = {}): EventRow => ({
  id: 1,
  eventKey: "01J0000000000000000000ABCD",
  title: "Vector",
  game: null,
  description: null,
  startsAt: new Date("2026-07-15T18:00:00Z"),
  endsAt: new Date("2026-07-15T20:00:00Z"),
  timezone: "Europe/London",
  location: null,
  capacity: null,
  status: "published",
  discordEventId: null,
  discordSyncFailedAt: null,
  discordSyncFailureCode: null,
  createdBy: null,
  rsvpOpen: true,
  recurrenceFrequency: null,
  recurrenceCount: null,
  recurrenceEndsOn: null,
  parentEventId: null,
  recurrenceIndex: null,
  createdAt: new Date("2026-07-01T12:00:00Z"),
  updatedAt: new Date("2026-07-01T12:00:00Z"),
  icsSequence: 0n,
  syncRevision: 1,
  syncedRevision: 0,
  ...overrides,
});

const BASE = "https://calendar.google.com/calendar/render?action=TEMPLATE";
const DATES = "20260715T180000Z%2F20260715T200000Z";

describe("Google Calendar link compatibility vectors", () => {
  // Literal oracles: do not compute expected bytes with the encoder under test.
  it.each([
    {
      name: "RFC3986 punctuation and space escaping",
      value: "O'Brien! (raid)* A & B + C/D",
      encoded: "O%27Brien%21%20%28raid%29%2A%20A%20%26%20B%20%2B%20C%2FD",
    },
    {
      name: "UTF-8 including decomposed accents and supplementary characters",
      value: "Café 東京 🎮 é",
      encoded: "Caf%C3%A9%20%E6%9D%B1%E4%BA%AC%20%F0%9F%8E%AE%20e%CC%81",
    },
    {
      name: "query injection, fragments and already-percent-encoded-looking text",
      value: "&action=DELETE&text=evil+value#fragment?x=1/%20",
      encoded: "%26action%3DDELETE%26text%3Devil%2Bvalue%23fragment%3Fx%3D1%2F%2520",
    },
    {
      name: "unreserved characters remain literal",
      value: "AZaz09-._~",
      encoded: "AZaz09-._~",
    },
  ])("pins exact bytes and decoded semantics for $name in every text field", ({ value, encoded }) => {
    const out = googleCalendarUrl(row({ title: value, description: value, location: value }));
    expect(out).toBe(`${BASE}&text=${encoded}&dates=${DATES}&details=${encoded}&location=${encoded}`);

    const url = new URL(out);
    expect(url.origin).toBe("https://calendar.google.com");
    expect(url.pathname).toBe("/calendar/render");
    expect(url.hash).toBe("");
    expect([...url.searchParams.entries()]).toEqual([
      ["action", "TEMPLATE"],
      ["text", value],
      ["dates", "20260715T180000Z/20260715T200000Z"],
      ["details", value],
      ["location", value],
    ]);
  });

  it.each([
    {
      name: "positive offsets cross back into the previous UTC month",
      start: "2026-08-01T00:15:23+05:30",
      end: "2026-08-01T02:45:47+05:30",
      dates: "20260731T184523Z/20260731T211547Z",
      encodedDates: "20260731T184523Z%2F20260731T211547Z",
    },
    {
      name: "negative offsets cross forward into the next UTC year",
      start: "2026-12-31T22:30:11-07:00",
      end: "2027-01-01T01:05:59-07:00",
      dates: "20270101T053011Z/20270101T080559Z",
      encodedDates: "20270101T053011Z%2F20270101T080559Z",
    },
    {
      name: "each endpoint retains its own offset across a repeated wall hour",
      start: "2026-11-01T01:30:17-04:00",
      end: "2026-11-01T01:15:43-05:00",
      dates: "20261101T053017Z/20261101T061543Z",
      encodedDates: "20261101T053017Z%2F20261101T061543Z",
    },
  ])("uses stored UTC instants: $name", ({ start, end, dates, encodedDates }) => {
    const out = googleCalendarUrl(row({ startsAt: new Date(start), endsAt: new Date(end), timezone: "Pacific/Auckland" }));
    expect(out).toBe(`${BASE}&text=Vector&dates=${encodedDates}`);
    expect([...new URL(out).searchParams.entries()]).toEqual([
      ["action", "TEMPLATE"],
      ["text", "Vector"],
      ["dates", dates],
    ]);
  });

  it.each([
    { description: null, location: null },
    { description: "", location: "" },
    { description: null, location: "" },
    { description: "", location: null },
  ])("omits empty optional fields ($description, $location)", ({ description, location }) => {
    const out = googleCalendarUrl(row({ description, location }));
    expect(out).toBe(`${BASE}&text=Vector&dates=${DATES}`);
    const params = new URL(out).searchParams;
    expect([...params.keys()]).toEqual(["action", "text", "dates"]);
    expect(params.has("details")).toBe(false);
    expect(params.has("location")).toBe(false);
  });

  it.each([
    { description: "Bring stims.", location: "", suffix: "&details=Bring%20stims.", key: "details", value: "Bring stims.", absent: "location" },
    { description: null, location: "Voice: General", suffix: "&location=Voice%3A%20General", key: "location", value: "Voice: General", absent: "details" },
  ])("retains populated $key independently of the absent $absent", ({ description, location, suffix, key, value, absent }) => {
    const out = googleCalendarUrl(row({ description, location }));
    expect(out).toBe(`${BASE}&text=Vector&dates=${DATES}${suffix}`);
    const params = new URL(out).searchParams;
    expect([...params.keys()]).toEqual(["action", "text", "dates", key]);
    expect(params.get(key)).toBe(value);
    expect(params.has(absent)).toBe(false);
  });
});
