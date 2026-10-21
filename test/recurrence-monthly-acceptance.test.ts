// Acceptance: monthly recurrence pattern, written first (red).
//
// The builder implements `monthly` on this branch and never edits this file:
// if an expectation is wrong, send it back to the test author for a rewrite.
// Covers the monthly slice of the recurring-series design: same wall
// day-of-month in the host zone, clamp-not-skip short months, leap February,
// gap/fold reuse, count + repeat-until bounds, and rule immutability.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Db } from "../src/db/index";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";
import { activityLog, events } from "../src/db/admin-schema";
import {
  createEvent,
  materializeMissingInstances,
  materializeRecurringSeries,
  patchEvent,
  transitionEvent,
  updateEvent,
} from "../src/admin/store";
import {
  MAX_OCCURRENCES,
  occurrences,
  parseRecurrenceForm,
  RECURRENCE_FREQUENCIES,
  type RecurrenceFrequency,
} from "../src/admin/recurrence";
import { ValidationError, utcToWall, wallToUtc } from "../src/admin/validation";
import { eq } from "drizzle-orm";

// The implementation does not name this frequency yet; the cast keeps the
// acceptance suite typechecking while the runtime stays red until the slice
// lands. Every monthly expectation below fails on the weekly-only build.
const MONTHLY = "monthly" as unknown as RecurrenceFrequency;

const walls = (m: Map<number, { startsAt: Date }>, timezone: string) =>
  [...m.values()].map((o) => utcToWall(o.startsAt, timezone));

const fieldsOf = (data: Record<string, unknown>): Record<string, string> | null => {
  try {
    parseRecurrenceForm(data);
  } catch (e) {
    if (e instanceof ValidationError) return { ...e.fields };
    throw e;
  }
  return null;
};

describe("monthly frequency registration", () => {
  it("names monthly alongside weekly", () => {
    expect([...RECURRENCE_FREQUENCIES]).toEqual(["weekly", "monthly"]);
  });

  it("keeps the occurrence cap at 52", () => {
    expect(MAX_OCCURRENCES).toBe(52);
  });
});

describe("occurrences monthly (same wall day-of-month)", () => {
  it("steps month to month on the same wall day, parent first", () => {
    const s = wallToUtc("2026-01-15 20:00", "Europe/London");
    const e = wallToUtc("2026-01-15 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect([...o.keys()]).toEqual([1, 2, 3]);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-01-15 20:00",
      "2026-02-15 20:00",
      "2026-03-15 20:00",
    ]);
    expect(o.get(1)!.startsAt.toISOString()).toBe("2026-01-15T20:00:00.000Z");
    expect(o.get(2)!.startsAt.toISOString()).toBe("2026-02-15T20:00:00.000Z");
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-03-15T20:00:00.000Z");
  });

  it("keeps the parent occurrence on the exact seed instants", () => {
    const s = wallToUtc("2026-01-15 20:00", "Europe/London");
    const e = wallToUtc("2026-01-15 21:00", "Europe/London");
    const parent = occurrences(s, e, "Europe/London", MONTHLY, 3).get(1)!;
    expect(parent.startsAt).toBe(s);
    expect(parent.endsAt).toBe(e);
  });

  it("keeps the meeting length on plain months", () => {
    const s = wallToUtc("2026-01-15 20:00", "Europe/London");
    const e = wallToUtc("2026-01-15 21:00", "Europe/London");
    for (const { startsAt, endsAt } of occurrences(s, e, "Europe/London", MONTHLY, 3).values()) {
      expect(endsAt.getTime() - startsAt.getTime()).toBe(3600_000);
    }
  });

  it("holds 20:00 London across the autumn clocks change", () => {
    const s = wallToUtc("2026-08-15 20:00", "Europe/London");
    const e = wallToUtc("2026-08-15 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 4);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-08-15 20:00",
      "2026-09-15 20:00",
      "2026-10-15 20:00",
      "2026-11-15 20:00",
    ]);
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-10-15T19:00:00.000Z");
    expect(o.get(4)!.startsAt.toISOString()).toBe("2026-11-15T20:00:00.000Z");
  });
});

