// Acceptance-owned: builder seam only; no query changes or external I/O.
// Catches NaN/expanded-year wire output, collection-wide data loss, unsafe
// diagnostics, broad exception swallowing, and accidental identity/clock repair.
import { afterEach, describe, expect, it, vi } from "vitest";
import { IcsSequenceRangeError, eventIcs, eventsIcsCollection } from "../src/events/feeds";
import {
  APP_URL,
  KEY,
  OTHER_KEY,
  calendarBytes,
  calendarRow,
  healthyVevent,
} from "./helpers/ics-wire-fixture";

const fields = ["updatedAt", "startsAt", "endsAt"] as const;
const poisonDates = [
  ["invalid Date", NaN],
  ["positive infinity", Infinity],
  ["negative infinity", -Infinity],
  ["outside JS Date", 8.64e15 + 1],
  ["year 10000", "+010000-01-02T03:04:05Z"],
  ["negative year", "-000001-01-02T03:04:05Z"],
  ["maximum finite Date", 8.64e15],
  ["minimum finite Date", -8.64e15],
] as const;
const poisonCases = fields.flatMap((field) =>
  poisonDates.map(([label, instant]) => ({ field, label, instant })),
);

function captureLogs(): unknown[][] {
  const calls: unknown[][] = [];
  for (const level of ["warn", "error", "info", "log"] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => calls.push(args));
  }
  return calls;
}

// Permit structured counters or prose without pinning a logger name/schema.
function loggedCounts(calls: unknown[][]): number[] {
  const found: number[] = [];
  const visit = (value: unknown, key = "") => {
    if (typeof value === "number" && /skip|count/i.test(key)) found.push(value);
    else if (typeof value === "string") {
      for (const match of value.matchAll(/skip\w*\D{0,24}(\d+)/gi)) found.push(Number(match[1]));
      for (const match of value.matchAll(/(\d+)\D{0,24}skip/gi)) found.push(Number(match[1]));
    } else if (Array.isArray(value)) value.forEach((entry) => visit(entry, key));
    else if (value && typeof value === "object")
      for (const [name, entry] of Object.entries(value)) visit(entry, `${key}.${name}`);
  };
  visit(calls);
  return found;
}

