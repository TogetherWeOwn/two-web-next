import { afterEach, describe, expect, it, vi } from "vitest";
import { eventFixtureWindow } from "../e2e/staging/fixtures";
import { parseEventForm } from "../src/admin/validation-event-form";

const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;

afterEach(() => {
  vi.useRealTimers();
});

describe("staging event fixture window", () => {
  it.each([
    ["2026-11-07T12:34:56.789Z", "2026-11-09 12:34", "2026-11-09 14:34"],
    ["2026-12-30T23:30:59.999Z", "2027-01-01 23:30", "2027-01-02 01:30"],
    ["2028-02-27T18:00:00.000Z", "2028-02-29 18:00", "2028-02-29 20:00"],
    ["2026-03-07T23:30:00-08:00", "2026-03-10 07:30", "2026-03-10 09:30"],
  ])("formats and accepts the UTC window from %s", (instant, startsAt, endsAt) => {
    const now = Date.parse(instant);
    const window = eventFixtureWindow(now);
    expect(window).toEqual({ startsAt, endsAt, timezone: "UTC" });
    const parsed = parseEventForm({
      title: "Staging E2E window",
      starts_at: window.startsAt,
      ends_at: window.endsAt,
      timezone: window.timezone,
    });
    expect(parsed.timezone).toBe("UTC");
    expect(parsed.startsAtUtc.toISOString()).toBe(`${startsAt.replace(" ", "T")}:00.000Z`);
    expect(parsed.endsAtUtc.getTime() - parsed.startsAtUtc.getTime()).toBe(2 * 3_600_000);
    expect(parsed.startsAtUtc.getTime()).toBeGreaterThan(now + 2 * DAY_MS - MINUTE_MS);
    expect(parsed.startsAtUtc.getTime()).toBeLessThanOrEqual(now + 2 * DAY_MS);
    // Feed scope is ends_at >= now, including cancellation; the fixture ages out itself.
    expect(parsed.endsAtUtc.getTime()).toBeLessThan(now + 3 * DAY_MS);
  });

  it("uses the current run clock instead of a fixed future date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-07T12:34:56.789Z"));
    expect(eventFixtureWindow()).toEqual({
      startsAt: "2026-11-09 12:34",
      endsAt: "2026-11-09 14:34",
      timezone: "UTC",
    });
    vi.advanceTimersByTime(DAY_MS);
    expect(eventFixtureWindow()).toEqual({
      startsAt: "2026-11-10 12:34",
      endsAt: "2026-11-10 14:34",
      timezone: "UTC",
    });
  });
});
