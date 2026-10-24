// Fixture-only runner; the normal e2e wildcard also discovers this spec in CI.
// No server, database, credentials, external network or production target.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-pending-save-acceptance.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 1_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
