// Local-only runner for the spec also discovered by normal browser-smoke CI.
// No application server, credentials, database, staging or remote IO.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "game-input-suggestions.spec.mjs",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