describe("occurrences monthly short-month clamp (never skip)", () => {
  it("clamps the 31st to Feb 28 and recovers to the 31st in March", () => {
    const s = wallToUtc("2026-01-31 20:00", "Europe/London");
    const e = wallToUtc("2026-01-31 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect(o.size).toBe(3);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-01-31 20:00",
      "2026-02-28 20:00",
      "2026-03-31 20:00",
    ]);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2026-02-28T20:00:00.000Z");
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-03-31T19:00:00.000Z");
  });

  it("clamps the 30th to Feb 28 and recovers to the 30th in March", () => {
    const s = wallToUtc("2026-01-30 20:00", "Europe/London");
    const e = wallToUtc("2026-01-30 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-01-30 20:00",
      "2026-02-28 20:00",
      "2026-03-30 20:00",
    ]);
  });

  it("lands a 31st series on Feb 29 in a leap year", () => {
    const s = wallToUtc("2024-01-31 20:00", "Europe/London");
    const e = wallToUtc("2024-01-31 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect(walls(o, "Europe/London")).toEqual([
      "2024-01-31 20:00",
      "2024-02-29 20:00",
      "2024-03-31 20:00",
    ]);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2024-02-29T20:00:00.000Z");
  });

  it("clamps a leap-day series to Feb 28 in the following non-leap year", () => {
    const s = wallToUtc("2024-02-29 20:00", "Europe/London");
    const e = wallToUtc("2024-02-29 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 13);
    expect(o.size).toBe(13);
    expect(walls(o, "Europe/London")[0]).toBe("2024-02-29 20:00");
    expect(walls(o, "Europe/London")[11]).toBe("2025-01-29 20:00");
    expect(walls(o, "Europe/London")[12]).toBe("2025-02-28 20:00");
    expect(o.get(13)!.startsAt.toISOString()).toBe("2025-02-28T20:00:00.000Z");
  });

  it("clamps April, June, September and November to their 30 days", () => {
    const s = wallToUtc("2026-03-31 20:00", "Europe/London");
    const e = wallToUtc("2026-03-31 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 9);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-03-31 20:00",
      "2026-04-30 20:00",
      "2026-05-31 20:00",
      "2026-06-30 20:00",
      "2026-07-31 20:00",
      "2026-08-31 20:00",
      "2026-09-30 20:00",
      "2026-10-31 20:00",
      "2026-11-30 20:00",
    ]);
  });
});

describe("occurrences monthly DST gap and fold", () => {
  it("moves a spring-gap month forward instead of dropping it", () => {
    // 2026-03-29 01:00 GMT -> 02:00 BST: local 01:00-01:59 never happened.
    // The January 29th seed clamps through February, then lands in the gap.
    const s = wallToUtc("2026-01-29 01:30", "Europe/London");
    const e = wallToUtc("2026-01-29 02:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect(o.size).toBe(3);
    expect(walls(o, "Europe/London")[1]).toBe("2026-02-28 01:30");
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(utcToWall(o.get(3)!.startsAt, "Europe/London")).toBe("2026-03-29 02:30");
  });

  it("keeps a gap-collapsed monthly meeting positive from the resolved start", () => {
    // Both endpoints collapse to 01:30Z (02:30 BST), so the occurrence keeps
    // the seed's one-hour length instead of storing a zero-length meeting.
    const s = wallToUtc("2026-01-29 01:30", "Europe/London");
    const e = wallToUtc("2026-01-29 02:30", "Europe/London");
    const third = occurrences(s, e, "Europe/London", MONTHLY, 3).get(3)!;
    expect(third.startsAt.toISOString()).toBe("2026-03-29T01:30:00.000Z");
    expect(third.endsAt.toISOString()).toBe("2026-03-29T02:30:00.000Z");
    expect(third.endsAt.getTime() - third.startsAt.getTime()).toBe(3600_000);
  });

  it("resolves a fold month to the first (summer-time) occurrence", () => {
    // 2026-10-25: 02:00 BST -> 01:00 GMT, so 01:30 names two instants.
    const s = wallToUtc("2026-08-25 01:30", "Europe/London");
    const e = wallToUtc("2026-08-25 02:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", MONTHLY, 3);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-08-25 01:30",
      "2026-09-25 01:30",
      "2026-10-25 01:30",
    ]);
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-10-25T00:30:00.000Z");
  });
});

describe("occurrences monthly bounds", () => {
  const starts = wallToUtc("2026-01-15 20:00", "Europe/London");
  const ends = wallToUtc("2026-01-15 21:00", "Europe/London");

  it("applies the tighter of count and repeat-until, and caps at 52", () => {
    expect(
      occurrences(starts, ends, "Europe/London", MONTHLY, 52, new Date(Date.UTC(2026, 1, 15))).size,
    ).toBe(2);
    expect(
      occurrences(starts, ends, "Europe/London", MONTHLY, 2, new Date(Date.UTC(2030, 0, 1))).size,
    ).toBe(2);
    expect(occurrences(starts, ends, "Europe/London", MONTHLY).size).toBe(MAX_OCCURRENCES);
    expect(occurrences(starts, ends, "Europe/London", MONTHLY, 99).size).toBe(MAX_OCCURRENCES);
  });

  it("uses a zone ahead of UTC without shifting repeat-until by a day", () => {
    const s = wallToUtc("2026-10-04 08:00", "Pacific/Auckland");
    const e = wallToUtc("2026-10-04 09:00", "Pacific/Auckland");
    const o = occurrences(s, e, "Pacific/Auckland", MONTHLY, 52, new Date(Date.UTC(2026, 10, 4)));
    expect(o.size).toBe(2);
    expect(walls(o, "Pacific/Auckland")).toEqual(["2026-10-04 08:00", "2026-11-04 08:00"]);
  });
});

