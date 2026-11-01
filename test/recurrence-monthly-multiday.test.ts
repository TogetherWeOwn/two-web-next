import { describe, expect, it } from "vitest";
import { occurrences } from "../src/admin/recurrence";
import { utcToWall, wallToUtc } from "../src/admin/validation";

// Multi-day monthly seeds keep their wall shape: the end anchors to the
// resolved start wall date plus the seed's day span, so short months never
// silently shorten the event. Clamping the seed end day instead would store
// Feb 25-28 (3 days) for a 6-day Jan 25-31 series.
describe("occurrences monthly multi-day seeds", () => {
  it("keeps a 6-day Jan 25-31 meeting at 6 days through February", () => {
    const s = wallToUtc("2026-01-25 20:00", "Europe/London");
    const e = wallToUtc("2026-01-31 20:00", "Europe/London");
    const o = occurrences(s, e, "Europe/London", "monthly", 3);
    const feb = o.get(2)!;
    expect(utcToWall(feb.startsAt, "Europe/London")).toBe("2026-02-25 20:00");
    expect(utcToWall(feb.endsAt, "Europe/London")).toBe("2026-03-03 20:00");
    expect(feb.startsAt.toISOString()).toBe("2026-02-25T20:00:00.000Z");
    expect(feb.endsAt.toISOString()).toBe("2026-03-03T20:00:00.000Z");
    expect(feb.endsAt.getTime() - feb.startsAt.getTime()).toBe(6 * 86_400_000);
    const mar = o.get(3)!;
    expect(utcToWall(mar.startsAt, "Europe/London")).toBe("2026-03-25 20:00");
    expect(utcToWall(mar.endsAt, "Europe/London")).toBe("2026-03-31 20:00");
    // Six wall days, but the 2026-03-29 spring-forward steals one elapsed hour.
    expect(mar.endsAt.getTime() - mar.startsAt.getTime()).toBe(6 * 86_400_000 - 3600_000);
  });

  it("keeps a 4-day Jan 27-31 meeting at 4 days through February", () => {
    const s = wallToUtc("2026-01-27 20:00", "Europe/London");
    const e = wallToUtc("2026-01-31 20:00", "Europe/London");
    const feb = occurrences(s, e, "Europe/London", "monthly", 2).get(2)!;
    expect(utcToWall(feb.startsAt, "Europe/London")).toBe("2026-02-27 20:00");
    expect(utcToWall(feb.endsAt, "Europe/London")).toBe("2026-03-03 20:00");
    expect(feb.endsAt.getTime() - feb.startsAt.getTime()).toBe(4 * 86_400_000);
  });

  it("spills an overnight Jan 30-31 clamp across the February wall", () => {
    const s = wallToUtc("2026-01-30 23:00", "Europe/London");
    const e = wallToUtc("2026-01-31 02:00", "Europe/London");
    const feb = occurrences(s, e, "Europe/London", "monthly", 2).get(2)!;
    expect(utcToWall(feb.startsAt, "Europe/London")).toBe("2026-02-28 23:00");
    expect(utcToWall(feb.endsAt, "Europe/London")).toBe("2026-03-01 02:00");
    expect(feb.endsAt.getTime() - feb.startsAt.getTime()).toBe(3 * 3600_000);
  });

  it("keeps the seed end sub-minute precision on the anchored wall", () => {
    const s = new Date("2026-01-25T20:00:27.125Z");
    const e = new Date("2026-01-31T20:00:44.875Z");
    const feb = occurrences(s, e, "UTC", "monthly", 2).get(2)!;
    expect(feb.startsAt.toISOString()).toBe("2026-02-25T20:00:27.125Z");
    expect(feb.endsAt.toISOString()).toBe("2026-03-03T20:00:44.875Z");
  });

  it("keeps same-day monthly ends on the clamped month wall", () => {
    const s = wallToUtc("2026-01-31 20:00", "Europe/London");
    const e = wallToUtc("2026-01-31 21:00", "Europe/London");
    const feb = occurrences(s, e, "Europe/London", "monthly", 2).get(2)!;
    expect(utcToWall(feb.startsAt, "Europe/London")).toBe("2026-02-28 20:00");
    expect(utcToWall(feb.endsAt, "Europe/London")).toBe("2026-02-28 21:00");
    expect(feb.endsAt.getTime() - feb.startsAt.getTime()).toBe(3600_000);
  });

  it("leaves weekly multi-day seeds on the exact stepped shape", () => {
    const s = wallToUtc("2026-01-25 20:00", "Europe/London");
    const e = wallToUtc("2026-01-31 20:00", "Europe/London");
    const second = occurrences(s, e, "Europe/London", "weekly", 2).get(2)!;
    expect(utcToWall(second.startsAt, "Europe/London")).toBe("2026-02-01 20:00");
    expect(utcToWall(second.endsAt, "Europe/London")).toBe("2026-02-07 20:00");
    expect(second.endsAt.getTime() - second.startsAt.getTime()).toBe(6 * 86_400_000);
  });
});
