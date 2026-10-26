import { describe, expect, it } from "vitest";
import { gridEvidence, scheduleHotzoneLinks } from "./helpers/hotzones-schedule-acceptance";

describe("hotzones acceptance markup oracle", () => {
  it("does not mistake period shortcut help or another grid's label for an axis label", () => {
    const grids = gridEvidence(`
      <p>Shortcuts use UTC.</p>
      <table><caption>Joins (UTC)</caption></table>
      <table><caption>Voice activity</caption><thead><tr><th scope="col">00</th></tr></thead></table>
    `);
    expect(grids).toHaveLength(2);
    expect(grids[0]!.visibleAxis).toMatch(/\bUTC\b/);
    expect(grids[1]!.visibleAxis).not.toMatch(/\bUTC\b/);
    expect(grids[1]!.accessibleAxis).not.toMatch(/\bUTC\b/);
  });

  it("distinguishes visible hour labels from an accessible-name override", () => {
    const [grid] = gridEvidence(`
      <table><caption aria-label="Joins">Joins (UTC)</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">00</th></tr></thead></table>
    `);
    expect(grid!.visibleAxis).toMatch(/\bUTC\b/);
    expect(grid!.accessibleAxis).not.toMatch(/\bUTC\b/);
  });

  it("honors a table name that overrides its visible caption", () => {
    const [grid] = gridEvidence(`
      <table aria-label="Joins"><caption>Joins (UTC)</caption>
      <thead><tr><th scope="col">Day</th><th scope="col">00</th></tr></thead></table>
    `);
    expect(grid!.visibleAxis).toMatch(/\bUTC\b/);
    expect(grid!.accessibleAxis).not.toMatch(/\bUTC\b/);
  });

  it("does not count a global-navigation link as a schedule-head link", () => {
    expect(
      scheduleHotzoneLinks(`
        <nav><a href="/hotzones">Hot zones</a></nav>
        <div data-cal-zone="head"><a href="/events.rss">RSS</a></div>
      `),
    ).toEqual({ headCount: 1, links: [] });
  });
});
