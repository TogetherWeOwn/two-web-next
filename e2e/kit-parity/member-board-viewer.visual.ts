// Protected acceptance/visual spec, imported by the existing Kit visual entrypoint.
// Offline actual SSR twins, served CSS, synthetic Overall/relative rankings.
// Catches: absent viewer styling, color-only forced-colors marking, and headers
// that scroll out of view. Baselines belong to the implementation PR, from CI.
import { expect, test } from "@playwright/test";
import {
  memberBoardDocument,
  prepareMemberBoardFixtures,
  VIEWER,
} from "../../test/fixtures/member-board-viewer";

test.beforeAll(prepareMemberBoardFixtures);

const viewports = [
  { name: "desktop", width: 1280, height: 800 },
  { name: "mobile", width: 390, height: 844 },
];

// String browser expressions follow the existing no-DOM-lib test harness.
// Compare the SAME row with/without aria-current: adjacent-row zebra striping
// must not be mistaken for a viewer highlight. Include cells/pseudo-elements.
const markerProbe = `(() => {
  const row = document.querySelector('tbody tr[aria-current="true"]');
  const elements = [row, ...row.querySelectorAll("td, th")];
  const transparent = color => color === "transparent" || color === "rgba(0, 0, 0, 0)";
  const signatures = () => elements.flatMap(element =>
    [null, "::before", "::after"].map(pseudo => {
      const style = getComputedStyle(element, pseudo);
      const drawn = !pseudo || (style.content !== "none" && style.content !== "normal");
      const edges = ["outline", "border-top", "border-right", "border-bottom", "border-left"]
        .filter(edge => Number.parseFloat(style.getPropertyValue(edge + "-width")) > 0 &&
          !["none", "hidden"].includes(style.getPropertyValue(edge + "-style")) &&
          !transparent(style.getPropertyValue(edge + "-color")));
      return {
        edgeShape: drawn ? edges.map(edge => [edge, style.getPropertyValue(edge + "-width"),
          style.getPropertyValue(edge + "-style")].join(":")).join(";") : "",
        edgeColor: drawn ? edges.map(edge => style.getPropertyValue(edge + "-color")).join(";") : "",
        background: drawn && !transparent(style.backgroundColor) ? style.backgroundColor : "",
        shadow: drawn ? style.boxShadow : "none",
      };
    }));
  const marked = signatures();
  row.removeAttribute("aria-current");
  const ordinary = signatures();
  row.setAttribute("aria-current", "true");
  return {
    visible: marked.some((style, index) => JSON.stringify(style) !== JSON.stringify(ordinary[index])),
    nonColor: marked.some((style, index) => style.edgeShape !== "" && style.edgeShape !== ordinary[index].edgeShape),
  };
})()`;

const scrollProbe = `(async () => {
  const element = document.querySelector("table");
  const headers = [...element.querySelectorAll("thead th")];
  const firstRow = element.querySelector("tbody tr");
  // Add scroll runway, not table height: the header must stick within the real table.
  const runway = document.createElement("div");
  runway.style.height = "1000px";
  document.body.append(runway);
  let scroller = element.parentElement;
  while (scroller && scroller !== document.body) {
    if (/auto|scroll/.test(getComputedStyle(scroller).overflowY) &&
      scroller.scrollHeight > scroller.clientHeight) break;
    scroller = scroller.parentElement;
  }
  const inner = scroller && scroller !== document.body ? scroller : null;
  element.scrollIntoView({ block: "start" });
  const before = firstRow.getBoundingClientRect().top;
  if (inner) inner.scrollTop += 120;
  else window.scrollBy(0, 120);
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const top = inner ? Math.max(0, inner.getBoundingClientRect().top) : 0;
  const result = {
    moved: before - firstRow.getBoundingClientRect().top,
    headers: headers.map(header => ({ top: header.getBoundingClientRect().top,
      bottom: header.getBoundingClientRect().bottom, text: header.textContent.trim() })),
    top,
    tableBottom: element.getBoundingClientRect().bottom,
  };
  // Keep the runway until the browser context closes, so the screenshot's scroll
  // position cannot clamp back up on the shorter relative board.
  return result;
})()`;

for (const twin of ["hono", "kit"] as const) {
  for (const scope of ["overall", "relative"] as const) {
    for (const viewport of viewports) {
      for (const forcedColors of ["none", "active"] as const) {
        const label = `${twin}-${scope}-${viewport.name}-${forcedColors}`;
        test(`${label}: viewer marker, readable scrolled header and visual baseline`, async ({
          browser,
        }) => {
          const context = await browser.newContext({ viewport, forcedColors });
          try {
            await context.route("**/*", (route) => route.abort("blockedbyclient"));
            const page = await context.newPage();
            await page.setContent(memberBoardDocument(twin, scope));
            const viewer = page.locator('tbody tr[aria-current="true"]');
            await expect(viewer).toHaveCount(1);
            await expect(viewer).toContainText(VIEWER);
            const marker = await page.evaluate<{ visible: boolean; nonColor: boolean }>(
              markerProbe,
            );
            expect
              .soft(
                marker.visible,
                `${label}: viewer needs a visible marker, not aria-current alone`,
              )
              .toBe(true);
            if (forcedColors === "active") {
              expect
                .soft(marker.nonColor, `${label}: forced colors needs a distinct outline/border`)
                .toBe(true);
            }

            await expect(page.locator("table").filter({ has: viewer })).toHaveCount(1);
            const scrolled = await page.evaluate<{
              moved: number;
              headers: Array<{ top: number; bottom: number; text: string }>;
              top: number;
              tableBottom: number;
            }>(scrollProbe);
            expect(
              scrolled.moved,
              `${label}: fixture must actually scroll body rows`,
            ).toBeGreaterThan(80);
            expect(
              scrolled.tableBottom,
              `${label}: still scrolling within the table`,
            ).toBeGreaterThan(scrolled.top + 50);
            expect(scrolled.headers.length).toBeGreaterThan(0);
            for (const header of scrolled.headers) {
              expect
                .soft(header.top, `${label}: header must remain inside the visible scrollport`)
                .toBeGreaterThanOrEqual(scrolled.top - 1);
              expect
                .soft(header.bottom, `${label}: readable header after scroll`)
                .toBeGreaterThan(scrolled.top + 10);
              expect(header.text).not.toBe("");
            }
            expect
              .soft(
                await page.locator("html").evaluate((element) => element.scrollWidth),
                `${label}: no mobile document overflow`,
              )
              .toBeLessThanOrEqual(viewport.width);
            await expect(viewer).toBeInViewport();

            // Soft assertions retain actuals of both missing behaviors for CI review.
            await expect.soft(page).toHaveScreenshot(`member-board-viewer-${label}.png`, {
              fullPage: false,
              animations: "disabled",
              caret: "hide",
            });
          } finally {
            await context.close();
          }
        });
      }
    }
  }
}
