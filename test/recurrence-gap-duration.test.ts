import { describe, expect, it } from "vitest";
import { occurrences } from "../src/admin/recurrence";
import { utcToWall, wallToUtc } from "../src/admin/validation";

// Spring-forward gap resolution can map an occurrence's start and end walls to
// the same instant (Europe/London 2027-03-28: 01:30 in the gap and 02:30 after
// it are both 01:30Z). A zero-length occurrence would fail the event parser's
// strictly-positive interval rule, so the expansion falls back to the seed's
// elapsed duration measured from the resolved start.
describe("occurrences across spring-forward gaps", () => {
  it("keeps a one-hour London meeting positive when both endpoints collapse to 01:30Z", () => {
    // 2027-03-28 01:30 London is inside the 01:00->02:00 gap and resolves to
    // 02:30 local; the 02:30 end also resolves to that instant.
    const s = wallToUtc("2027-03-21 01:30", "Europe/London");
    const e = wallToUtc("2027-03-21 02:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "weekly", 2);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2027-03-28T01:30:00.000Z");
    expect(o.get(2)!.endsAt.toISOString()).toBe("2027-03-28T02:30:00.000Z");
    expect(o.get(2)!.endsAt.getTime() - o.get(2)!.startsAt.getTime()).toBe(3600_000);
  });

  it("keeps a half-hour Lord Howe meeting positive across the 30-minute gap", () => {
    // Australia/Lord_Howe springs forward 02:00->02:30 on 2027-10-03, so the
    // 02:15 start shifts to 02:45 where the 02:45 end already resolves.
    const s = wallToUtc("2027-09-26 02:15", "Australia/Lord_Howe");
    const e = wallToUtc("2027-09-26 02:45", "Australia/Lord_Howe");
    const o = occurrences(s, e, "Australia/Lord_Howe", "weekly", 2);
    expect(o.get(2)!.startsAt.toISOString()).toBe("2027-10-02T15:45:00.000Z");
    expect(o.get(2)!.endsAt.toISOString()).toBe("2027-10-02T16:15:00.000Z");
    expect(o.get(2)!.endsAt.getTime() - o.get(2)!.startsAt.getTime()).toBe(1800_000);
  });

  it("keeps every generated occurrence positive on a series that hits the gap week", () => {
    const s = wallToUtc("2027-03-21 01:30", "Europe/London");
    const e = wallToUtc("2027-03-21 02:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "weekly", 4);
    expect([...o.keys()]).toEqual([1, 2, 3, 4]);
    for (const { startsAt, endsAt } of o.values()) {
      expect(endsAt.getTime()).toBeGreaterThan(startsAt.getTime());
    }
  });

  it("leaves overnight meetings that only span the gap by date arithmetic unchanged", () => {
    // 23:30 -> next-day 00:30 London: neither endpoint lands inside the gap.
    const s = wallToUtc("2027-03-21 23:30", "Europe/London");
    const e = wallToUtc("2027-03-22 00:30", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "weekly", 2);
    const second = o.get(2)!;
    expect(utcToWall(second.startsAt, "Europe/London")).toBe("2027-03-28 23:30");
    expect(utcToWall(second.endsAt, "Europe/London")).toBe("2027-03-29 00:30");
    expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(3600_000);
  });

  it("leaves non-gap weeks on plain wall-time resolution", () => {
    const s = wallToUtc("2027-03-21 20:00", "Europe/London");
    const e = wallToUtc("2027-03-21 21:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "weekly", 3);
    const second = o.get(2)!;
    expect(second.startsAt.toISOString()).toBe("2027-03-28T19:00:00.000Z");
    expect(second.endsAt.toISOString()).toBe("2027-03-28T20:00:00.000Z");
  });

  it("keeps the parent occurrence on the exact seed instants", () => {
    const s = wallToUtc("2027-03-21 01:30", "Europe/London");
    const e = wallToUtc("2027-03-21 02:30", "Europe/London");
    const parent = occurrences(s, e, "Europe/London", "weekly", 2).get(1)!;
    expect(parent.startsAt).toBe(s);
    expect(parent.endsAt).toBe(e);
  });

  it("keeps count and repeat-until bounds on a gap-collapsed series", () => {
    const s = wallToUtc("2027-03-21 01:30", "Europe/London");
    const e = wallToUtc("2027-03-21 02:30", "Europe/London");
    expect(occurrences(s, e, "Europe/London", "weekly", 4).size).toBe(4);
    expect(occurrences(s, e, "Europe/London", "weekly", 4, new Date(Date.UTC(2027, 2, 28))).size).toBe(2);
    expect(occurrences(s, e, "Europe/London", "weekly", 2).size).toBe(2);
  });
});
