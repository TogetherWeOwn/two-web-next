// Builder-owned pins for the schedule cancellation presentation chosen by this
// slice: the acceptance suite allows omission-or-description, and these pin the
// description variant plus the grid name/visible relationship.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { CalCard } from "../src/events/pages-calendar-card";
import { MonthGrid } from "../src/events/pages-calendar-grid";
import {
  GRID_CANCELLED_COPY,
  cardDayLabel,
  existingResponsesText,
  gridAccessibleName,
  gridTitle,
  wallTimeHm,
} from "../src/islands/contracts";
import {
  cancellationEvent,
  cancellationState,
  renderedText,
} from "./helpers/calendar-cancellation";

const ZONE = "Europe/London";

describe("cancelled schedule copy", () => {
  it("describes retained answers as existing responses, never attendance", () => {
    expect(existingResponsesText(73)).toBe("73 existing responses");
    expect(existingResponsesText(0)).toBe("0 existing responses");
    expect(existingResponsesText(1)).toBe("1 existing response");
    for (const text of [existingResponsesText(73), existingResponsesText(1)]) {
      expect(text).not.toMatch(/going|attend|available|places|spots|remaining/i);
    }
  });

  it("renders the exact existing-responses line on guest and member cards", async () => {
    for (const member of [false, true]) {
      const html = await jsx(CalCard, {
        e: cancellationEvent(),
        zone: ZONE,
        isPast: false,
        member,
        inviteUrl: "https://discord.gg/example",
        loginReturnTo: "/events",
      }).toString();
      expect(renderedText(html)).toContain("73 existing responses");
      expect(html).not.toContain('data-testid="signin"');
    }
  });

  it("shares one badge word between the card and the grid entry", async () => {
    expect(GRID_CANCELLED_COPY).toBe("Cancelled");
    const html = await jsx(MonthGrid, {
      state: cancellationState,
      weeks: [
        [
          {
            iso: "2099-01-15",
            day: 15,
            inMonth: true,
            isToday: false,
            events: [cancellationEvent()],
          },
        ],
      ],
      zone: ZONE,
    }).toString();
    expect(html).toContain(`<span class="schedule-badge">${GRID_CANCELLED_COPY}</span>`);
  });

  it("leads the cancelled grid name with its visible label", () => {
    const e = cancellationEvent();
    const visible = `${wallTimeHm(e.startsAt, ZONE)} ${gridTitle(e.title)} ${GRID_CANCELLED_COPY}`;
    const name = gridAccessibleName(e.title, e.startsAt, ZONE, true);
    expect(name.startsWith(visible)).toBe(true);
    expect(name).toContain(cardDayLabel(e.startsAt, ZONE));
    // The published shape is untouched by the new flag default.
    expect(gridAccessibleName(e.title, e.startsAt, ZONE)).toBe(
      `${wallTimeHm(e.startsAt, ZONE)} ${e.title}, ${cardDayLabel(e.startsAt, ZONE)}`,
    );
  });
});
