import { defineConfig } from "@playwright/test";

// Fast local runner for the auth-admission poison suite: self-contained
// renderer fixtures, every request intercepted, no server or database.
export default defineConfig({
  testDir: ".",
  testMatch: "calendar-auth-admission.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15_000,
  outputDir: "../test-results/calendar-auth-admission",
  reporter: [["list"], ["json", { outputFile: "../test-results/calendar-auth-admission.json" }]],
  use: {
    headless: true,
    serviceWorkers: "block",
    viewport: { width: 1280, height: 800 },
    screenshot: "only-on-failure",
  },
});
