// Local fixture runner; the ordinary CI browser-smoke glob discovers the same
// spec. No live target, Wrangler, QA login, retries or database URL fallback.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-exact-series.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