describe("parseRecurrenceForm monthly", () => {
  it("accepts a monthly rule by count and by repeat-until", () => {
    expect(
      parseRecurrenceForm({ recurrence_frequency: "monthly", recurrence_count: "4" }),
    ).toMatchObject({ frequency: "monthly", count: 4, endsOn: null });
    expect(
      parseRecurrenceForm({ recurrence_frequency: "monthly", recurrence_ends_on: "2026-06-15" }),
    ).toMatchObject({ frequency: "monthly", count: null });
  });

  it("requires a number of occurrences or a repeat-until date", () => {
    expect(fieldsOf({ recurrence_frequency: "monthly" })).toEqual({
      recurrence_count: "Give a number of occurrences or a repeat-until date.",
    });
  });

  it("refuses out-of-range and non-integer counts with the legacy message", () => {
    const message = { recurrence_count: "Occurrences must be between 1 and 52." };
    expect(fieldsOf({ recurrence_frequency: "monthly", recurrence_count: "0" })).toEqual(message);
    expect(fieldsOf({ recurrence_frequency: "monthly", recurrence_count: "53" })).toEqual(message);
    expect(fieldsOf({ recurrence_frequency: "monthly", recurrence_count: "x" })).toEqual(message);
    expect(fieldsOf({ recurrence_frequency: "monthly", recurrence_count: "2.5" })).toEqual(message);
  });

  it("refuses an unparsable repeat-until date", () => {
    expect(fieldsOf({ recurrence_frequency: "monthly", recurrence_ends_on: "soon" })).toEqual({
      recurrence_ends_on: "The repeat-until date is not a date.",
    });
  });

  it("refuses a repeat-until date before the first meeting", () => {
    expect(
      fieldsOf({
        recurrence_frequency: "monthly",
        recurrence_ends_on: "2026-01-01",
        starts_at: "2026-01-15 20:00",
        timezone: "Europe/London",
      }),
    ).toEqual({ recurrence_ends_on: "The repeat-until date is before the first meeting." });
  });

  it("still refuses an unknown frequency with the legacy message", () => {
    expect(fieldsOf({ recurrence_frequency: "daily", recurrence_count: "3" })).toEqual({
      recurrence_frequency: "Unknown repeat frequency.",
    });
  });
});

