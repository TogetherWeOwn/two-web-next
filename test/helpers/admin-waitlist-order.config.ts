// Offline fixture runner; the same spec is discovered by browser-smoke CI.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-waitlist-order.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  reporter: [["list"]],
  use: { browserName: "chromium", serviceWorkers: "block" },
});
