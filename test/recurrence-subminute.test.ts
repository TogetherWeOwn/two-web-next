import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { occurrences } from "../src/admin/recurrence";
import { materializeRecurringSeries } from "../src/admin/store";
import { events } from "../src/db/admin-schema";
import { utcToWall } from "../src/admin/validation";
import { createMemberDataFixture, type MemberDataFixture } from "./helpers/member-data-db";

// Stored/imported instants can carry more precision than the minute-only form.
describe("recurrence preserves stored sub-minute times", () => {
  it("keeps UTC seed seconds and milliseconds in every child without changing the parent", () => {
    const starts = new Date("2026-10-04T20:00:27.125Z");
    const ends = new Date("2026-10-04T21:00:44.875Z");
    const schedule = occurrences(starts, ends, "UTC", "weekly", 3);
    expect([...schedule.keys()]).toEqual([1, 2, 3]);
    expect(schedule.get(1)!.startsAt).toBe(starts);
    expect(schedule.get(1)!.endsAt).toBe(ends);
    expect(
      [...schedule.values()].map(({ startsAt, endsAt }) => [
        startsAt.toISOString(),
        endsAt.toISOString(),
      ]),
    ).toEqual([
      ["2026-10-04T20:00:27.125Z", "2026-10-04T21:00:44.875Z"],
      ["2026-10-11T20:00:27.125Z", "2026-10-11T21:00:44.875Z"],
      ["2026-10-18T20:00:27.125Z", "2026-10-18T21:00:44.875Z"],
    ]);
    expect(starts.toISOString()).toBe("2026-10-04T20:00:27.125Z");
    expect(ends.toISOString()).toBe("2026-10-04T21:00:44.875Z");
  });

  it("holds London wall precision in ordinary weeks and across the autumn offset change", () => {
    const schedule = occurrences(
      new Date("2026-10-04T19:00:27.125Z"),
      new Date("2026-10-04T20:00:44.875Z"),
      "Europe/London",
      "weekly",
      4,
    );
    expect(
      [...schedule.values()].map(({ startsAt, endsAt }) => [
        startsAt.toISOString(),
        endsAt.toISOString(),
      ]),
    ).toEqual([
      ["2026-10-04T19:00:27.125Z", "2026-10-04T20:00:44.875Z"],
      ["2026-10-11T19:00:27.125Z", "2026-10-11T20:00:44.875Z"],
      ["2026-10-18T19:00:27.125Z", "2026-10-18T20:00:44.875Z"],
      ["2026-10-25T20:00:27.125Z", "2026-10-25T21:00:44.875Z"],
    ]);
    for (const { startsAt, endsAt } of schedule.values()) {
      expect(utcToWall(startsAt, "Europe/London").slice(11)).toBe("20:00");
      expect(endsAt.getTime() - startsAt.getTime()).toBe(3617_750);
    }
  });

  it("preserves precision in a zone with a quarter-hour offset", () => {
    const second = occurrences(
      new Date("2026-10-04T14:15:27.125Z"),
      new Date("2026-10-04T15:15:44.875Z"),
      "Asia/Kathmandu",
      "weekly",
      2,
    ).get(2)!;
    expect(second.startsAt.toISOString()).toBe("2026-10-11T14:15:27.125Z");
    expect(second.endsAt.toISOString()).toBe("2026-10-11T15:15:44.875Z");
    expect(utcToWall(second.startsAt, "Asia/Kathmandu")).toBe("2026-10-11 20:00");
  });

  it("chooses the first occurrence of a fold, including its seconds and milliseconds", () => {
    const schedule = occurrences(
      new Date("2026-10-18T00:30:27.125Z"),
      new Date("2026-10-18T00:45:44.875Z"),
      "Europe/London",
      "weekly",
      3,
    );
    expect(schedule.get(2)!.startsAt.toISOString()).toBe("2026-10-25T00:30:27.125Z");
    expect(schedule.get(2)!.endsAt.toISOString()).toBe("2026-10-25T00:45:44.875Z");
    expect(schedule.get(3)!.startsAt.toISOString()).toBe("2026-11-01T01:30:27.125Z");
  });

  it("moves both gap endpoints forward by the gap length without losing precision", () => {
    const second = occurrences(
      new Date("2027-03-21T01:10:27.125Z"),
      new Date("2027-03-21T01:40:44.875Z"),
      "Europe/London",
      "weekly",
      2,
    ).get(2)!;
    expect(second.startsAt.toISOString()).toBe("2027-03-28T01:10:27.125Z");
    expect(second.endsAt.toISOString()).toBe("2027-03-28T01:40:44.875Z");
    expect(utcToWall(second.startsAt, "Europe/London")).toBe("2027-03-28 02:10");
    expect(utcToWall(second.endsAt, "Europe/London")).toBe("2027-03-28 02:40");
  });

  it.each([
    ["27.125", "27.125"],
    ["27.875", "26.125"],
  ])(
    "retains seed duration when precise gap endpoints collapse or invert (%s to %s)",
    (startTail, endTail) => {
      const starts = new Date(`2027-03-21T01:30:${startTail}Z`);
      const ends = new Date(`2027-03-21T02:30:${endTail}Z`);
      const schedule = occurrences(starts, ends, "Europe/London", "weekly", 3);
      const second = schedule.get(2)!;
      expect(second.startsAt.toISOString()).toBe(`2027-03-28T01:30:${startTail}Z`);
      expect(second.endsAt.toISOString()).toBe(`2027-03-28T02:30:${endTail}Z`);
      expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(
        ends.getTime() - starts.getTime(),
      );
      for (const { startsAt, endsAt } of schedule.values())
        expect(endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
    },
  );

  it("does not apply the duration fallback when gap endpoints remain precisely positive", () => {
    const second = occurrences(
      new Date("2027-03-21T01:30:27.125Z"),
      new Date("2027-03-21T02:30:44.875Z"),
      "Europe/London",
      "weekly",
      2,
    ).get(2)!;
    expect(second.startsAt.toISOString()).toBe("2027-03-28T01:30:27.125Z");
    expect(second.endsAt.toISOString()).toBe("2027-03-28T01:30:44.875Z");
    expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(17_750);
  });

  it("keeps precise collapsed endpoints positive across Lord Howe's half-hour gap", () => {
    const second = occurrences(
      new Date("2027-09-25T15:45:27.125Z"),
      new Date("2027-09-25T16:15:27.125Z"),
      "Australia/Lord_Howe",
      "weekly",
      2,
    ).get(2)!;
    expect(second.startsAt.toISOString()).toBe("2027-10-02T15:45:27.125Z");
    expect(second.endsAt.toISOString()).toBe("2027-10-02T16:15:27.125Z");
    expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(1800_000);
  });

  it("keeps both local dates and precise endpoints of an overnight meeting spanning DST", () => {
    const schedule = occurrences(
      new Date("2027-03-20T23:30:27.125Z"),
      new Date("2027-03-21T02:30:44.875Z"),
      "Europe/London",
      "weekly",
      3,
    );
    expect(schedule.get(2)!.startsAt.toISOString()).toBe("2027-03-27T23:30:27.125Z");
    expect(schedule.get(2)!.endsAt.toISOString()).toBe("2027-03-28T01:30:44.875Z");
    expect(schedule.get(3)!.startsAt.toISOString()).toBe("2027-04-03T22:30:27.125Z");
    expect(schedule.get(3)!.endsAt.toISOString()).toBe("2027-04-04T01:30:44.875Z");
  });

  it("preserves a positive interval whose endpoints are in the same minute", () => {
    const second = occurrences(
      new Date("2026-10-04T20:00:27.125Z"),
      new Date("2026-10-04T20:00:44.875Z"),
      "UTC",
      "weekly",
      2,
    ).get(2)!;
    expect(second.startsAt.toISOString()).toBe("2026-10-11T20:00:27.125Z");
    expect(second.endsAt.toISOString()).toBe("2026-10-11T20:00:44.875Z");
  });

  it("keeps inclusive repeat-until dates and occurrence indexes independent of precision", () => {
    const starts = new Date("2026-10-04T20:00:27.125Z");
    const ends = new Date("2026-10-04T21:00:44.875Z");
    const until = new Date("2026-10-11T00:00:00.000Z");
    expect([...occurrences(starts, ends, "UTC", "weekly", 4, until).keys()]).toEqual([1, 2]);
    expect([...occurrences(starts, ends, "UTC", "weekly", 1, until).keys()]).toEqual([1]);
  });

  it.each(["UTC", "Europe/London", "Asia/Kathmandu"])(
    "leaves minute-aligned ordinary seeds unchanged in %s",
    (timezone) => {
      const second = occurrences(
        new Date("2026-10-04T20:00:00.000Z"),
        new Date("2026-10-04T21:00:00.000Z"),
        timezone,
        "weekly",
        2,
      ).get(2)!;
      expect(second.startsAt.toISOString()).toBe("2026-10-11T20:00:00.000Z");
      expect(second.endsAt.toISOString()).toBe("2026-10-11T21:00:00.000Z");
    },
  );
});

// Import-style rows go directly into the owned fixture schema; they need not
// have passed through the minute-only event form or create-time materialisation.
describe.skipIf(!process.env.DATABASE_URL)(
  "stored sub-minute series reconciliation (agent-testdb)",
  () => {
    let fixture: MemberDataFixture | undefined;
    beforeEach(async () => {
      fixture = await createMemberDataFixture(process.env.DATABASE_URL!);
    });
    afterEach(async () => {
      await fixture?.dispose();
      fixture = undefined;
    });

    it("fills a missing child with stored seed precision without changing parent or existing child identity", async () => {
      const db = fixture!.db;
      const [parent] = await db
        .insert(events)
        .values({
          eventKey: "stored-subminute-parent",
          title: "Imported weekly meeting",
          startsAt: new Date("2026-10-04T19:00:27.125Z"),
          endsAt: new Date("2026-10-04T20:00:44.875Z"),
          timezone: "Europe/London",
          recurrenceFrequency: "weekly",
          recurrenceCount: 3,
          recurrenceIndex: 1,
        })
        .returning();
      const [existing] = await db
        .insert(events)
        .values({
          eventKey: "stored-subminute-skipped-week",
          title: "Skipped imported week",
          startsAt: new Date("2026-10-11T19:00:27.125Z"),
          endsAt: new Date("2026-10-11T20:00:44.875Z"),
          timezone: parent!.timezone,
          parentEventId: parent!.id,
          recurrenceIndex: 2,
          status: "cancelled",
        })
        .returning();

      expect(await materializeRecurringSeries(db)).toBe(1);
      const rows = await db.select().from(events).orderBy(events.recurrenceIndex);
      expect(rows.map((row) => row.recurrenceIndex)).toEqual([1, 2, 3]);
      expect(rows[0]).toEqual(parent);
      expect(rows[1]).toEqual(existing);
      expect(rows[2]).toMatchObject({
        parentEventId: parent!.id,
        recurrenceIndex: 3,
        status: "draft",
      });
      expect(rows[2]!.startsAt.toISOString()).toBe("2026-10-18T19:00:27.125Z");
      expect(rows[2]!.endsAt.toISOString()).toBe("2026-10-18T20:00:44.875Z");
      expect(await materializeRecurringSeries(db)).toBe(0);
      expect(await db.select().from(events).where(eq(events.id, parent!.id))).toEqual([parent]);
      expect(await db.select().from(events).orderBy(events.recurrenceIndex)).toEqual(rows);
    });
  },
);
