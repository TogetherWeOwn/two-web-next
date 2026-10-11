import { expect, test } from "../fixtures";

// Public pages only: no session, no writes. Server-rendered times depend on the
// wall clock, so every <time> element is masked; everything else must match the
// committed baseline within maxDiffPixelRatio (playwright.visual.config.ts).
// Changing a baseline is a deliberate act: see docs/visual-regression.md.
const ROUTES: Array<[name: string, path: string]> = [
  ["home", "/"],
  ["events", "/events"],
  ["event", "/e/01J00000000000000000000001"],
  ["past", "/events/past"],
  ["community", "/community"],
  ["rules", "/rules"],
  ["privacy", "/privacy"],
];

const VIEWPORTS: Array<[name: string, size: { width: number; height: number }]> = [
  ["desktop", { width: 1280, height: 800 }],
  ["mobile", { width: 390, height: 844 }],
];

for (const [viewport, size] of VIEWPORTS) {
  for (const [name, path] of ROUTES) {
    test(`${name} @ ${viewport}`, async ({ page }) => {
      await page.setViewportSize(size);
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`${name}-${viewport}.png`, {
        fullPage: true,
        mask: [page.locator("time")],
      });
    });
  }
}
