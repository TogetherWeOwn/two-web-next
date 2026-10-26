// Calendar accessibility acceptance: every date marker carries full-date words.
// DB-free: real SSR shells rendered directly (EventsCalendarPage + Hono route).
// Base: 0f8fdd17f21abe7d0f7c015001b9415b180efe99 — grid cells expose only a
// numeric day and data-outside (src/events/pages-calendar-grid.tsx:115-122),
// so the full-date assertions below FAIL first. Controls (compact numbers,
// table semantics, aria-current, event-link names, week-start, no-JS anchors)
// PASS on the same base and must stay green after the build.
//
// Contract under test (TOG-42589 item U7):
// - Every calendar date marker — empty cells included, December/January
//   boundaries included — exposes full-date semantic context using the existing
//   shared formatter calendarDayLongLabel. Adjacent-month dates are
//   identifiable in words, not solely style/data attributes.
// - Compact visible day numbers, native table/caption/column semantics,
//   aria-current today and nested event-link names are retained. No aria-label
//   on a parent that suppresses event links, no second keyboard widget, no
//   week-start change.
import { jsx } from "hono/jsx/jsx-runtime";
import { describe, expect, it } from "vitest";
import { EventsCalendarPage } from "../src/events/pages";
import type { PublicEvent } from "../src/events/reads";
import {
  CALENDAR_DAY_TESTID,
  WEEKDAY_HEADINGS,
  calendarDayLongLabel,
  calendarJumpUrl,
  cardDayLabel,
  gridTitle,
  wallDateIso,
  wallTimeHm,
  type CalendarEmptyState,
  type CalendarState,
  type DiscordTransient,
} from "../src/islands/contracts";
import { rowKey } from "../src/events/pages-calendar-row";

const APP_URL = "https://next.example.test";
const ZONE = "Europe/London";
const NOW = new Date("2026-10-13T12:00:00Z");

function persisted(overrides: Partial<PublicEvent> = {}): PublicEvent {
  const start = new Date("2026-10-15T19:00:00Z");
  const base: PublicEvent = {
    id: 1,
    icsSequence: 1n,
    eventKey: "ev-1",
    title: "Game night",
    game: null,
    description: null,
    startsAt: start,
    endsAt: new Date(start.getTime() + 7200_000),
    timezone: ZONE,
    location: null,
    capacity: null,
    status: "published",
    rsvpOpen: true,
    goingCount: 0,
    goingOccupancy: 0,
    discordEventId: null,
    discordSyncFailedAt: null,
    discordSyncFailureCode: null,
    syncRevision: 1,
    syncedRevision: 0,
    agentGrantId: null,
    proofMarker: null,
    agentVersion: 1,
    createdBy: null,
    recurrenceFrequency: null,
    recurrenceCount: null,
    recurrenceEndsOn: null,
    parentEventId: null,
    recurrenceIndex: null,
    createdAt: start,
    updatedAt: start,
  };
  return { ...base, ...overrides };
}

function transient(overrides: Partial<DiscordTransient> = {}): DiscordTransient {
  const startsAt = new Date("2026-10-15T19:00:00Z");
  return {
    discordId: "t1",
    status: "scheduled",
    title: "Discord raid",
    description: null,
    location: null,
    startsAt,
    endsAt: new Date(startsAt.getTime() + 3600_000),
    ...overrides,
  };
}

async function renderMonth(
  month: string,
  upcoming: (PublicEvent | DiscordTransient)[],
  now: Date = NOW,
): Promise<string> {
  const state: CalendarState = { view: "calendar", month, q: "", game: "", past: false, page: 1 };
  return jsx(EventsCalendarPage, {
    state,
    upcoming,
    past: [],
    zone: ZONE,
    now,
    totalPages: 1,
    emptyState: null as CalendarEmptyState,
    discordFailed: false,
    games: [],
    gameFilter: null,
    member: false,
    inviteUrl: "https://discord.gg/fixture",
    appUrl: APP_URL,
  }).toString();
}

interface DayCell {
  attrs: string;
  inner: string;
  iso: string;
  inMonth: boolean;
  isToday: boolean;
}

function dayCells(html: string): DayCell[] {
  const cells: DayCell[] = [];
  const re = /<td\b([^>]*)>([\s\S]*?)<\/td>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] ?? "";
    if (!attrs.includes(`data-testid="${CALENDAR_DAY_TESTID}"`)) continue;
    const iso = /data-date="([^"]+)"/.exec(attrs)?.[1] ?? "";
    cells.push({
      attrs,
      inner: m[2] ?? "",
      iso,
      inMonth: !attrs.includes('data-outside="true"'),
      isToday: attrs.includes('aria-current="date"'),
    });
  }
  return cells;
}

