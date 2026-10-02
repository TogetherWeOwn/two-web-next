// Precise wall round-trip (TOG-12106): `src/admin/recurrence-wall.ts` keeps Date
// precision separate from minute-only form text — fold/gap policy resolves at
// the minute via wallToUtc, then the seed's seconds/milliseconds restore. Pure
// unit, no DB. Fold policy itself is owned by TOG-11669; this suite pins minute
// delegation (precise == wall + sub), so a policy change updates one expectation.
import { describe, expect, it } from "vitest";
import { preciseWallToUtc, utcToPreciseWall } from "../src/admin/recurrence-wall";
import { ValidationError, wallToUtc } from "../src/admin/validation";

const fieldsOf = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return { ...e.fields };
    throw e;
  }
  throw new Error("expected a ValidationError");
};

describe("precise wall round-trip across zones", () => {
  it.each([
    ["2026-07-15T19:00:27.125Z", "Europe/London", "2026-07-15 20:00", 27125], // BST
    ["2026-01-15T20:00:44.875Z", "Europe/London", "2026-01-15 20:00", 44875], // GMT
    ["2026-07-15T20:00:00.000Z", "UTC", "2026-07-15 20:00", 0],
    ["2026-07-15T19:00:27.125Z", "America/New_York", "2026-07-15 15:00", 27125],
    ["2026-10-04T14:15:27.125Z", "Asia/Kathmandu", "2026-10-04 20:00", 27125], // +5:45
    ["2026-10-04T14:15:27.125Z", "Australia/Lord_Howe", "2026-10-05 01:15", 27125],
    ["2026-07-15T19:00:27.125Z", "Pacific/Kiritimati", "2026-07-16 09:00", 27125], // +14, date rollover
  ])(
    "splits %s in %s into minute %s + %sms and restores it",
    (iso, timezone, minute, subMinuteMs) => {
      expect(utcToPreciseWall(new Date(iso), timezone)).toEqual({ minute, subMinuteMs });
      expect(
        preciseWallToUtc(utcToPreciseWall(new Date(iso), timezone), timezone).toISOString(),
      ).toBe(iso);
    },
  );
});

describe("sub-minute millisecond restoration", () => {
  it.each([0, 1, 1000, 27125, 44875, 59999])(
    "round-trips %sms without touching the minute",
    (sub) => {
      const instant = new Date(
        `2026-10-04T20:00:${String(Math.floor(sub / 1000)).padStart(2, "0")}.${String(sub % 1000).padStart(3, "0")}Z`,
      );
      const wall = utcToPreciseWall(instant, "UTC");
      expect(wall).toEqual({ minute: "2026-10-04 20:00", subMinuteMs: sub });
      expect(preciseWallToUtc(wall, "UTC").toISOString()).toBe(instant.toISOString());
    },
  );

  it("restores the exact tail across a zone with a non-hour offset", () => {
    expect(
      preciseWallToUtc(
        { minute: "2026-10-04 20:00", subMinuteMs: 27125 },
        "Asia/Kathmandu",
      ).toISOString(),
    ).toBe("2026-10-04T14:15:27.125Z");
  });
});

