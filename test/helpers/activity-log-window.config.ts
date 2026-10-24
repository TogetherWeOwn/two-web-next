// Standalone hermetic runner, not the deployed-site/browser-smoke config.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "activity-log-window-acceptance.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  outputDir: process.env.PAPERCLIP_RUN_SCRATCH_DIR
    ? `${process.env.PAPERCLIP_RUN_SCRATCH_DIR}/activity-window-browser`
    : "../../test-results/activity-window",
  use: { browserName: "chromium", headless: true },
});
