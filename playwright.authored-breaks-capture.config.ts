import { defineConfig } from "@playwright/test";
import kitParity from "./playwright.kit-parity.config";

// Opt-in evidence, not a gate. Reuses the Kit parity project's real Hono and Kit
// workers (webServer) and seeded disposable Postgres, but collects only the one
// capture file: parity.spec.ts, its JSON ledger report and its visual baselines are
// never touched.
export default defineConfig({
  ...kitParity,
  testDir: "./e2e",
  testMatch: "**/authored-line-breaks.capture.ts",
  testIgnore: [],
  outputDir: "test-results-authored-breaks",
  reporter: "list",
  updateSnapshots: "none",
});
