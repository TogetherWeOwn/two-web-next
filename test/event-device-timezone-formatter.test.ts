import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_TIMEZONE_UNAVAILABLE,
  eventStartInDeviceTimezone,
} from "../assets/event-device-timezone";

const native = Intl.DateTimeFormat;
function deviceZone(zone: string) {
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
    return new native(locales, { timeZone: zone, ...options });
  } as typeof Intl.DateTimeFormat);
}
afterEach(() => vi.restoreAllMocks());

describe("event device timezone formatter edge cases", () => {
  it("spells out the zero UTC offset without relying on ICU's GMT spelling", () => {
    deviceZone("UTC");
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toBe(
      "In your device timezone: Wednesday, 15 July 2026 at 19:00 GMT+00:00 (UTC).",
    );
  });
  it("retains fractional-hour offsets and date rollover", () => {
    deviceZone("Asia/Kathmandu");
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toMatch(
      /^In your device timezone: Thursday, 16 July 2026 at 00:45 GMT\+05:45 \(Asia\/Kat(?:h)?mandu\)\.$/,
    );
  });
  it("resolves the device zone anew on each activation", () => {
    deviceZone("Europe/London");
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toContain("20:00 GMT+01:00");
    vi.restoreAllMocks();
    deviceZone("America/New_York");
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toContain("15:00 GMT-04:00");
  });
  it.each([null, undefined, "", 42, {}, true])("refuses malformed instant %j", (input) => {
    expect(eventStartInDeviceTimezone(input)).toBe(DEVICE_TIMEZONE_UNAVAILABLE);
  });
  it("refuses an invalid event instant instead of displaying a date", () => {
    expect(eventStartInDeviceTimezone("invalid")).toBe(DEVICE_TIMEZONE_UNAVAILABLE);
  });
  it("fails closed when longOffset is silently ignored", () => {
    vi.spyOn(Intl, "DateTimeFormat").mockImplementation(function (locales, options) {
      return new native(locales, {
        ...options,
        timeZone: "America/New_York",
        timeZoneName: "short",
      });
    } as typeof Intl.DateTimeFormat);
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toBe(
      DEVICE_TIMEZONE_UNAVAILABLE,
    );
  });
  it("fails closed if formatToParts is unsupported", () => {
    vi.spyOn(native.prototype, "formatToParts").mockImplementation(() => {
      throw new TypeError("unsupported");
    });
    expect(eventStartInDeviceTimezone("2026-07-15T19:00:00.000Z")).toBe(
      DEVICE_TIMEZONE_UNAVAILABLE,
    );
  });
});
