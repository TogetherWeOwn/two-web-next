import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Visual regression (docs/visual-regression.md): full-page screenshots of the
// public routes at desktop and mobile widths against committed baselines in
// e2e/visual/__screenshots__. Runs in the browser-smoke job BEFORE the journey
// specs, on the freshly seeded state, because journeys mutate events/RSVPs.
// A differing screenshot fails. A missing one is written (never an existing
// one: "missing" only creates) and the job then fails on the uncommitted file,
// so the failure artifact carries the new baseline for review.
export default defineConfig({
  ...base,
  // Read-only run: no fixtures to sweep. The base teardown logs in as the QA
  // moderator and cancels fixtures, which must not run between this step and
  // the journeys.
  globalTeardown: undefined,
  testDir: "./e2e/visual",
  testMatch: "**/*.visual.ts",
  testIgnore: [],
  outputDir: "test-results-visual",
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-visual" }]],
  updateSnapshots: "missing",
  snapshotPathTemplate: "{testDir}/__screenshots__/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixelRatio: 0.01,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
});
