// Fixture-only Chromium entry point: no Worker, database, live origin or server.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "profile-schedule-links.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [["list"]],
  use: { serviceWorkers: "block" },
});
