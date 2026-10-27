import { defineConfig } from "@playwright/test";

// Test-only offline runner; the same spec is auto-discovered by browser-smoke.
// All requests are intercepted. No Worker, database, auth or network service.
export default defineConfig({
  testDir: ".",
  testMatch: "event-adjacent-preview.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15_000,
  expect: { timeout: 1000 },
  outputDir: "../test-results/adjacent-preview",
  reporter: [["list"]],
  use: { headless: true, serviceWorkers: "block", screenshot: "only-on-failure" },
});
