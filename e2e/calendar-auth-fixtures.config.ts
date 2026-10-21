import { defineConfig } from "@playwright/test";

// Self-contained renderer fixtures, not the CI-only built-Worker journeys.
// Every request is intercepted; no server, database or OAuth service is started.
export default defineConfig({
  testDir: ".",
  testMatch: "calendar-auth-destinations.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15_000,
  outputDir: "../test-results/calendar-auth-fixtures",
  reporter: [["list"], ["json", { outputFile: "../test-results/calendar-auth-results.json" }]],
  use: {
    headless: true,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
  },
});
