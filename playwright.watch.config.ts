import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";
import { requireWatchOrigin } from "./e2e/watch-guard.mjs";

// GET-only guest journeys for the 48h post-flip watch (docs/48h-watch-spec.md).
// Runs only in GitHub Actions (watch-guest-journeys.yml). WATCH_ORIGIN has no
// default: it must name the staging Worker or the apex explicitly.
requireGithubRunner();
const watchOrigin = requireWatchOrigin(process.env.WATCH_ORIGIN);

export default defineConfig({
  testDir: "./e2e/watch",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: watchOrigin,
    serviceWorkers: "block",
    // Every journey is a guest: a fresh context with no stored session, never
    // a checked-in or generated storageState.
    storageState: { cookies: [], origins: [] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
