import { defineConfig } from "@playwright/test";
import base from "../playwright.config";

// Content-code diagnostic: evidence only, no snapshots or thresholds. Inherits the
// base webServer and runner guard; evidence goes to CONTENT_CODE_DIAG_OUT.
export default defineConfig({
  ...base,
  webServer: { ...base.webServer, cwd: process.cwd() },
  globalTeardown: undefined,
  testDir: "../e2e/content-code-diagnostic",
  testMatch: "**/*.diagnostic.ts",
  testIgnore: [],
  outputDir: "../test-results-content-code-diagnostic",
  reporter: [["list"]],
  updateSnapshots: "none",
  // Failures must not hide later arms: the whole matrix is gathered.
  maxFailures: 0,
  timeout: 60_000,
});
