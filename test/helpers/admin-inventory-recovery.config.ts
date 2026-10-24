// Offline runner for the spec also discovered by normal browser-smoke CI.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-inventory-recovery.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
