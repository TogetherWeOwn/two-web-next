import { defineConfig } from "@playwright/test";

// Local runner for hermetic real-renderer fixtures. CI discovers the spec with
// the existing e2e/*.spec.ts glob in browser-smoke; no workflow change needed.
export default defineConfig({
  testDir: ".",
  testMatch: "faq-answer-navigation-acceptance.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  outputDir: "../test-results/faq-answer-navigation",
  reporter: "list",
  use: { headless: true, serviceWorkers: "block" },
});
