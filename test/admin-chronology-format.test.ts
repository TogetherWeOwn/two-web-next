// Admin chronology adapter: exact machine instants, explicit UTC labels, and
// no fabricated times. Run under at least two zones (TZ=UTC and
// TZ=America/New_York); every expectation is zone-independent by construction.
import { describe, expect, it } from "vitest";
import { formatAdminTime } from "../src/admin/chronology";

describe("admin chronology adapter", () => {
  it.each([
    // Plain instant plus its offset-written twin: same moment, one UTC label.
    "2026-10-01T12:34:56.789Z",
    "2026-10-01T14:34:56.789+02:00",
    new Date("2026-10-01T12:34:56.789Z"),
    Date.parse("2026-10-01T12:34:56.789Z"),
  ])("preserves the precise instant and displays UTC for %s", (value) => {
    expect(formatAdminTime(value)).toEqual({
      iso: "2026-10-01T12:34:56.789Z",
      label: "2026-10-01 12:34:56 UTC",
    });
  });

  it.each([
    // US DST 2026: spring forward 2026-03-08T07:00Z, fall back 2026-11-01T06:00Z.
    // A zone-naive formatter would print different wall times around the jump.
    "2026-03-08T06:59:59Z",
    "2026-03-08T07:00:00Z",
    "2026-11-01T05:59:59Z",
    "2026-11-01T06:00:00Z",
    "2028-02-29T00:01:00.123Z",
  ])("keeps the exact UTC instant across the DST boundary for %s", (value) => {
    const iso = new Date(value).toISOString();
    const [day, time = ""] = iso.split("T");
    expect(formatAdminTime(value)).toEqual({
      iso,
      label: `${day} ${time.slice(0, 8)} UTC`,
    });
  });

  it("keeps the seconds on expanded-year instants", () => {
    expect(formatAdminTime("+010000-01-01T12:34:56.789Z")).toEqual({
      iso: "+010000-01-01T12:34:56.789Z",
      label: "+010000-01-01 12:34:56 UTC",
    });
  });

  it("renders valid minute-precision instants with zero seconds", () => {
    expect(formatAdminTime("2026-10-01T12:34Z")).toEqual({
      iso: "2026-10-01T12:34:00.000Z",
      label: "2026-10-01 12:34:00 UTC",
    });
  });

  it("keeps epoch zero instead of treating it as absent", () => {
    expect(formatAdminTime(0)).toEqual({
      iso: "1970-01-01T00:00:00.000Z",
      label: "1970-01-01 00:00:00 UTC",
    });
  });

  it.each([
    null,
    undefined,
    new Date(Number.NaN),
    Number.NaN,
    Infinity,
    -Infinity,
    1e20,
    "",
    " ",
    "not-a-timestamp",
    "2026-10-01T12:34:56",
    // Impossible calendar dates V8 would normalize into a different instant.
    "2026-02-30T12:34:56Z",
    "2026-02-29T00:00:00Z",
    "2026-04-31T00:00:00Z",
    "2026-02-30T12:34:56+02:00",
    "2026-02-30T12:34Z",
    "2026-02-30T12:34+02:00",
    "2026-10-01T25:00:00Z",
    // Midnight written as 24:00 names the next day, so rendering it would
    // move the written date. It stays unrenderable at every precision,
    // matching the second-precision refusal that predates minute-precision
    // validation. No admin read emits it: rows arrive as Date objects or
    // toISOString output, which always write 00:00.
    "2026-10-01T24:00Z",
    "2026-10-01T24:00:00Z",
    "2026-10-01T24:00:00.000Z",
    "2026-10-01T24:00+02:00",
    "2026-10-01T24:01Z",
    "1",
    true,
    {},
  ])("does not fabricate an instant from %s", (value) => {
    expect(formatAdminTime(value)).toEqual({ iso: null, label: "Unrenderable time" });
  });
});
