import { describe, expect, it } from "vitest";
import { rowAvailability } from "../src/events/pages-calendar-row";
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
