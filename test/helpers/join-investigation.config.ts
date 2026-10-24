// Local-only runner; the same spec is discovered by the existing CI e2e glob.
// No Wrangler, database, staging origin, opt-in, skipped tests or external IO.
import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "join-investigation.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  expect: { timeout: 2_000 },
  use: { browserName: "chromium", serviceWorkers: "block" },
});
