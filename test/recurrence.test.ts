import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDb } from "../src/db/index";
import { events } from "../src/db/admin-schema";
import { createEvent, materializeMissingInstances, materializeRecurringSeries, transitionEvent } from "../src/admin/store";
import { MAX_OCCURRENCES, occurrences, parseRecurrenceForm } from "../src/admin/recurrence";
import { ValidationError, utcToWall, wallToUtc } from "../src/admin/validation";
import { eq } from "drizzle-orm";

// Fixtures mirror legacy tests/Unit/Events/RecurrenceScheduleTest.php (two-web main).
const starts = wallToUtc("2026-10-04 20:00", "Europe/London");
const ends = wallToUtc("2026-10-04 21:00", "Europe/London");
const walls = (m: Map<number, { startsAt: Date }>) => [...m.values()].map((o) => utcToWall(o.startsAt, "Europe/London"));

describe("occurrences (legacy RecurrenceSchedule)", () => {
  it("names four weekly occurrences, parent first, holding 20:00 London across the clocks change", () => {
    const o = occurrences(starts, ends, "Europe/London", "weekly", 4);
    expect([...o.keys()]).toEqual([1, 2, 3, 4]);
    expect(walls(o)).toEqual(["2026-10-04 20:00", "2026-10-11 20:00", "2026-10-18 20:00", "2026-10-25 20:00"]);
    // The UTC instant moved an hour on 25 Oct (BST -> GMT); the wall time did not.
    expect(o.get(3)!.startsAt.toISOString()).toBe("2026-10-18T19:00:00.000Z");
    expect(o.get(4)!.startsAt.toISOString()).toBe("2026-10-25T20:00:00.000Z");
  });

  it("keeps the meeting length across the change", () => {
    for (const { startsAt, endsAt } of occurrences(starts, ends, "Europe/London", "weekly", 4).values()) {
      expect(endsAt.getTime() - startsAt.getTime()).toBe(3600_000);
    }
  });

  it("holds wall time across the spring change too", () => {
    const s = wallToUtc("2027-03-21 20:00", "Europe/London");
    const e = wallToUtc("2027-03-21 21:00", "Europe/London");
    expect(walls(occurrences(s, e, "Europe/London", "weekly", 3))).toEqual(["2027-03-21 20:00", "2027-03-28 20:00", "2027-04-04 20:00"]);
  });

  it("moves a spring-gap slot forward instead of dropping the week (Carbon parity)", () => {
    // 01:30 London on 2027-03-21; +1 week is 2027-03-28 01:30, inside the gap -> 02:30 BST.
    const s = wallToUtc("2027-03-21 01:30", "Europe/London");
    const e = wallToUtc("2027-03-21 02:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "weekly", 2);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2027-03-28T01:30:00.000Z");
  });

  it("uses a zone ahead of UTC without shifting repeat-until by a day", () => {
    const s = wallToUtc("2026-10-04 08:00", "Pacific/Auckland");
    const e = wallToUtc("2026-10-04 09:00", "Pacific/Auckland");
    const o = occurrences(s, e, "Pacific/Auckland", "weekly", 52, new Date(Date.UTC(2026, 9, 11)));
    expect(o.size).toBe(2);
  });

  it("applies the tighter of count and repeat-until, and caps at 52", () => {
    expect(occurrences(starts, ends, "Europe/London", "weekly", 52, new Date(Date.UTC(2026, 9, 11))).size).toBe(2);
    expect(occurrences(starts, ends, "Europe/London", "weekly", 2, new Date(Date.UTC(2027, 0, 1))).size).toBe(2);
    expect(occurrences(starts, ends, "Europe/London", "weekly").size).toBe(MAX_OCCURRENCES);
    expect(MAX_OCCURRENCES).toBe(52);
  });
});

