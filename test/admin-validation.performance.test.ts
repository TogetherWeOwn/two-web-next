// Pure synthetic fixtures; constructor counts, not wall-clock deadlines.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const NativeDateTimeFormat = Intl.DateTimeFormat;
const INSTANT = new Date("2026-07-15T20:00:00Z");
const FORM = {
  title: "Game night",
  timezone: "UTC",
  starts_at: "2026-07-15 20:00",
  ends_at: "2026-07-15 22:00",
  capacity: "8",
};

function uncachedWall(instant: Date, timezone: string): string {
  const parts = Object.fromEntries(
    new NativeDateTimeFormat("en-GB", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year!.padStart(4, "0")}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}

beforeEach(() => vi.resetModules());
afterEach(() => vi.restoreAllMocks());

describe("bounded admin validation formatter reuse", () => {
  it("constructs only the two fixed profiles for repeated wall resolution and form parsing", async () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    const { isKnownTimezone, wallToUtc, utcToWall, parseEventForm } = await import(
      "../src/admin/validation"
    );
    for (let i = 0; i < 100; i++) {
      expect(isKnownTimezone("UTC")).toBe(true);
      expect(wallToUtc(FORM.starts_at, "UTC").toISOString()).toBe("2026-07-15T20:00:00.000Z");
      expect(utcToWall(INSTANT, "UTC")).toBe(FORM.starts_at);
      expect(parseEventForm(FORM).endsAtUtc.toISOString()).toBe("2026-07-15T22:00:00.000Z");
    }
    expect(constructors).toHaveBeenCalledTimes(2);
  });

  it("keeps timezone and complete locale/options identities separate", async () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    const { isKnownTimezone, utcToWall } = await import("../src/admin/validation");
    for (let i = 0; i < 2; i++) {
      expect(isKnownTimezone("UTC")).toBe(true);
      expect(isKnownTimezone("America/New_York")).toBe(true);
      expect(utcToWall(INSTANT, "UTC")).toBe("2026-07-15 20:00");
      expect(utcToWall(INSTANT, "America/New_York")).toBe("2026-07-15 16:00");
    }
    expect(constructors).toHaveBeenCalledTimes(4);
    expect(constructors.mock.calls).toEqual([
      ["en", { timeZone: "UTC" }],
      ["en", { timeZone: "America/New_York" }],
      [
        "en-GB",
        {
          timeZone: "UTC",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
      ],
      [
        "en-GB",
        {
          timeZone: "America/New_York",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        },
      ],
    ]);
  });

  it("bounds both profiles together at 64 entries, evicts the oldest and reconstructs correctly", async () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    const { isKnownTimezone, utcToWall } = await import("../src/admin/validation");
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 32);
    expect(zones).toHaveLength(32);
    for (const zone of zones) {
      expect(isKnownTimezone(zone)).toBe(true);
      expect(utcToWall(INSTANT, zone)).toBe(uncachedWall(INSTANT, zone));
    }
    expect(constructors).toHaveBeenCalledTimes(64);
    expect(isKnownTimezone("UTC")).toBe(true);
    expect(constructors).toHaveBeenCalledTimes(65);
    const newest = zones[31]!;
    expect(isKnownTimezone(newest)).toBe(true);
    expect(utcToWall(INSTANT, newest)).toBe(uncachedWall(INSTANT, newest));
    expect(constructors).toHaveBeenCalledTimes(65);
    expect(isKnownTimezone(zones[0]!)).toBe(true);
    expect(constructors).toHaveBeenCalledTimes(66);
    expect(utcToWall(INSTANT, zones[0]!)).toBe(uncachedWall(INSTANT, zones[0]!));
    expect(constructors).toHaveBeenCalledTimes(67);
  });

  it("never stores failed construction or lets arbitrary invalid zones evict valid entries", async () => {
    const constructors = vi.spyOn(Intl, "DateTimeFormat");
    const { isKnownTimezone, utcToWall, wallToUtc, parseEventForm, ValidationError } = await import(
      "../src/admin/validation"
    );
    const zones = Intl.supportedValuesOf("timeZone").slice(0, 64);
    for (const zone of zones) expect(isKnownTimezone(zone)).toBe(true);
    for (let i = 0; i < 100; i++) expect(isKnownTimezone(`Not/AZone_${i}`)).toBe(false);
    expect(constructors).toHaveBeenCalledTimes(164);
    for (const zone of zones) expect(isKnownTimezone(zone)).toBe(true);
    expect(constructors).toHaveBeenCalledTimes(164);
    expect(() => utcToWall(INSTANT, "Not/AZone_0")).toThrow(RangeError);
    expect(() => wallToUtc(FORM.starts_at, "Not/AZone_0")).toThrow(ValidationError);
    try {
      parseEventForm({ ...FORM, timezone: "Not/AZone_0" });
      expect.unreachable("unknown timezone accepted");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as InstanceType<typeof ValidationError>).fields).toEqual({
        timezone: "Unknown timezone: Not/AZone_0.",
      });
    }
    expect(isKnownTimezone(zones[0]!)).toBe(true);
    expect(constructors).toHaveBeenCalledTimes(167);
  });

  it("matches an independent uncached renderer before and after repeated cache eviction", async () => {
    const { utcToWall } = await import("../src/admin/validation");
    const zones = ["UTC", ...Intl.supportedValuesOf("timeZone")];
    for (const instant of [new Date("0100-07-15T00:00:00Z"), INSTANT]) {
      for (const zone of zones) expect(utcToWall(instant, zone)).toBe(uncachedWall(instant, zone));
    }
  });

  it("preserves gap errors, latest folds, carrier seconds, UTC ordering and form errors when warm", async () => {
    const { wallToUtc, utcToWall, parseEventForm, ValidationError } = await import(
      "../src/admin/validation"
    );
    for (let i = 0; i < 3; i++) {
      expect(wallToUtc("2026-10-25 01:30", "Europe/London").toISOString()).toBe(
        "2026-10-25T01:30:00.000Z",
      );
      expect(wallToUtc("2026-04-05 01:45", "Australia/Lord_Howe").toISOString()).toBe(
        "2026-04-04T15:15:00.000Z",
      );
      for (const [wall, timezone] of [
        ["2026-03-29 01:30", "Europe/London"],
        ["2026-10-04 02:15", "Australia/Lord_Howe"],
      ]) {
        try {
          wallToUtc(wall!, timezone!);
          expect.unreachable("gap accepted");
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as InstanceType<typeof ValidationError>).fields.wall).toContain(
            "never occurred",
          );
        }
      }
      const form = {
        ...FORM,
        timezone: "Europe/London",
        starts_at: "2026-10-25 01:30",
        ends_at: "2026-10-25 01:30",
      };
      const carriers = { startsAtUtc: "2026-10-25T00:30:00Z", endsAtUtc: "2026-10-25T01:30:17Z" };
      const parsed = parseEventForm(form, carriers);
      expect(parsed.endsAtUtc.toISOString()).toBe("2026-10-25T01:30:17.000Z");
      expect(utcToWall(parsed.endsAtUtc, form.timezone)).toBe(form.ends_at);
      expect(() =>
        parseEventForm(form, { startsAtUtc: carriers.endsAtUtc, endsAtUtc: carriers.startsAtUtc }),
      ).toThrow(ValidationError);
      for (const [data, field] of [
        [{ ...FORM, capacity: "0" }, "capacity"],
        [{ ...FORM, title: "" }, "title"],
        [{ ...FORM, ends_at: FORM.starts_at }, "ends_at"],
      ] as const) {
        try {
          parseEventForm(data);
          expect.unreachable("invalid form accepted");
        } catch (error) {
          expect(error).toBeInstanceOf(ValidationError);
          expect((error as InstanceType<typeof ValidationError>).fields).toHaveProperty(field);
        }
      }
    }
  });
});