describe("fold/gap minute delegation passthrough", () => {
  // 2026-10-25: Europe/London falls back 02:00 BST -> 01:00 GMT, so wall 01:30
  // names two instants. Minute text alone cannot tell them apart:
  it("renders both sides of the fold as the same minute text", () => {
    expect(utcToPreciseWall(new Date("2026-10-25T00:30:27.125Z"), "Europe/London")).toEqual({
      minute: "2026-10-25 01:30",
      subMinuteMs: 27125,
    });
    expect(utcToPreciseWall(new Date("2026-10-25T01:30:27.125Z"), "Europe/London")).toEqual({
      minute: "2026-10-25 01:30",
      subMinuteMs: 27125,
    });
  });

  it("applies the minute's fold resolution, then restores the sub-minute tail", () => {
    const minute = wallToUtc("2026-10-25 01:30", "Europe/London", "earlier");
    for (const subMinuteMs of [0, 27125, 59999]) {
      expect(
        preciseWallToUtc({ minute: "2026-10-25 01:30", subMinuteMs }, "Europe/London").getTime(),
      ).toBe(minute.getTime() + subMinuteMs);
    }
  });

  it("resolves the fold minute to the first (BST) occurrence under the current policy", () => {
    // Owned by TOG-11669: if the fold decision changes, this one expectation moves with it.
    expect(
      preciseWallToUtc(
        { minute: "2026-10-25 01:30", subMinuteMs: 27125 },
        "Europe/London",
      ).toISOString(),
    ).toBe("2026-10-25T00:30:27.125Z");
  });

  it("refuses a gap minute with the wall parser's own error, whatever the sub-minute tail", () => {
    // 2026-03-29 01:00 GMT -> 02:00 BST: local 01:00-01:59 never happened.
    for (const subMinuteMs of [0, 27125]) {
      expect(
        fieldsOf(() =>
          preciseWallToUtc({ minute: "2026-03-29 01:30", subMinuteMs }, "Europe/London"),
        ),
      ).toEqual(fieldsOf(() => wallToUtc("2026-03-29 01:30", "Europe/London")));
    }
    expect(
      fieldsOf(() =>
        preciseWallToUtc({ minute: "2026-03-29 01:30", subMinuteMs: 0 }, "Europe/London"),
      ),
    ).toEqual({
      wall: "That time never occurred in Europe/London — clocks skipped forward over it. Pick a time outside the gap.",
    });
  });

  it("restores the tail on the gap shoulders", () => {
    expect(
      preciseWallToUtc(
        { minute: "2026-03-29 00:59", subMinuteMs: 27125 },
        "Europe/London",
      ).toISOString(),
    ).toBe("2026-03-29T00:59:27.125Z");
    expect(
      preciseWallToUtc(
        { minute: "2026-03-29 02:00", subMinuteMs: 1000 },
        "Europe/London",
      ).toISOString(),
    ).toBe("2026-03-29T01:00:01.000Z");
  });
});

describe("era and nonfinite-adjacent minute text", () => {
  it.each([
    ["0100-06-15T12:00:27.125Z", "0100-06-15 12:00"],
    ["1969-12-31T23:59:59.999Z", "1969-12-31 23:59"],
    ["2024-02-29T12:00:01.000Z", "2024-02-29 12:00"],
    ["9999-12-31T23:59:59.999Z", "9999-12-31 23:59"],
  ])("round-trips %s at the edge of the calendar", (iso, minute) => {
    expect(utcToPreciseWall(new Date(iso), "UTC").minute).toBe(minute);
    expect(preciseWallToUtc(utcToPreciseWall(new Date(iso), "UTC"), "UTC").toISOString()).toBe(iso);
  });

  it.each(["0000-01-01 00:00", "0001-01-01 00:00", "0099-06-15 12:00"])(
    "delegates %s to the wall parser instead of inventing an era rule",
    (minute) => {
      // Years 0-99 hit Date.UTC's 1900-shift inside the minute resolver; the
      // precise layer reports the parser's own verdict, byte for byte.
      expect(fieldsOf(() => preciseWallToUtc({ minute, subMinuteMs: 0 }, "UTC"))).toEqual(
        fieldsOf(() => wallToUtc(minute, "UTC")),
      );
    },
  );

  it("rejects a non-leap February 29th like the wall parser does", () => {
    expect(
      fieldsOf(() => preciseWallToUtc({ minute: "2026-02-29 12:00", subMinuteMs: 0 }, "UTC")),
    ).toEqual(fieldsOf(() => wallToUtc("2026-02-29 12:00", "UTC")));
  });

  it("refuses nonfinite instants instead of splitting them", () => {
    for (const instant of [new Date(NaN), new Date(Infinity), new Date(-Infinity)]) {
      expect(() => utcToPreciseWall(instant, "UTC")).toThrow(RangeError);
    }
  });

  it("yields an Invalid Date for a nonfinite sub-minute tail rather than clamping it", () => {
    for (const subMinuteMs of [NaN, Infinity, -Infinity]) {
      expect(
        preciseWallToUtc({ minute: "2026-07-15 20:00", subMinuteMs }, "UTC").getTime(),
      ).toBeNaN();
    }
  });
});

describe("invalid minute text delegates to the wall parser", () => {
  it.each([[""], ["2026-07-15T20:00:00+02:00"], ["2026-02-30 20:00"]])(
    "reports %j exactly as wallToUtc does",
    (minute) => {
      expect(fieldsOf(() => preciseWallToUtc({ minute, subMinuteMs: 0 }, "Europe/London"))).toEqual(
        fieldsOf(() => wallToUtc(minute, "Europe/London")),
      );
    },
  );

  it("reports an unknown zone exactly as wallToUtc does", () => {
    expect(
      fieldsOf(() =>
        preciseWallToUtc({ minute: "2026-07-15 20:00", subMinuteMs: 0 }, "Mars/Olympus"),
      ),
    ).toEqual({
      timezone: "Unknown timezone: Mars/Olympus",
    });
  });
});
