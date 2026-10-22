// Builder-owned: month-grid accessible names retain the truncated visible
// text (WCAG 2.5.3 / axe label-content-name-mismatch) while preserving the
// full title and the displayed day. Covers continuation links and their
// start-day siblings; short titles are not duplicated. DB-free: real SSR
// shells rendered directly through both twins.
import { describe, expect, it } from "vitest";
import {
  calendarDayLongLabel,
  cardDayLabel,
  gridAccessibleName,
  gridContinuationAccessibleName,
  gridTitle,
  wallTimeHm,
} from "../src/islands/contracts";
import {
  calendarLinks,
  gathering,
  gatheringTitle,
  renderCalendar,
  type CalendarTwin,
} from "./helpers/calendar-multiday-acceptance";

const TWINS: CalendarTwin[] = ["Hono", "Kit"];
const LONG_START = new Date("2027-01-20T23:30:00Z");
const LONG_END = new Date("2027-02-03T00:00:00Z");
const START_DAY_START = new Date("2027-02-14T23:30:00Z");
const START_DAY_END = new Date("2027-02-15T01:00:00Z");
const START_DAY_ZONE = "UTC";
const SHORT_TITLE = "Short meet";
const UNICODE_TITLE = "🎲 Raid nacht — naïve dragon Über alles nye 猟師 ∀x ∃y";

describe("gridContinuationAccessibleName truncation", () => {
  it("returns the short form unchanged (no duplication)", () => {
    expect(gridContinuationAccessibleName(SHORT_TITLE, "2027-02-01")).toBe(
      `Continues ${SHORT_TITLE}, ${calendarDayLongLabel("2027-02-01")}`,
    );
  });

  it("retains the truncated visible text alongside the full long title", () => {
    const truncated = gridTitle(gatheringTitle);
    expect(truncated).not.toBe(gatheringTitle);
    const name = gridContinuationAccessibleName(gatheringTitle, "2027-02-01");
    expect(name).toContain(`Continues ${truncated}`);
    expect(name).toContain(gatheringTitle);
    expect(name).toContain(calendarDayLongLabel("2027-02-01"));
  });

  it("retains Unicode truncation by code points, not UTF-16 units", () => {
    const truncated = gridTitle(UNICODE_TITLE);
    expect([...truncated].length).toBeLessThanOrEqual(19);
    expect(truncated.endsWith("…")).toBe(true);
    const name = gridContinuationAccessibleName(UNICODE_TITLE, "2027-02-01");
    expect(name).toContain(`Continues ${truncated}`);
    expect(name).toContain(UNICODE_TITLE);
  });
});

describe("gridAccessibleName truncation", () => {
  const time = wallTimeHm(START_DAY_START, START_DAY_ZONE);
  const day = cardDayLabel(START_DAY_START, START_DAY_ZONE);

  it("returns the short form unchanged (no duplication)", () => {
    expect(gridAccessibleName(SHORT_TITLE, START_DAY_START, START_DAY_ZONE)).toBe(
      `${time} ${SHORT_TITLE}, ${day}`,
    );
  });

  it("retains the truncated visible text alongside the full long title", () => {
    const truncated = gridTitle(gatheringTitle);
    expect(truncated).not.toBe(gatheringTitle);
    const name = gridAccessibleName(gatheringTitle, START_DAY_START, START_DAY_ZONE);
    expect(name).toContain(`${time} ${truncated}`);
    expect(name).toContain(gatheringTitle);
    expect(name).toContain(day);
  });

  it("retains Unicode truncation by code points, not UTF-16 units", () => {
    const truncated = gridTitle(UNICODE_TITLE);
    expect(truncated.endsWith("…")).toBe(true);
    const name = gridAccessibleName(UNICODE_TITLE, START_DAY_START, START_DAY_ZONE);
    expect(name).toContain(`${time} ${truncated}`);
    expect(name).toContain(UNICODE_TITLE);
  });
});

for (const twin of TWINS) {
  describe(`${twin}: continuation truncation in the grid`, () => {
    it("keeps the long visible label within the accessible name", async () => {
      const html = await renderCalendar(twin, [
        gathering({ startsAt: LONG_START, endsAt: LONG_END }),
      ]);
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(["2027-02-01", "2027-02-02"]);
      const truncated = gridTitle(gatheringTitle);
      expect(truncated).toBe("Multi-day gatherin…");
      for (const link of links) {
        expect(link.text).toBe(`Continues ${truncated}`);
        // Axe label-content-name-mismatch: the visible words must appear in the name.
        expect(link.name).toContain(link.text);
        expect(link.name).toContain(gatheringTitle);
        expect(link.name).toContain(calendarDayLongLabel(link.day));
        expect(link.name).not.toContain("20 January");
      }
      expect(links[0]!.name).toContain("1 February 2027");
      expect(links[1]!.name).toContain("2 February 2027");
    });

    it("does not duplicate short continuation titles", async () => {
      const html = await renderCalendar(twin, [
        gathering({ title: SHORT_TITLE, startsAt: LONG_START, endsAt: LONG_END }),
      ]);
      const links = calendarLinks(html);
      expect(links.map((link) => link.day)).toEqual(["2027-02-01", "2027-02-02"]);
      expect(gridTitle(SHORT_TITLE)).toBe(SHORT_TITLE);
      for (const link of links) {
        expect(link.text).toBe(`Continues ${SHORT_TITLE}`);
        expect(link.name).toContain(link.text);
        expect(link.name).toBe(`Continues ${SHORT_TITLE}, ${calendarDayLongLabel(link.day)}`);
      }
    });

    it("keeps the long start-day visible label within the accessible name", async () => {
      const html = await renderCalendar(twin, [
        gathering({ startsAt: START_DAY_START, endsAt: START_DAY_END }),
      ]);
      const links = calendarLinks(html);
      const start = links.find((link) => link.day === "2027-02-14");
      expect(start).toBeDefined();
      const truncated = gridTitle(gatheringTitle);
      expect(start!.text).toBe(`23:30 ${truncated}`);
      // Axe label-content-name-mismatch: the visible words must appear in the name,
      // including the truncated ellipsis form.
      expect(start!.name).toContain(start!.text);
      expect(start!.name).toContain(gatheringTitle);
      expect(start!.name).toContain(cardDayLabel(START_DAY_START, START_DAY_ZONE));
    });

    it("does not duplicate short start-day titles", async () => {
      const html = await renderCalendar(twin, [
        gathering({
          title: SHORT_TITLE,
          startsAt: START_DAY_START,
          endsAt: START_DAY_END,
        }),
      ]);
      const links = calendarLinks(html);
      const start = links.find((link) => link.day === "2027-02-14");
      expect(start!.text).toBe(`23:30 ${SHORT_TITLE}`);
      expect(start!.name).toBe(
        `23:30 ${SHORT_TITLE}, ${cardDayLabel(START_DAY_START, START_DAY_ZONE)}`,
      );
    });
  });
}
