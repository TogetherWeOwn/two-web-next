import { defineConfig } from "@playwright/test";

// Standalone fixture-only acceptance run: no E2E auth, worker or DB startup.
// The spec is also discovered by the ordinary e2e/*.spec.ts CI suite.
export default defineConfig({
  testDir: "../../e2e",
  testMatch: "admin-table-clarity.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  expect: { timeout: 250 },
  reporter: "line",
  outputDir: `${process.env.PAPERCLIP_SCRATCH_DIR ?? process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? "test-results"}/admin-table-clarity`,
  use: { browserName: "chromium", headless: true, trace: "off" },
});
