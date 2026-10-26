// Offline acceptance runner; the spec is also discovered by browser-smoke CI.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "featured-inventory-effective-state.spec.ts",
  outputDir: "../../test-results/featured-inventory-effective-state",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
