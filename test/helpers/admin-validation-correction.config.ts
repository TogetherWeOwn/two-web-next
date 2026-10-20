// Local-only fixture runner for the same spec discovered by the normal e2e
// config in CI. No Wrangler, database, staging target, teardown or external IO.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-validation-correction.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
