// Builder-owned pins for the schedule cancellation presentation chosen by this
// slice: the acceptance suite allows omission-or-description, and these pin the
// description variant plus the grid name/visible relationship.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { CalCard } from "../src/events/pages-calendar-card";
import { MonthGrid } from "../src/events/pages-calendar-grid";
import {
  GRID_CANCELLED_COPY,
  calendarDayLongLabel,
  cardDayLabel,
  existingResponsesText,
  gridAccessibleName,
  gridContinuationAccessibleName,
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

  it.each([
    "Chess night",
    "Cancelled event: A",
    "Game night spectacular raid evening alpha Hobbiton",
    "Game night spectacular raid evening beta Rivendell",
    '🎲 Raid <script> & "quoted" 猟師 evening',
  ])("leads the cancelled grid name with its visible label: %s", async (title) => {
    const e = cancellationEvent({ title });
    const visible = `${wallTimeHm(e.startsAt, ZONE)} ${gridTitle(e.title)} ${GRID_CANCELLED_COPY}`;
    const name = gridAccessibleName(e.title, e.startsAt, ZONE, true);
    expect(name.startsWith(visible)).toBe(true);
    expect(name).toContain(e.title);
    expect(name).toContain(cardDayLabel(e.startsAt, ZONE));
    const html = await jsx(MonthGrid, {
      state: cancellationState,
      weeks: [[{ iso: "2099-01-15", day: 15, inMonth: true, isToday: false, events: [e] }]],
      zone: ZONE,
    }).toString();
    const link = /<a[^>]*data-cal-jump[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(link).not.toBeNull();
    // Compare rendered text as well as the helper, including escaped title bytes.
    expect(renderedText(link![1]!).startsWith(renderedText(link![2]!))).toBe(true);
    expect(html).not.toContain("<script>");
    // The published shape is untouched by the new flag default.
    expect(gridAccessibleName(e.title, e.startsAt, ZONE)).toBe(
      `${wallTimeHm(e.startsAt, ZONE)} ${e.title}, ${cardDayLabel(e.startsAt, ZONE)}`,
    );
  });

  it("keeps truncated same-prefix cancelled titles distinguishable", () => {
    const titles = [
      "Game night spectacular raid evening alpha Hobbiton",
      "Game night spectacular raid evening beta Rivendell",
    ];
    expect(gridTitle(titles[0]!)).toBe(gridTitle(titles[1]!));
    const e = cancellationEvent();
    const names = titles.map((title) => gridAccessibleName(title, e.startsAt, ZONE, true));
    expect(names[0]).not.toBe(names[1]);
  });

  it("names a cancelled continuation with both words, badge included", async () => {
    // Unreachable through today's reads — upcoming cancelled rows leave the
    // grid and past rows plot start-day-only — but the merged renderer must
    // still name the combination truthfully if admission ever changes.
    const e = cancellationEvent({ title: "Game night spectacular raid evening alpha Hobbiton" });
    const dayIso = "2099-01-16";
    const visible = `Continues ${gridTitle(e.title)} ${GRID_CANCELLED_COPY}`;
    const name = gridContinuationAccessibleName(e.title, dayIso, true);
    expect(name.startsWith(visible)).toBe(true);
    expect(name).toContain(e.title);
    expect(name).toContain(calendarDayLongLabel(dayIso));
    const html = await jsx(MonthGrid, {
      state: cancellationState,
      weeks: [[{ iso: dayIso, day: 16, inMonth: true, isToday: false, events: [e] }]],
      zone: ZONE,
    }).toString();
    const link = /<a[^>]*data-cal-jump[^>]*aria-label="([^"]*)"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(link).not.toBeNull();
    expect(link![0]).toContain('data-cancelled="true"');
    expect(renderedText(link![2]!)).toContain(`Continues ${gridTitle(e.title)}`);
    expect(link![2]).toContain(`<span class="schedule-badge">${GRID_CANCELLED_COPY}</span>`);
    expect(renderedText(link![1]!).startsWith(renderedText(link![2]!))).toBe(true);
    // The published continuation shape is untouched by the new flag default.
    expect(gridContinuationAccessibleName(e.title, dayIso)).toBe(
      `Continues ${e.title}, ${calendarDayLongLabel(dayIso)}`,
    );
  });

  it("pins the cancelled hook and both badge-stacking rules", async () => {
    const html = await jsx(MonthGrid, {
      state: cancellationState,
      weeks: [
        [
          {
            iso: "2099-01-15",
            day: 15,
            inMonth: true,
            isToday: false,
            events: [cancellationEvent(), cancellationEvent({ status: "published" })],
          },
        ],
      ],
      zone: ZONE,
    }).toString();
    const links = [...html.matchAll(/<a[^>]*data-cal-jump[^>]*>/g)].map((m) => m[0]);
    expect(links).toHaveLength(2);
    expect(links[0]).toContain('data-cancelled="true"');
    expect(links[1]).not.toContain("data-cancelled");

    const css = readFileSync(new URL("../public/schedule-theme.css", import.meta.url), "utf8");
    const stack = css.match(/\.events-page \[data-cal-jump\]\[data-cancelled\]\s*\{([^{}]*)\}/);
    expect(stack, "cancelled grid link stacks its badge below its label").not.toBeNull();
    expect(stack![1]).toMatch(/flex-direction:\s*column\s*;/);
    expect(stack![1]).toMatch(/align-items:\s*flex-start\s*;/);
    const badge = css.match(/\.events-page \[data-cal-jump\] \.schedule-badge\s*\{([^{}]*)\}/);
    expect(badge, "grid badge keeps its compact top margin").not.toBeNull();
    expect(badge![1]).toMatch(/margin:\s*\.25rem 0 0\s*;/);
  });
});
