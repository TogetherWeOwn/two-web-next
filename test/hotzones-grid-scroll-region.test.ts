// The 7x24 hot-zone grids keep a 42rem floor (public/schedule-theme.css), so a
// 390px viewport only avoids page-level horizontal overflow when each grid
// sits in a contained, keyboard-focusable scroll region. These pins fail if
// either half (the markup or the CSS rule) is reverted; the browser journey in
// e2e/kit-parity/parity.spec.ts measures the same contract on both renderers.
import { readFileSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import { emptyGrid } from "../src/hotzones/aggregates";
import { HotzoneSignalPage, HotzonesIndexPage, renderHotzoneGrid } from "../src/hotzones/pages";

const REGION = /<div\b[^>]*\bdata-hotzone-scroll\b[^>]*>/g;

const regionsOf = (html: string) => html.match(REGION) ?? [];

// The grid table stays bare (ci/kit-parity-gates.mjs pins a literal "<table>"),
// so the region wraps it rather than the table carrying the attributes.
const expectContainedGrid = (html: string, caption: string) => {
  const region = `<div data-hotzone-scroll="true" role="region" aria-label="${caption}" tabindex="0">`;
  const start = html.indexOf(region);
  expect(start, `region for "${caption}"`).toBeGreaterThanOrEqual(0);
  const inner = html.slice(start + region.length);
  expect(inner.startsWith(`<table><caption>${caption}</caption>`)).toBe(true);
  expect(inner.slice(0, inner.indexOf("</table>") + "</table>".length)).toContain("</tbody>");
  expect(inner.slice(inner.indexOf("</table>") + "</table>".length).startsWith("</div>")).toBe(
    true,
  );
};

describe("hot-zone grid scroll region", () => {
  it("shared grid renderer wraps one bare table in a labelled, focusable region", () => {
    const html = renderHotzoneGrid(emptyGrid(), "Join activity for season all");
    expect(regionsOf(html)).toHaveLength(1);
    expectContainedGrid(html, "Join activity for season all");
    expect(html).not.toMatch(/<table\s/);
  });

  it("index wraps all three grids, each labelled by its own caption", () => {
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
    expect(regionsOf(html)).toHaveLength(3);
    expect(html.match(/<table>/g)).toHaveLength(3);
    expectContainedGrid(html, "Join activity for season all");
    expectContainedGrid(html, "Season-independent seeded estimate of voice activity");
    expectContainedGrid(html, "Season-independent seeded estimate of games activity");
  });

  it.each([
    ["joins", "Join activity for season all"],
    ["voice", "Season-independent seeded estimate of voice activity"],
    ["games", "Season-independent seeded estimate of games activity"],
  ] as const)("%s signal page wraps its grid", (signal, caption) => {
    const html = String(
      HotzoneSignalPage({
        appUrl: "https://example.test",
        signal,
        season: "all",
        cells: emptyGrid(),
        total: 0,
      }),
    );
    expect(regionsOf(html)).toHaveLength(1);
    expectContainedGrid(html, caption);
  });

  it("schedule sheet contains the region and keeps the grid's 42rem desktop floor", () => {
    const css = readFileSync(new URL("../public/schedule-theme.css", import.meta.url), "utf8");
    const rule = css.match(/\.events-page \[data-hotzone-scroll\]\s*\{([^{}]*)\}/);
    expect(rule, "scoped scroll-region rule").not.toBeNull();
    expect(rule![1]).toMatch(/overflow-x:\s*auto/);
    expect(rule![1]).toMatch(/max-width:\s*100%/);
    // Desktop presentation is unchanged: the table still carries its floor.
    expect(css).toMatch(/\.events-page table\s*\{[^{}]*min-width:\s*42rem/);
  });
});