/** Visible words inside a cell: tags stripped by manual scan (titles are escaped). */
function visibleWords(inner: string): string {
  let words = "";
  let rest = inner;
  for (;;) {
    const open = rest.indexOf("<");
    if (open === -1) {
      words += rest;
      break;
    }
    words += rest.slice(0, open);
    const close = rest.indexOf(">", open + 1);
    if (close === -1) {
      words += rest.slice(open);
      break;
    }
    rest = rest.slice(close + 1);
  }
  return words.replace(/\s+/g, " ").trim();
}

function gridLinks(html: string): { href: string; attrs: string; visible: string }[] {
  const links: { href: string; attrs: string; visible: string }[] = [];
  const re = /<a([^>]*?)data-cal-jump([^>]*?)>([\s\S]*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const attrs = `${m[1] ?? ""}data-cal-jump${m[2] ?? ""}`;
    links.push({
      href: /href="([^"]*)"/.exec(attrs)?.[1] ?? "",
      attrs,
      visible: (m[3] ?? "").trim(),
    });
  }
  return links;
}

const ariaOf = (attrs: string): string | null => /aria-label="([^"]*)"/.exec(attrs)?.[1] ?? null;

// Months that pin the required matrices: ordinary, non-leap February, leap
// February, and both December/January boundary directions.
const MATRIX_MONTHS = ["2026-10", "2026-02", "2028-02", "2026-12", "2027-01"] as const;

describe("calendar date markers carry full-date words", () => {
  it.each([...MATRIX_MONTHS])(
    "exposes the shared full-date label in every cell of %s, empty cells included",
    async (month) => {
      const html = await renderMonth(month, []);
      const cells = dayCells(html);
      // Whole Monday-first weeks: 28–42 cells, every one a date marker.
      expect(cells.length % 7).toBe(0);
      expect(cells.length).toBeGreaterThanOrEqual(28);
      expect(cells.length).toBeLessThanOrEqual(42);
      for (const cell of cells) {
        expect(cell.iso).toMatch(/^\+?\d{4,6}-\d{2}-\d{2}$/);
        const expected = calendarDayLongLabel(cell.iso);
        // The existing shared formatter is the contract: the exact string must
        // appear inside the cell (sr-only text, time content, or an inner
        // attribute) — never only as data-date/data-outside.
        expect(
          cell.inner.includes(expected),
          `${cell.iso} must expose "${expected}" in words`,
        ).toBe(true);
      }
    },
  );

  it("identifies December/January spillover in words on both boundary months", async () => {
    const decHtml = await renderMonth("2026-12", []);
    const janHtml = await renderMonth("2027-01", []);
    const decOutside = dayCells(decHtml).filter((c) => !c.inMonth);
    const janOutside = dayCells(janHtml).filter((c) => !c.inMonth);
    expect(decOutside.length).toBeGreaterThan(0);
    expect(janOutside.length).toBeGreaterThan(0);
    // December grid spills into January 2027; January grid spills from December 2026.
    const decJan = decOutside.filter((c) => c.iso.startsWith("2027-01-"));
    const janDec = janOutside.filter((c) => c.iso.startsWith("2026-12-"));
    expect(decJan.length).toBeGreaterThan(0);
    expect(janDec.length).toBeGreaterThan(0);
    for (const cell of decJan) {
      expect(cell.inner).toContain("January");
      expect(cell.inner).toContain("2027");
      expect(cell.inner).toContain(calendarDayLongLabel(cell.iso));
    }
    for (const cell of janDec) {
      expect(cell.inner).toContain("December");
      expect(cell.inner).toContain("2026");
      expect(cell.inner).toContain(calendarDayLongLabel(cell.iso));
    }
  });

  it("keeps full-date words on populated, today and leap-day cells", async () => {
    const leapStart = new Date("2028-02-29T19:00:00Z");
    const leap = persisted({
      id: 11,
      eventKey: "ev-leap",
      title: "Leap night",
      startsAt: leapStart,
      endsAt: new Date(leapStart.getTime() + 3600_000),
    });
    const html = await renderMonth("2028-02", [leap], new Date("2028-02-29T12:00:00Z"));
    const cells = dayCells(html);
    const byIso = new Map(cells.map((c) => [c.iso, c]));
    // Leap day exists, holds the event, and is today in this render.
    const leapCell = byIso.get("2028-02-29")!;
    expect(leapCell).toBeDefined();
    expect(leapCell.inMonth).toBe(true);
    expect(leapCell.isToday).toBe(true);
    expect(leapCell.inner).toContain("data-cal-jump");
    expect(leapCell.inner).toContain(calendarDayLongLabel("2028-02-29"));
    // A populated in-month cell and an empty in-month cell share the contract.
    const populated = cells.find((c) => c.inMonth && c.inner.includes("data-cal-jump"))!;
    const empty = cells.find((c) => c.inMonth && !c.inner.includes("data-cal-jump"))!;
    expect(populated.inner).toContain(calendarDayLongLabel(populated.iso));
    expect(empty.inner).toContain(calendarDayLongLabel(empty.iso));
  });

  it("covers the February length matrix: 28 days in 2026, 29 in leap 2028", async () => {
    const plain = dayCells(await renderMonth("2026-02", []));
    const leap = dayCells(await renderMonth("2028-02", []));
    expect(plain.filter((c) => c.inMonth)).toHaveLength(28);
    expect(leap.filter((c) => c.inMonth)).toHaveLength(29);
    expect(leap.find((c) => c.iso === "2028-02-29")!.inner).toContain(
      calendarDayLongLabel("2028-02-29"),
    );
  });
});

