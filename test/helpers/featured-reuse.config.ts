// Local fixture-only runner. The same spec is discovered by the normal
// browser-smoke configuration in CI. No server, database or external target.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "featured-reuse.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