describe("weekly behavior byte-identical", () => {
  const starts = wallToUtc("2026-10-04 20:00", "Europe/London");
  const ends = wallToUtc("2026-10-04 21:00", "Europe/London");

  it("names four weekly occurrences holding 20:00 London across the clocks change", () => {
    const o = occurrences(starts, ends, "Europe/London", "weekly", 4);
    expect([...o.keys()]).toEqual([1, 2, 3, 4]);
    expect(walls(o, "Europe/London")).toEqual([
      "2026-10-04 20:00",
      "2026-10-11 20:00",
      "2026-10-18 20:00",
      "2026-10-25 20:00",
    ]);
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-10-18T19:00:00.000Z");
    expect(o.get(4)!.startsAt.toISOString()).toBe("2026-10-25T20:00:00.000Z");
  });

  it("keeps the weekly form messages verbatim", () => {
    expect(fieldsOf({ recurrence_frequency: "weekly" })).toEqual({
      recurrence_count: "Give a number of occurrences or a repeat-until date.",
    });
    expect(fieldsOf({ recurrence_frequency: "weekly", recurrence_count: "53" })).toEqual({
      recurrence_count: "Occurrences must be between 1 and 52.",
    });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("monthly series materialisation (agent-testdb)", () => {
  let fixture: MemberDataFixture | undefined;
  let db: Db;
  const actor = { id: "monthly-recurrence-test", username: "mod" };
  const starts = wallToUtc("2026-01-15 20:00", "Europe/London");
  const ends = wallToUtc("2026-01-15 21:00", "Europe/London");
  const input = {
    title: "Monthly Game Night",
    game: null,
    description: null,
    startsAtUtc: starts,
    endsAtUtc: ends,
    timezone: "Europe/London",
    location: null,
    capacity: null,
  };

  beforeEach(async () => {
    fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    db = fixture.db;
  });
  afterEach(async () => {
    await fixture?.dispose();
    fixture = undefined;
  });

  it("creates the parent plus missing monthly occurrences as drafts, and re-running creates nothing", async () => {
    const { row } = await createEvent(db, actor, input, {
      frequency: MONTHLY,
      count: 3,
      endsOn: null,
    });
    const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
    expect(rows.map((r) => r.recurrenceIndex)).toEqual([1, 2, 3]);
    expect(rows.every((r) => r.status === "draft")).toBe(true);
    expect(rows.slice(1).every((r) => r.parentEventId === row.id)).toBe(true);
    expect(rows.map((r) => utcToWall(r.startsAt, "Europe/London"))).toEqual([
      "2026-01-15 20:00",
      "2026-02-15 20:00",
      "2026-03-15 20:00",
    ]);
    expect(row.recurrenceFrequency).toBe("monthly");
    const audits = await db.select().from(activityLog);
    expect(audits).toHaveLength(3);
    expect(await materializeMissingInstances(db, row)).toBe(0);
    expect(await materializeRecurringSeries(db)).toBe(0);
    expect(await db.select().from(events)).toHaveLength(3);
    expect(await db.select().from(activityLog)).toEqual(audits);
  });

  it("materializes a clamped 31st series on the last day of February", async () => {
    const jan31 = wallToUtc("2026-01-31 20:00", "Europe/London");
    const jan31End = wallToUtc("2026-01-31 21:00", "Europe/London");
    const { row } = await createEvent(
      db,
      actor,
      { ...input, startsAtUtc: jan31, endsAtUtc: jan31End },
      { frequency: MONTHLY, count: 3, endsOn: null },
    );
    const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
    expect(rows.map((r) => utcToWall(r.startsAt, "Europe/London"))).toEqual([
      "2026-01-31 20:00",
      "2026-02-28 20:00",
      "2026-03-31 20:00",
    ]);
    expect(row.recurrenceFrequency).toBe("monthly");
  });

  it("reconcile tops up a missing monthly index and never resurrects a cancelled skipped month", async () => {
    await createEvent(db, actor, input, {
      frequency: MONTHLY,
      count: 3,
      endsOn: null,
    });
    const [second] = await db.select().from(events).where(eq(events.recurrenceIndex, 2));
    await transitionEvent(db, actor, second!.eventKey, "cancelled");
    await db.delete(events).where(eq(events.recurrenceIndex, 3));
    const auditsBefore = await db.select().from(activityLog);
    expect(await materializeRecurringSeries(db)).toBe(1);
    const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
    expect(rows.map((r) => [r.recurrenceIndex, r.status])).toEqual([
      [1, "draft"],
      [2, "cancelled"],
      [3, "draft"],
    ]);
    expect(utcToWall(rows[2]!.startsAt, "Europe/London")).toBe("2026-03-15 20:00");
    const auditsAfter = await db.select().from(activityLog);
    expect(auditsAfter).toHaveLength(auditsBefore.length + 1);
    expect(await materializeRecurringSeries(db)).toBe(0);
    expect(await db.select().from(activityLog)).toEqual(auditsAfter);
  });

  it("does not grow a cancelled monthly series", async () => {
    const { row } = await createEvent(db, actor, input, {
      frequency: MONTHLY,
      count: 3,
      endsOn: null,
    });
    await transitionEvent(db, actor, row.eventKey, "cancelled");
    await db.delete(events).where(eq(events.recurrenceIndex, 3));
    expect(await materializeRecurringSeries(db)).toBe(0);
  });

  it("leaves the rule columns immutable across update and patch edits", async () => {
    const { row } = await createEvent(db, actor, input, {
      frequency: MONTHLY,
      count: 3,
      endsOn: null,
    });
    // The edit forms carry no rule fields: moving the parent must not rewrite
    // the stored pattern, and forged rule keys on a patch must not apply.
    const moved = wallToUtc("2026-01-16 20:00", "Europe/London");
    const movedEnd = wallToUtc("2026-01-16 21:00", "Europe/London");
    const updated = await updateEvent(db, actor, row.eventKey, {
      ...input,
      startsAtUtc: moved,
      endsAtUtc: movedEnd,
    });
    expect(updated.row.recurrenceFrequency).toBe("monthly");
    expect(updated.row.recurrenceCount).toBe(3);
    expect(updated.row.recurrenceEndsOn).toBeNull();
    const patched = await patchEvent(db, actor, row.eventKey, {
      recurrence_frequency: "weekly",
      recurrence_count: "9",
      recurrence_ends_on: "2027-01-01",
    });
    expect(patched.row.recurrenceFrequency).toBe("monthly");
    expect(patched.row.recurrenceCount).toBe(3);
    expect(patched.row.recurrenceEndsOn).toBeNull();
  });
});
