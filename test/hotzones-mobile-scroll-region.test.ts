// Acceptance (test files only) for PR #921:
// `fix(hotzones): contain heatmap grids in a scroll region on mobile`.
//
// Contract lock-in (Test Author). The Land #921 builder implements against
// this file; nothing here may change to make an implementation pass.
//
// Why markup + CSS, not pixels: Vitest has no layout engine, so the 390px
// proof is a contract proof. The 7x24 grid keeps its 42rem (672px) min-width
// floor from public/schedule-theme.css, which is wider than the 390px mobile
// viewport, so the grid MUST overflow something. What makes the fix a fix is
// *what* overflows: with each grid wrapped in a `data-hotzone-scroll` region
// styled `overflow-x: auto; max-width: 100%`, the region scrolls internally
// and the page stays at viewport width (`document.scrollWidth <=
// window.innerWidth`). On main (no wrapper, no rule) the same 672px grid
// overflows the page itself -- the e2e parity journey documents exactly this
// (`e2e/kit-parity/parity.spec.ts`: mobile overflow expected, desktop pinned).
// At 1280px the grid fits, so the region never scrolls and the desktop
// presentation is unchanged (bare `<table>` pin below keeps the kit-parity
// gate green).
//
// How this fails on main: no `data-hotzone-scroll` in any rendered grid and
// no scroll-region rule in the CSS, so the wrapper and CSS tests go red while
// the desktop/structure pins stay green. How it passes on the PR head: all
// green, no production edit needed beyond the PR itself.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import app from "./app";
import { emptyGrid } from "../src/hotzones/aggregates";
import { renderHotzoneGrid } from "../src/hotzones/pages";
import type { Env } from "../src/env";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const css = () => readFileSync(resolve(root, "public/schedule-theme.css"), "utf8");

const env: Env = {
  APP_URL: "https://next.example.test",
  DISCORD_CLIENT_ID: "client-id",
  DISCORD_GUILD_ID: "326474832151838730",
  DISCORD_INVITE_URL: "https://discord.gg/invite",
  DISCORD_CLIENT_SECRET: "client-secret",
  DISCORD_BOT_TOKEN: "bot-token",
  SESSION_SECRET: "test-session-secret-at-least-32-bytes-long",
};

const gridHtml = (caption: string) => renderHotzoneGrid(emptyGrid(), caption);
const count = (html: string, needle: string) => html.split(needle).length - 1;

describe("hotzone mobile scroll region (PR #921 acceptance)", () => {
  it("wraps the grid in a labelled keyboard-focusable scroll region", () => {
    const caption = "Join activity for season all";
    const html = gridHtml(caption);
    expect(html).toContain("data-hotzone-scroll");
    expect(html).toContain('role="region"');
    expect(html).toContain(`aria-label="${caption}"`);
    expect(html).toContain('tabindex="0"');
    // The wrapper contains the table: it opens before <table> and the table
    // closes before the region does, so the grid scrolls inside the region
    // instead of overflowing the page.
    const open = html.indexOf("data-hotzone-scroll");
    const tableOpen = html.indexOf("<table>");
    const tableClose = html.indexOf("</table>");
    expect(open).toBeGreaterThanOrEqual(0);
    expect(tableOpen).toBeGreaterThan(open);
    expect(tableClose).toBeGreaterThan(tableOpen);
    expect(html.indexOf("</div>", tableClose)).toBeGreaterThan(tableClose);
  });

  it("keeps the 7x24 structure inside the region (7 rows, 25 column headers)", () => {
    const html = gridHtml("Join activity for season all");
    expect(count(html, "<tr>")).toBe(8);
    expect(count(html, 'scope="col"')).toBe(25);
    expect(count(html, 'scope="row"')).toBe(7);
    expect(html).toContain("<table>");
  });

  it("keeps all three index grids inside their own scroll regions", async () => {
    const res = await app.request("/hotzones", {}, env);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(count(html, "data-hotzone-scroll")).toBe(3);
    expect(count(html, "<table>")).toBe(3);
  });

  it.each(["joins", "voice", "games"] as const)(
    "keeps the %s signal grid inside a scroll region",
    async (signal) => {
      const res = await app.request(`/hotzones/${signal}`, {}, env);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain("data-hotzone-scroll");
      expect(html).toContain("<table>");
    },
  );

  it("ships the scroll-region CSS so the region scrolls and the page does not", () => {
    const theme = css();
    const rule = theme.match(/\[data-hotzone-scroll\][^{]*\{[^}]*\}/);
    expect(rule, "schedule-theme.css carries a [data-hotzone-scroll] rule").not.toBeNull();
    expect(rule![0]).toContain("overflow-x");
    expect(rule![0]).toContain("auto");
    expect(rule![0]).toContain("max-width");
    expect(rule![0]).toContain("100%");
  });

  it("keeps the desktop presentation: 42rem grid floor with a bare table", () => {
    // 672px floor > 390px viewport (mobile scrolls inside the region);
    // 672px < 1280px viewport (desktop never scrolls). The bare `<table>`
    // keeps the ci/kit-parity-gates.mjs `<table>` pin green.
    expect(css()).toContain("min-width: 42rem");
    expect(gridHtml("Join activity for season all")).toContain("<table>");
  });
});