describe("calendar date controls stay unchanged", () => {
  it.each([...MATRIX_MONTHS])(
    "keeps compact day numbers and Monday-first geometry in %s",
    async (month) => {
      const html = await renderMonth(month, []);
      const cells = dayCells(html);
      for (const cell of cells) {
        // Compact visible number survives: a bare <span>digits</span>, not the full date.
        const day = Number(cell.iso.slice(-2));
        expect(cell.inner).toContain(`<span>${day}</span>`);
      }
      // Monday-first headings in order, native column scope.
      const headings = [...html.matchAll(/<th scope="col">([^<]*)<\/th>/g)].map((m) => m[1]);
      expect(headings).toEqual([...WEEKDAY_HEADINGS]);
      const first = new Date(`${cells[0]!.iso}T00:00:00Z`).getUTCDay();
      expect(first).toBe(1);
    },
  );

  it("keeps native table/caption semantics and today-only aria-current", async () => {
    const html = await renderMonth("2026-10", [], new Date("2026-10-15T12:00:00Z"));
    expect(html).toContain('data-testid="events-calendar-grid"');
    expect(html).toContain("<caption");
    expect(html).toContain("<thead>");
    expect(html).toContain("<tbody>");
    const cells = dayCells(html);
    expect(cells.filter((c) => c.isToday).map((c) => c.iso)).toEqual(["2026-10-15"]);
  });

  it("does not suppress event links with a parent accessible name", async () => {
    const a = persisted({
      id: 21,
      eventKey: "ev-alpha",
      title: "Game night spectacular raid evening alpha",
      startsAt: new Date("2026-10-15T19:00:00Z"),
    });
    const d = transient({ discordId: "discord-1", title: "Discord raid night" });
    const html = await renderMonth("2026-10", [a, d]);
    const cells = dayCells(html);
    // No aria-label/aria-labelledby on the cell itself: a parent name would
    // replace the nested link names in the accessibility tree.
    for (const cell of cells) {
      expect(cell.attrs).not.toContain("aria-label");
      expect(cell.attrs).not.toContain("aria-labelledby");
    }
    // Nested event links keep their distinct accessible names (existing control).
    const links = gridLinks(html);
    expect(links).toHaveLength(2);
    const byHref = new Map(links.map((l) => [l.href, l]));
    const aLink = byHref.get(calendarJumpUrl(false, rowKey(a)))!;
    const aName = ariaOf(aLink.attrs)!;
    expect(aName).toContain(a.title);
    expect(aName).toContain(wallTimeHm(a.startsAt, ZONE));
    expect(aName).toContain(cardDayLabel(a.startsAt, ZONE));
    expect(aLink.visible).toContain(gridTitle(a.title));
    const dLink = byHref.get(calendarJumpUrl(false, rowKey(d)))!;
    expect(ariaOf(dLink.attrs)!).toContain(d.title);
  });

  it("adds no second keyboard widget and keeps outside-month data flags", async () => {
    const html = await renderMonth("2026-12", []);
    // The grid stays a native table: no gridbox keyboard contract, no roving cells.
    expect(html).not.toContain('role="grid"');
    expect(html).not.toContain('role="treegrid"');
    expect(html).not.toMatch(/<td[^>]*tabindex/);
    // data-outside remains as the machine flag; words (asserted above) carry meaning.
    const cells = dayCells(html);
    expect(cells.some((c) => !c.inMonth)).toBe(true);
    for (const cell of cells.filter((c) => !c.inMonth)) {
      expect(cell.attrs).toContain('data-outside="true"');
    }
  });

  it("keeps no-JS month navigation and day jumps as real links", async () => {
    const e = persisted({ id: 31, eventKey: "ev-nojs" });
    const html = await renderMonth("2026-10", [e]);
    expect(html).toContain('aria-label="Previous month"');
    expect(html).toContain('aria-label="Next month"');
    expect(html).toContain('data-testid="calendar-month-jump"');
    expect(html).toContain('method="get"');
    const links = gridLinks(html);
    expect(links).toHaveLength(1);
    expect(links[0]!.href).toBe(calendarJumpUrl(false, rowKey(e)));
    // Day numbers stay plain text, not links: the event links are the targets.
    expect(visibleWords(dayCells(html)[0]!.inner)).toMatch(/^\d{1,2}/);
  });
});
