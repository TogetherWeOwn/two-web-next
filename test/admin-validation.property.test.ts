// Pure fixtures only: no app, database, network or recurrence materialisation.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  isKnownTimezone,
  parseEventForm,
  utcToWall,
  ValidationError,
  wallToUtc,
} from "../src/admin/validation";

const OPTIONS = { seed: 10849, numRuns: 100 };
const MINUTE = 60_000;
const MAX_CAPACITY = 2_147_483_647; // events.capacity is a Postgres integer.
const ZONES = ["UTC", ...Intl.supportedValuesOf("timeZone")];
const instant = fc.integer({
  min: Date.UTC(2020, 0, 1) / MINUTE,
  max: Date.UTC(2035, 11, 31) / MINUTE,
});
const zone = fc.constantFrom(...ZONES);

const FORM = {
  title: "Game night",
  description: "Boards out",
  location: "Voice: General",
  timezone: "UTC",
  starts_at: "2026-07-15 20:00",
  ends_at: "2026-07-15 22:00",
  capacity: "8",
};

// Independent renderer: do not use utcToWall as the round-trip oracle.
function wallAt(ms: number, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(ms)).map((p) => [p.type, p.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

function expectFieldError(run: () => unknown, field: string): void {
  let error: unknown;
  try {
    run();
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(ValidationError);
  expect((error as ValidationError).fields).toHaveProperty(field);
}

// Known 2026 transitions, including southern-hemisphere and half-hour DST.
// gapWall is the first nonexistent minute; foldFirst is the earlier UTC
// occurrence of the first repeated minute. A fresh parse takes the later
// (second) occurrence, matching legacy/Carbon (TOG-11669).
// No transition detection via SUT.
const TRANSITIONS = [
  {
    zone: "Europe/London",
    gapWall: "2026-03-29 01:00",
    foldFirst: "2026-10-25T00:00:00Z",
    width: 60,
  },
  {
    zone: "Europe/Berlin",
    gapWall: "2026-03-29 02:00",
    foldFirst: "2026-10-25T00:00:00Z",
    width: 60,
  },
  {
    zone: "America/New_York",
    gapWall: "2026-03-08 02:00",
    foldFirst: "2026-11-01T05:00:00Z",
    width: 60,
  },
  {
    zone: "Australia/Sydney",
    gapWall: "2026-10-04 02:00",
    foldFirst: "2026-04-04T15:00:00Z",
    width: 60,
  },
  {
    zone: "Australia/Lord_Howe",
    gapWall: "2026-10-04 02:00",
    foldFirst: "2026-04-04T14:30:00Z",
    width: 30,
  },
];

const safeText = fc
  .array(
    fc.constantFrom("a", "Z", "é", "中", "م", "؜", "👩‍💻", "👨‍👩‍👧‍👦", "❤️‍🔥", "\t", "\n", "\r"),
    { maxLength: 8 },
  )
  .map((tokens) => `x${tokens.join("")}y`);
const forbidden = fc
  .oneof(
    fc.integer({ min: 0, max: 8 }),
    fc.integer({ min: 11, max: 12 }),
    fc.integer({ min: 14, max: 31 }),
    fc.integer({ min: 127, max: 159 }),
    fc.integer({ min: 0x202a, max: 0x202e }),
    fc.integer({ min: 0x2066, max: 0x2069 }),
    fc.constantFrom(0x200b, 0x200c, 0x200d, 0xfeff),
  )
  .map(String.fromCodePoint);

describe("seeded admin event validation properties", () => {
  it("round-trips real wall times across runtime IANA zones and both naive separators", () => {
    fc.assert(
      fc.property(zone, instant, fc.boolean(), (timezone, minute, useT) => {
        expect(isKnownTimezone(timezone)).toBe(true);
        const wall = wallAt(minute * MINUTE, timezone);
        const resolved = wallToUtc(useT ? wall.replace(" ", "T") : wall, timezone);
        expect(wallAt(resolved.getTime(), timezone)).toBe(wall);
        expect(utcToWall(resolved, timezone)).toBe(wall);
      }),
      OPTIONS,
    );
  });

  it("round-trips four-digit wall years when Intl renders fewer than four digits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 100, max: 999 }), (year) => {
        const wall = `${String(year).padStart(4, "0")}-07-15 20:00`;
        const resolved = wallToUtc(wall, "UTC");
        expect(resolved.toISOString()).toBe(wall.replace(" ", "T") + ":00.000Z");
        expect(utcToWall(resolved, "UTC")).toBe(wall);
        expect(
          parseEventForm(
            {
              ...FORM,
              starts_at: wall,
              ends_at: wall.replace("20:00", "22:00"),
            },
            { startsAtUtc: resolved.toISOString() },
          ).startsAtUtc.getTime(),
        ).toBe(resolved.getTime());
      }),
      { ...OPTIONS, examples: [[999], [100]] },
    );
  });

  it("rejects unknown zones and offset-bearing wall input", () => {
    fc.assert(
      fc.property(
        fc.nat(),
        fc.constantFrom("Z", "+01:00", "-05:00", " Europe/London"),
        (n, offset) => {
          expect(isKnownTimezone(`Not/AZone_${n}`)).toBe(false);
          expectFieldError(() => wallToUtc(FORM.starts_at, `Not/AZone_${n}`), "timezone");
          expectFieldError(() => wallToUtc(FORM.starts_at + offset, "UTC"), "wall");
        },
      ),
      OPTIONS,
    );
  });

  for (const transition of TRANSITIONS) {
    it(`${transition.zone}: rejects every generated spring-gap minute, even with an edit carrier`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: transition.width - 1 }), (minute) => {
          const naiveMs =
            Date.parse(transition.gapWall.replace(" ", "T") + ":00Z") + minute * MINUTE;
          const wall = wallAt(naiveMs, "UTC");
          expectFieldError(() => wallToUtc(wall, transition.zone), "wall");
          expectFieldError(
            () =>
              parseEventForm(
                { ...FORM, timezone: transition.zone, starts_at: wall },
                {
                  startsAtUtc: "2026-01-01T12:00:00Z",
                },
              ),
            "starts_at",
          );
        }),
        { ...OPTIONS, examples: [[0], [transition.width - 1]] },
      );
    });

    it(`${transition.zone}: chooses the second fold occurrence and preserves an untouched first occurrence`, () => {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: transition.width - 1 }), (minute) => {
          const first = Date.parse(transition.foldFirst) + minute * MINUTE;
          const second = first + transition.width * MINUTE;
          const wall = wallAt(first, transition.zone);
          expect(wallAt(second, transition.zone)).toBe(wall);
          expect(wallToUtc(wall, transition.zone).getTime()).toBe(second);
          expect(wallToUtc(wall, transition.zone).getTime()).toBe(second);
          const captured = new Date(first + 17_000).toISOString();
          const parsed = parseEventForm(
            {
              ...FORM,
              timezone: transition.zone,
              starts_at: wall.replace(" ", "T"),
              ends_at: wallAt(second + 2 * 60 * MINUTE, transition.zone),
            },
            { startsAtUtc: captured },
          );
          expect(parsed.startsAtUtc.toISOString()).toBe(captured);
          // Equal wall text can still name ordered instants on opposite sides
          // of the fold; end ordering must use the preserved UTC carriers.
          const sameWall = { ...FORM, timezone: transition.zone, starts_at: wall, ends_at: wall };
          expect(
            parseEventForm(sameWall, {
              startsAtUtc: captured,
              endsAtUtc: new Date(second).toISOString(),
            }).endsAtUtc.getTime(),
          ).toBe(second);
          expectFieldError(
            () =>
              parseEventForm(sameWall, {
                startsAtUtc: new Date(second).toISOString(),
                endsAtUtc: captured,
              }),
            "ends_at",
          );
        }),
        { ...OPTIONS, examples: [[0], [transition.width - 1]] },
      );
    });
  }

  for (const field of ["title", "description", "location"] as const) {
    it(`${field}: refuses C0/C1 controls, bidi controls and non-emoji zero-width characters before trimming`, () => {
      fc.assert(
        fc.property(
          safeText,
          forbidden,
          fc.constantFrom("start", "middle", "end"),
          (text, char, position) => {
            const value =
              position === "start"
                ? char + text
                : position === "end"
                  ? text + char
                  : text + char + "plain";
            expectFieldError(() => parseEventForm({ ...FORM, [field]: value }), field);
          },
        ),
        {
          ...OPTIONS,
          examples: [
            ["safe", String.fromCodePoint(0xfeff), "start"],
            ["safe", String.fromCodePoint(0x200d), "middle"],
            ["safe", "\0", "end"],
          ],
        },
      );
    });

    it(`${field}: rejects emoji joiners separated from pictographs by whitespace`, () => {
      fc.assert(
        fc.property(fc.constantFrom("\t", "\n", "\r"), fc.boolean(), (whitespace, beforeJoiner) => {
          const text = beforeJoiner ? `👩${whitespace}‍💻` : `👩‍${whitespace}💻`;
          expectFieldError(() => parseEventForm({ ...FORM, [field]: text }), field);
        }),
        {
          ...OPTIONS,
          examples: [
            ["\n", true],
            ["\t", false],
          ],
        },
      );
    });

    it(`${field}: accepts visible Unicode, emoji joiners and multiline whitespace`, () => {
      fc.assert(
        fc.property(safeText, (text) => {
          expect(parseEventForm({ ...FORM, [field]: text })[field]).toBe(text);
        }),
        OPTIONS,
      );
    });
  }

  it("accepts exactly the positive signed-32-bit capacity range, with blank meaning unlimited", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: MAX_CAPACITY }), (capacity) => {
        expect(parseEventForm({ ...FORM, capacity: String(capacity) }).capacity).toBe(capacity);
      }),
      { ...OPTIONS, examples: [[1], [MAX_CAPACITY]] },
    );
    fc.assert(
      fc.property(fc.constantFrom("", " ", "\t\n"), (capacity) => {
        expect(parseEventForm({ ...FORM, capacity }).capacity).toBeNull();
      }),
      OPTIONS,
    );
  });

  it("rejects out-of-range, fractional and nonnumeric capacities", () => {
    const invalid = fc.oneof(
      fc.integer({ min: -1_000_000, max: 0 }).map(String),
      fc.integer({ min: MAX_CAPACITY + 1, max: Number.MAX_SAFE_INTEGER }).map(String),
      fc.nat().map((n) => `${n}.5`),
      fc.constantFrom("NaN", "Infinity", "1e3", "x", "9".repeat(400)),
    );
    fc.assert(
      fc.property(invalid, (capacity) => {
        expectFieldError(() => parseEventForm({ ...FORM, capacity }), "capacity");
      }),
      { ...OPTIONS, examples: [["2147483648"], ["9".repeat(400)], ["0"]] },
    );
  });

  it("accepts an end iff its resolved UTC instant is strictly after the start", () => {
    fc.assert(
      fc.property(zone, instant, fc.integer({ min: -180, max: 180 }), (timezone, minute, delta) => {
        const starts_at = wallAt(minute * MINUTE, timezone);
        const ends_at = wallAt((minute + delta) * MINUTE, timezone);
        const start = wallToUtc(starts_at, timezone);
        const end = wallToUtc(ends_at, timezone);
        const form = { ...FORM, timezone, starts_at, ends_at };
        if (end > start) {
          const parsed = parseEventForm(form);
          expect(parsed.startsAtUtc.getTime()).toBe(start.getTime());
          expect(parsed.endsAtUtc.getTime()).toBe(end.getTime());
        } else expectFieldError(() => parseEventForm(form), "ends_at");
      }),
      {
        ...OPTIONS,
        examples: [
          ["UTC", Date.UTC(2026, 0, 1) / MINUTE, 0],
          ["UTC", Date.UTC(2026, 0, 1) / MINUTE, 1],
        ],
      },
    );
  });
});
