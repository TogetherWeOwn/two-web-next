import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";
import { requireStagingOrigin } from "./e2e/staging-guard.mjs";
import { STAGING_APP_URL } from "./src/qa";

requireGithubRunner();
const stagingOrigin = requireStagingOrigin(STAGING_APP_URL);

export default defineConfig({
  testDir: "./e2e/staging",
  testMatch: "**/*.spec.ts",
  globalSetup: "./e2e/staging/global-setup.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: stagingOrigin,
    serviceWorkers: "block",
    // Written by each spec file's beforeAll from real QA logins (global-setup
    // no longer signs in); never a checked-in session.
    storageState: "e2e/staging/.auth/member.json",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    {
      name: "mobile-375",
      testMatch: "**/events-list.spec.ts",
      use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } },
    },
    {
      name: "reduced-motion",
      testMatch: "**/events-list.spec.ts",
      use: { ...devices["Desktop Chrome"], reducedMotion: "reduce" },
    },
  ],
});
