import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";
import { EXPLORE_ORIGIN } from "./e2e/explore/crawl-utils.mjs";

// Daily guest explorer of the STAGING Worker (docs/explore-staging.md). Runs
// only in GitHub Actions (explore-staging.yml). The origin is fixed to staging:
// there is no input and no production target. GET-only via the watch guard.
requireGithubRunner();

export default defineConfig({
  testDir: "./e2e/explore",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 20 * 60_000,
  reporter: [["list"]],
  use: {
    baseURL: EXPLORE_ORIGIN,
    serviceWorkers: "block",
    storageState: { cookies: [], origins: [] },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