describe("parseRecurrenceForm (legacy RecurrenceInput messages)", () => {
  const fieldsOf = (data: Record<string, unknown>) => {
    try {
      parseRecurrenceForm(data);
    } catch (e) {
      if (e instanceof ValidationError) return e.fields;
      throw e;
    }
    return null;
  };

  it("is null for a one-off and a rule for a weekly series", () => {
    expect(parseRecurrenceForm({})).toBeNull();
    expect(parseRecurrenceForm({ recurrence_frequency: "" })).toBeNull();
    expect(parseRecurrenceForm({ recurrence_frequency: "weekly", recurrence_count: "4" })).toMatchObject({ frequency: "weekly", count: 4, endsOn: null });
  });

  it("refuses with the legacy messages", () => {
    expect(fieldsOf({ recurrence_frequency: "daily", recurrence_count: "3" })).toEqual({ recurrence_frequency: "Unknown repeat frequency." });
    expect(fieldsOf({ recurrence_frequency: "weekly" })).toEqual({ recurrence_count: "Give a number of occurrences or a repeat-until date." });
    expect(fieldsOf({ recurrence_frequency: "weekly", recurrence_count: "0" })).toEqual({ recurrence_count: "Occurrences must be between 1 and 52." });
    expect(fieldsOf({ recurrence_frequency: "weekly", recurrence_count: "53" })).toEqual({ recurrence_count: "Occurrences must be between 1 and 52." });
    expect(fieldsOf({ recurrence_frequency: "weekly", recurrence_count: "x" })).toEqual({ recurrence_count: "Occurrences must be between 1 and 52." });
    expect(fieldsOf({ recurrence_frequency: "weekly", recurrence_ends_on: "soon" })).toEqual({ recurrence_ends_on: "The repeat-until date is not a date." });
    expect(
      fieldsOf({ recurrence_frequency: "weekly", recurrence_ends_on: "2026-10-01", starts_at: "2026-10-04 20:00", timezone: "Europe/London" }),
    ).toEqual({ recurrence_ends_on: "The repeat-until date is before the first meeting." });
  });
});

describe.skipIf(!process.env.DATABASE_URL)("series materialisation (agent-testdb)", () => {
  const db = createDb(process.env.DATABASE_URL!);
  const actor = { id: "recurrence-test", username: "mod" };
  const input = { title: "Sunday Squad", game: null, description: null, startsAtUtc: starts, endsAtUtc: ends, timezone: "Europe/London", location: null, capacity: null };
  beforeEach(async () => void (await db.delete(events)));
  afterEach(async () => void (await db.delete(events)));

  it("creates the parent plus missing occurrences as drafts, and re-running creates nothing", async () => {
    const { row } = await createEvent(db, actor, input, { frequency: "weekly", count: 4, endsOn: null });
    const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
    expect(rows.map((r) => r.recurrenceIndex)).toEqual([1, 2, 3, 4]);
    expect(rows.every((r) => r.status === "draft")).toBe(true);
    expect(rows.slice(1).every((r) => r.parentEventId === row.id)).toBe(true);
    expect(await materializeMissingInstances(db, row)).toBe(0);
    expect(await materializeRecurringSeries(db)).toBe(0);
    expect(await db.select().from(events)).toHaveLength(4);
  });

  it("reconcile tops up a missing index and never resurrects a cancelled skipped week", async () => {
    const { row } = await createEvent(db, actor, input, { frequency: "weekly", count: 4, endsOn: null });
    const [third] = await db.select().from(events).where(eq(events.recurrenceIndex, 3));
    await transitionEvent(db, actor, third!.eventKey, "cancelled");
    await db.delete(events).where(eq(events.recurrenceIndex, 4));
    expect(await materializeRecurringSeries(db)).toBe(1);
    const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
    expect(rows.map((r) => [r.recurrenceIndex, r.status])).toEqual([[1, "draft"], [2, "draft"], [3, "cancelled"], [4, "draft"]]);
    expect(row.recurrenceFrequency).toBe("weekly");
  });

  it("does not grow a cancelled series", async () => {
    const { row } = await createEvent(db, actor, input, { frequency: "weekly", count: 3, endsOn: null });
    await transitionEvent(db, actor, row.eventKey, "cancelled");
    await db.delete(events).where(eq(events.recurrenceIndex, 3));
    expect(await materializeRecurringSeries(db)).toBe(0);
  });
});
