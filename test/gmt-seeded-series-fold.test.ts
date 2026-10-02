// GMT-seeded series through the autumn fold (TOG-12441): the W15 ledger
// (docs/w15-events-acceptance-ledger.md) leaves unproved the case of a seed
// stored on the GMT side whose slot lands in the fold. TOG-11669 settled
// single events (fresh parses take the second/GMT occurrence); series resolve
// each stepped wall minute to the earlier occurrence to keep the seed's offset
// the way legacy `addWeeks` does (`src/admin/recurrence-wall.ts`). This suite
// proves a GMT-side weekly seed crossing the 2026-10-25 fold keeps its offset
// with no dupes or skips. Pure unit, no DB. Test-only: if a case fails needing
// a `recurrence*.ts` source change, record it and park blocked (PR #114).
//
// 2026-10-25: Europe/London falls back 02:00 BST -> 01:00 GMT, so wall 01:30
// names two instants: 00:30Z (first, BST) and 01:30Z (second, GMT).
import { describe, expect, it } from "vitest";
import { occurrences } from "../src/admin/recurrence";
import { utcToWall, wallToUtc } from "../src/admin/validation";

const GMT_SEED_START = new Date("2026-10-25T01:30:00.000Z");
const GMT_SEED_END = new Date("2026-10-25T02:30:00.000Z");

describe("GMT-seeded series through the autumn fold", () => {
  it("keeps the GMT-side parent instant and holds 01:30 London across later weeks", () => {
    const schedule = occurrences(GMT_SEED_START, GMT_SEED_END, "Europe/London", "weekly", 4);
    expect([...schedule.keys()]).toEqual([1, 2, 3, 4]);
    expect(
      [...schedule.values()].map(({ startsAt, endsAt }) => [
        startsAt.toISOString(),
        endsAt.toISOString(),
      ]),
    ).toEqual([
      ["2026-10-25T01:30:00.000Z", "2026-10-25T02:30:00.000Z"],
      ["2026-11-01T01:30:00.000Z", "2026-11-01T02:30:00.000Z"],
      ["2026-11-08T01:30:00.000Z", "2026-11-08T02:30:00.000Z"],
      ["2026-11-15T01:30:00.000Z", "2026-11-15T02:30:00.000Z"],
    ]);
    // The parent is the exact stored instant, not a re-parse of its wall minute.
    expect(schedule.get(1)!.startsAt).toBe(GMT_SEED_START);
    expect(schedule.get(1)!.endsAt).toBe(GMT_SEED_END);
    for (const { startsAt, endsAt } of schedule.values()) {
      expect(utcToWall(startsAt, "Europe/London").slice(11)).toBe("01:30");
      expect(endsAt.getTime() - startsAt.getTime()).toBe(3600_000);
    }
  });

  it("emits distinct weekly instants with no dupes or skips", () => {
    const schedule = occurrences(GMT_SEED_START, GMT_SEED_END, "Europe/London", "weekly", 4);
    const starts = [...schedule.values()].map(({ startsAt }) => startsAt.toISOString());
    expect(new Set(starts).size).toBe(4);
    expect(
      [...schedule.values()].map(({ startsAt }) => utcToWall(startsAt, "Europe/London")),
    ).toEqual(["2026-10-25 01:30", "2026-11-01 01:30", "2026-11-08 01:30", "2026-11-15 01:30"]);
  });

  it("matches the fresh single-event parse for the GMT-side fold minute", () => {
    // A form create of "2026-10-25 01:30" stores the second (GMT) occurrence
    // (TOG-11669); a series seeded from that stored instant keeps it as parent.
    expect(wallToUtc("2026-10-25 01:30", "Europe/London").toISOString()).toBe(
      GMT_SEED_START.toISOString(),
    );
    const parent = occurrences(GMT_SEED_START, GMT_SEED_END, "Europe/London", "weekly", 2).get(1)!;
    expect(parent.startsAt.toISOString()).toBe(
      wallToUtc("2026-10-25 01:30", "Europe/London").toISOString(),
    );
  });

  it("diverges from a BST seed only on the fold-week parent, then converges", () => {
    const bst = occurrences(
      new Date("2026-10-25T00:30:00.000Z"),
      new Date("2026-10-25T00:45:00.000Z"),
      "Europe/London",
      "weekly",
      2,
    );
    const gmt = occurrences(
      new Date("2026-10-25T01:30:00.000Z"),
      new Date("2026-10-25T01:45:00.000Z"),
      "Europe/London",
      "weekly",
      2,
    );
    // Same fold wall minute, different stored sides: parents differ by the hour.
    expect(bst.get(1)!.startsAt.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(gmt.get(1)!.startsAt.toISOString()).toBe("2026-10-25T01:30:00.000Z");
    // Past the fold the slot is unambiguous, so both series land together.
    expect(bst.get(2)!.startsAt.toISOString()).toBe("2026-11-01T01:30:00.000Z");
    expect(gmt.get(2)!.startsAt.toISOString()).toBe("2026-11-01T01:30:00.000Z");
    expect(bst.get(2)!.endsAt.toISOString()).toBe("2026-11-01T01:45:00.000Z");
    expect(gmt.get(2)!.endsAt.toISOString()).toBe("2026-11-01T01:45:00.000Z");
  });

  it("preserves sub-minute precision on a GMT-side fold seed", () => {
    const schedule = occurrences(
      new Date("2026-10-25T01:30:27.125Z"),
      new Date("2026-10-25T01:45:44.875Z"),
      "Europe/London",
      "weekly",
      3,
    );
    expect(
      [...schedule.values()].map(({ startsAt, endsAt }) => [
        startsAt.toISOString(),
        endsAt.toISOString(),
      ]),
    ).toEqual([
      ["2026-10-25T01:30:27.125Z", "2026-10-25T01:45:44.875Z"],
      ["2026-11-01T01:30:27.125Z", "2026-11-01T01:45:44.875Z"],
      ["2026-11-08T01:30:27.125Z", "2026-11-08T01:45:44.875Z"],
    ]);
  });
});