function expectTimestampEvidence(calls: unknown[][], skipped: number) {
  expect(loggedCounts(calls), "timestamp skips need a count").toContain(skipped);
  expect(JSON.stringify(calls), "timestamp skips need a safe reason").toMatch(
    /timestamp|instant|dtstamp|dtstart|dtend|non.?finite|year|wire|date/i,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("ICS refuses non-wire timestamps at the builder seam", () => {
  it.each(poisonCases)(
    "rejects $field: $label rather than returning corrupt bytes",
    ({ field, instant }) => {
      const event = calendarRow({ [field]: new Date(instant) });
      expect(() => eventIcs(event, APP_URL)).toThrow();
      // Refusal must not silently repair the row or subscriber revision.
      expect(Object.is(event[field].getTime(), new Date(instant).getTime())).toBe(true);
      expect(event.eventKey).toBe(KEY);
      expect(event.icsSequence).toBe(1782907200n);
    },
  );

  it.each(poisonCases)(
    "skips only the $field / $label row, preserving healthy bytes",
    ({ field, instant }) => {
      const calls = captureLogs();
      const poison = calendarRow({
        [field]: new Date(instant),
        title: "private-poison-title",
        description: "private-poison-description",
        location: "private-poison-location",
      });
      const good = calendarRow({ id: 2, eventKey: OTHER_KEY });
      expect(eventsIcsCollection([poison, good], APP_URL)).toBe(
        calendarBytes(healthyVevent(OTHER_KEY)),
      );
      expectTimestampEvidence(calls, 1);
      const evidence = JSON.stringify(calls);
      for (const privateValue of [KEY, poison.title, poison.description!, poison.location!])
        expect(evidence).not.toContain(privateValue);
    },
  );

  it.each([
    ["0001", "00010102T030405Z", "00010102T030406Z"],
    ["0009", "00090102T030405Z", "00090102T030406Z"],
    ["0099", "00990102T030405Z", "00990102T030406Z"],
    ["0100", "01000102T030405Z", "01000102T030406Z"],
    ["0999", "09990102T030405Z", "09990102T030406Z"],
    ["1000", "10000102T030405Z", "10000102T030406Z"],
    ["9999", "99990102T030405Z", "99990102T030406Z"],
  ])(
    "emits supported year %s as exactly four digits for all three properties",
    (year, expected, expectedEnd) => {
      const calls = captureLogs();
      const instant = new Date(`${year}-01-02T03:04:05Z`);
      const event = calendarRow({
        updatedAt: instant,
        startsAt: instant,
        endsAt: new Date(instant.getTime() + 1000),
      });
      for (const out of [eventIcs(event, APP_URL), eventsIcsCollection([event], APP_URL)]) {
        expect(out).toContain(`DTSTAMP:${expected}\r\n`);
        expect(out).toContain(`DTSTART:${expected}\r\n`);
        expect(out).toContain(`DTEND:${expectedEnd}\r\n`);
        expect(out.match(/^(?:DTSTAMP|DTSTART|DTEND):\d{8}T\d{6}Z\r?$/gm)).toHaveLength(3);
        expect(out).toContain(`UID:${KEY}@next.example.test\r\n`);
        expect(out).toContain("SEQUENCE:82907200\r\n");
      }
      expect(calls).toEqual([]);
    },
  );

  it("bounds diagnostics by reason rather than by poisoned event count", () => {
    const calls = captureLogs();
    const poison = Array.from({ length: 128 }, (_, id) =>
      calendarRow({
        id,
        updatedAt: new Date(NaN),
        title: `sensitive-title-${id}`,
        description: `sensitive-description-${id}`,
        location: `sensitive-location-${id}`,
      }),
    );
    expect(
      eventsIcsCollection(
        [...poison.slice(0, 64), calendarRow({ eventKey: OTHER_KEY }), ...poison.slice(64)],
        APP_URL,
      ),
    ).toBe(calendarBytes(healthyVevent(OTHER_KEY)));
    expectTimestampEvidence(calls, 128);
    expect(calls.length).toBeLessThanOrEqual(8);
    expect(JSON.stringify(calls).length).toBeLessThanOrEqual(2048);
    expect(JSON.stringify(calls)).not.toMatch(/sensitive-|01ARZ3NDEKTSV4RRFFQ69G5FA/);
  });

  it("returns an empty valid calendar, not a failure, if all timestamps are poison", () => {
    const calls = captureLogs();
    expect(eventsIcsCollection([calendarRow({ updatedAt: new Date(NaN) })], APP_URL)).toBe(
      calendarBytes(),
    );
    expectTimestampEvidence(calls, 1);
  });

  it("keeps sequence-range skips alongside timestamp skips and healthy rows in order", () => {
    captureLogs();
    expect(
      eventsIcsCollection(
        [
          calendarRow(),
          calendarRow({ updatedAt: new Date(NaN) }),
          calendarRow({ icsSequence: -1n }),
          calendarRow({ icsSequence: 2147483648n }),
          calendarRow({ eventKey: OTHER_KEY, id: 2 }),
        ],
        APP_URL,
      ),
    ).toBe(calendarBytes(healthyVevent(), healthyVevent(OTHER_KEY)));
  });

  it.each(["updatedAt", "title"] as const)(
    "propagates unexpected RangeError from %s, not an empty feed",
    (field) => {
      captureLogs();
      const event = calendarRow();
      const unexpected = new RangeError("synthetic decoder defect");
      Object.defineProperty(event, field, {
        get() {
          throw unexpected;
        },
      });
      expect(() => eventIcs(event, APP_URL)).toThrow(unexpected);
      expect(() =>
        eventsIcsCollection([calendarRow({ eventKey: OTHER_KEY }), event], APP_URL),
      ).toThrow(unexpected);
    },
  );

  it("keeps invalid base URL errors distinct from skippable timestamp poison", () => {
    expect(() => eventsIcsCollection([calendarRow()], "not a URL")).toThrow();
  });
});

describe("healthy ICS retains identity, revision and clock semantics", () => {
  it("keeps complete healthy bytes and does not log skips", () => {
    const calls = captureLogs();
    expect(eventIcs(calendarRow(), APP_URL)).toBe(calendarBytes(healthyVevent()));
    expect(eventsIcsCollection([calendarRow()], APP_URL)).toBe(calendarBytes(healthyVevent()));
    expect(eventsIcsCollection([], APP_URL)).toBe(calendarBytes());
    expect(calls).toEqual([]);
  });

  it("takes DTSTAMP from updatedAt in UTC, truncating milliseconds, not the wall clock", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2040-01-01T00:00:00Z"));
    const event = calendarRow({ updatedAt: new Date("2026-07-01T14:00:00.999+02:00") });
    expect(eventIcs(event, APP_URL)).toBe(calendarBytes(healthyVevent()));
    vi.setSystemTime(new Date("2050-01-01T00:00:00Z"));
    expect(eventIcs(event, APP_URL)).toBe(calendarBytes(healthyVevent()));
    event.updatedAt = new Date("2026-07-02T12:00:00Z");
    expect(eventIcs(event, APP_URL)).toBe(
      calendarBytes(healthyVevent()).replace(
        "DTSTAMP:20260701T120000Z",
        "DTSTAMP:20260702T120000Z",
      ),
    );
    expect(event.icsSequence).toBe(1782907200n);
    expect(event.eventKey).toBe(KEY);
  });

  it.each([
    [0n, "0"],
    [2147483647n, "447483647"],
  ] as const)("preserves the sequence mapping for %s", (icsSequence, emitted) => {
    expect(eventIcs(calendarRow({ icsSequence }), APP_URL)).toContain(`SEQUENCE:${emitted}\r\n`);
  });

  it.each([-1n, 2147483648n])(
    "still identifies sequence exhaustion %s on a single event",
    (icsSequence) => {
      expect(() => eventIcs(calendarRow({ icsSequence }), APP_URL)).toThrow(IcsSequenceRangeError);
    },
  );
});
