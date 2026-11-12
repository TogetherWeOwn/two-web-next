import { defineConfig } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";

requireGithubRunner();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "admin-stale-save.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [["list"], ["html", { outputFolder: "playwright-report-stale-save", open: "never" }]],
  use: { serviceWorkers: "block", trace: "retain-on-failure" },
});
