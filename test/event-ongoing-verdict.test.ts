import { describe, expect, it } from "vitest";
import { rowAvailability, teaserAvailability } from "../src/events/pages-calendar-row";
import { discordEvent } from "./fixtures/schedule-availability";
import { MID } from "./helpers/event-ongoing-acceptance";

describe("Discord ongoing snapshot render instant", () => {
  it.each([undefined, null, new Date(Number.NaN)])(
    "does not label an active, open-ended row without a valid instant (%s)",
    (now) => {
      const row = { ...discordEvent(), status: "active" as const, endsAt: null };
      expect(rowAvailability(row, now)).toEqual({
        state: "transient",
        text: "Discord-managed",
        ongoing: false,
      });
      expect(rowAvailability(row, MID)?.ongoing).toBe(true);
    },
  );

  it("keeps an active historical row unlabelled without hiding its Discord management", () => {
    const row = { ...discordEvent(), status: "active" as const, endsAt: null };
    expect(rowAvailability(row, MID, true)).toEqual({
      state: "transient",
      text: "Discord-managed",
      ongoing: false,
    });
  });
});

describe("teaser availability ongoing snapshot", () => {
  it("preserves occupancy verdict during an ongoing event and closes at its end", () => {
    const row = {
      status: "published",
      startsAt: new Date("2026-01-01T10:00:00Z"),
      endsAt: new Date("2026-01-01T12:00:00Z"),
      rsvpOpen: true,
      capacity: 3,
      goingCount: 1,
      goingOccupancy: 2,
    };
    expect(teaserAvailability(row, new Date("2026-01-01T11:00:00Z"))).toEqual({
      state: "open",
      text: "1 seat left",
      ongoing: true,
    });
    expect(teaserAvailability(row, row.endsAt)).toEqual({
      state: "past",
      text: "Ended",
      ongoing: false,
    });
    expect(
      teaserAvailability({ ...row, startsAt: undefined }, new Date("2026-01-01T11:00:00Z"))
        ?.ongoing,
    ).toBe(false);
  });
});
