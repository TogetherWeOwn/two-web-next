// Schedule findability + grid-hour truth: the events schedule head links to
// /hotzones, and every hot-zone grid labels its hour columns as UTC where the
// hours are read (visible caption, axis corner header, and the scroll
// region's accessible name).
// Buckets are computed in UTC (src/hotzones/aggregates.ts), so an unlabelled
// 00-23 axis reads as local time. The shared Grid renderer carries the label,
// so the Hono pages and the Kit loaders (which reuse renderHotzoneGrid) and
// the shared CalendarHead (Kit /events reuses the Hono calendar screen) all
// move together.
import { describe, expect, it } from "vitest";
import { CalendarHead } from "../src/events/pages-calendar-controls";
import { emptyGrid } from "../src/hotzones/aggregates";
import { HotzoneSignalPage, HotzonesIndexPage, renderHotzoneGrid } from "../src/hotzones/pages";

const UTC_SUFFIX = " (hours in UTC)";

describe("hot-zone grid UTC labelling", () => {
  it("shared grid renderer labels the caption and the region name as UTC", () => {
    const html = renderHotzoneGrid(emptyGrid(), "Join activity for season all");
    expect(html).toContain(`<caption>Join activity for season all${UTC_SUFFIX}</caption>`);
    expect(html).toContain(`aria-label="Join activity for season all${UTC_SUFFIX}"`);
    // Hour cells themselves stay bare 00-23; the axis corner names the zone.
    expect(html).toContain('<th scope="col">Day (UTC)</th>');
    expect(html).toContain('<th scope="col">00</th>');
    expect(html).toContain('<th scope="col">23</th>');
  });

  it("index labels all three grids as UTC and keeps the season help accurate", () => {
    const html = String(
      HotzonesIndexPage({
        appUrl: "https://example.test",
        season: "all",
        joins: emptyGrid(),
        joinsTotal: 0,
        eventCount: 0,
        voice: emptyGrid(),
        games: emptyGrid(),
      }),
    );
    for (const base of [
      "Join activity for season all",
      "Season-independent seeded estimate of voice activity",
      "Season-independent seeded estimate of games activity",
    ]) {
      expect(html).toContain(`<caption>${base}${UTC_SUFFIX}</caption>`);
      expect(html).toContain(`aria-label="${base}${UTC_SUFFIX}"`);
    }
    // The season-shortcut help still describes the shortcuts, unchanged.
    expect(html).toContain("Shortcuts use UTC.");
  });

  it.each(["joins", "voice", "games"] as const)(
    "%s signal page labels its grid as UTC",
    (signal) => {
      const html = String(
        HotzoneSignalPage({
          appUrl: "https://example.test",
          signal,
          season: "all",
          cells: emptyGrid(),
          total: 0,
        }),
      );
      expect(html.split(UTC_SUFFIX).length - 1).toBe(2);
    },
  );

  it("renders the same cell numbers, only labelled", () => {
    const cells = emptyGrid();
    cells[1]![20] = 7;
    cells[6]![0] = 3;
    const html = renderHotzoneGrid(cells, "Join activity for season all");
    const tds = [...html.matchAll(/<td>(\d+)<\/td>/g)].map((m) => Number(m[1]));
    expect(tds).toHaveLength(168);
    expect(tds.reduce((a, b) => a + b, 0)).toBe(10);
    expect(tds[1 * 24 + 20]).toBe(7);
    expect(tds[6 * 24 + 0]).toBe(3);
  });
});

describe("schedule head hot-zones link", () => {
  const state = {
    view: "list",
    month: "2026-10",
    q: "",
    past: false,
    page: 1,
    weekStart: "monday",
  } as const;

  it("renders exactly one Hot zones link to /hotzones beside the feed links", () => {
    const html = String(CalendarHead({ state: { ...state }, appUrl: "https://example.test" }));
    const hits = [...html.matchAll(/<a href="\/hotzones">Hot zones<\/a>/g)];
    expect(hits).toHaveLength(1);
    // Beside the archive/feed links in the same head paragraph, after .ics.
    const ics = html.indexOf("Download calendar (.ics)");
    const rss = html.indexOf("RSS feed");
    expect(rss).toBeGreaterThanOrEqual(0);
    expect(ics).toBeGreaterThan(rss);
    expect(html.indexOf('<a href="/hotzones">Hot zones</a>')).toBeGreaterThan(ics);
    expect(html).toContain('data-cal-zone="head"');
  });

  it("keeps the link in a searched schedule head", () => {
    const html = String(
      CalendarHead({ state: { ...state, q: "raid" }, appUrl: "https://example.test" }),
    );
    expect(html).toContain('<a href="/hotzones">Hot zones</a>');
  });
});
