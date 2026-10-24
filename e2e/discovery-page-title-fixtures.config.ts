import { defineConfig } from "@playwright/test";

// Local fixture runner; the spec is also discovered by browser-smoke in CI.
// No webServer/global setup: SSR and every browser request stay hermetic.
export default defineConfig({
  testDir: ".",
  testMatch: "discovery-page-title-acceptance.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 15_000,
  outputDir: "../test-results/discovery-page-title-fixtures",
  reporter: [["list"]],
  use: { headless: true, serviceWorkers: "block", javaScriptEnabled: false },
});
