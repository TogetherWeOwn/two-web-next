// Spring-gap wall-time parity pin (W15 ledger G1).
// The ledger G1 row cites this suite as its proof.
//
// Parity: legacy refuses spring-forward gap walls with a 422
// (`EventTimezoneTest.php:169-188` create, `:190-205` end, `:269-286` update,
// `:288-293` domain edge via `RealWallTime` + `EventInput::instant` backstop)
// and accepts the shoulders, mapping `2026-03-29 02:30` Europe/London to
// `01:30:00 UTC` (`:247-267`, `:295-300`). Next matches on the single-event
// path (`wallToUtc` throws a ValidationError, surfaced as a 422) and on the
// series minute path (`preciseWallToUtc` delegates the minute to `wallToUtc`).
// The series expansion moves the gap week forward by the gap length
// (`occurrences` via `resolveWall`, src/admin/recurrence.ts: London `01:30`
// seed week lands on the `02:30` wall; Berlin `02:30` seed week lands on the
// `03:30` wall), matching legacy Carbon `addWeeks`
// (`RecurrenceSchedule.php:62-65`). This suite pins the Next contract on both
// paths.
//
// Rationale retained: a silent forward-shift would store a different wall time
// than the moderator typed; the explicit 422 names the gap and forces a real
// choice. There is no divergence: both sides refuse the true London `01:xx`
// gap and both map the shoulders identically. Series continuity is preserved
// where it matters: a weekly slot never vanishes for one week a year, it
// lands on the moved-forward wall.
import { describe, expect, it } from "vitest";
import { occurrences } from "../src/admin/recurrence";
import { preciseWallToUtc } from "../src/admin/recurrence-wall";
import { ValidationError, utcToWall, wallToUtc } from "../src/admin/validation";

const LONDON = "Europe/London";
const BERLIN = "Europe/Berlin";

const fieldsOf = (fn: () => unknown): Record<string, string> => {
  try {
    fn();
  } catch (e) {
    if (e instanceof ValidationError) return { ...e.fields };
    throw e;
  }
  throw new Error("expected a ValidationError");
};

describe("spring-gap parity: single-event path refuses gap walls", () => {
  it("refuses a London gap minute like legacy does", () => {
    // Legacy refuses this gap wall with a 422 (EventTimezoneTest.php:169-188); Next matches.
    expect(fieldsOf(() => wallToUtc("2026-03-29 01:30", LONDON))).toEqual({
      wall: "That time never occurred in Europe/London — clocks skipped forward over it. Pick a time outside the gap.",
    });
  });

  it("refuses a Berlin gap minute, where 02:30 never occurred", () => {
    // Europe/Berlin springs 02:00 CET -> 03:00 CEST on 2026-03-29.
    expect(fieldsOf(() => wallToUtc("2026-03-29 02:30", BERLIN))).toEqual({
      wall: "That time never occurred in Europe/Berlin — clocks skipped forward over it. Pick a time outside the gap.",
    });
  });

  it("maps each moved-to wall to the instant legacy stored for the gap input", () => {
    expect(wallToUtc("2026-03-29 02:30", LONDON).toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(wallToUtc("2026-03-29 03:30", BERLIN).toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });
});

describe("spring-gap parity: series minute path refuses gap minutes too", () => {
  it("reports a London gap minute exactly as wallToUtc does", () => {
    expect(
      fieldsOf(() => preciseWallToUtc({ minute: "2026-03-29 01:30", subMinuteMs: 0 }, LONDON)),
    ).toEqual(fieldsOf(() => wallToUtc("2026-03-29 01:30", LONDON)));
  });

  it("reports a Berlin gap minute exactly as wallToUtc does", () => {
    expect(
      fieldsOf(() => preciseWallToUtc({ minute: "2026-03-29 02:30", subMinuteMs: 0 }, BERLIN)),
    ).toEqual(fieldsOf(() => wallToUtc("2026-03-29 02:30", BERLIN)));
  });

  it("resolves a valid moved-to minute and restores the sub-minute tail", () => {
    expect(
      preciseWallToUtc({ minute: "2026-03-29 02:30", subMinuteMs: 1000 }, LONDON).toISOString(),
    ).toBe("2026-03-29T01:30:01.000Z");
  });
});

describe("spring-gap parity: series expansion moves the gap week forward", () => {
  it("lands a London gap week on the 02:30 wall (01:30Z)", () => {
    const s = wallToUtc("2026-03-22 01:30", LONDON);
    const e = wallToUtc("2026-03-22 01:45", LONDON);
    const o = occurrences(s, e, LONDON, "weekly", 2);
    expect(o.size).toBe(2);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(o.get(2)!.endsAt.toISOString()).toBe("2026-03-29T01:45:00.000Z");
    expect(utcToWall(o.get(2)!.startsAt, LONDON)).toBe("2026-03-29 02:30");
    expect(utcToWall(o.get(2)!.endsAt, LONDON)).toBe("2026-03-29 02:45");
  });

  it("lands a Berlin gap week on the 03:30 wall (01:30Z)", () => {
    const s = wallToUtc("2026-03-22 02:15", BERLIN);
    const e = wallToUtc("2026-03-22 02:45", BERLIN);
    const o = occurrences(s, e, BERLIN, "weekly", 2);
    expect(o.size).toBe(2);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2026-03-29T01:15:00.000Z");
    expect(o.get(2)!.endsAt.toISOString()).toBe("2026-03-29T01:45:00.000Z");
    expect(utcToWall(o.get(2)!.startsAt, BERLIN)).toBe("2026-03-29 03:15");
    expect(utcToWall(o.get(2)!.endsAt, BERLIN)).toBe("2026-03-29 03:45");
  });
});
