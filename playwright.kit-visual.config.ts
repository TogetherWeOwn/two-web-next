import { defineConfig } from "@playwright/test";
import parity from "./playwright.kit-parity.config";

// Keep visual actuals separate: each Playwright invocation clears its outputDir.
export default defineConfig({
  ...parity,
  testDir: "./e2e/kit-parity",
  testMatch: "events-index.visual.spec.ts",
  outputDir: "test-results-kit-visual",
  snapshotPathTemplate: "{testDir}/../visual/__screenshots-kit__/{arg}{ext}",
  reporter: [["list"]],
});
