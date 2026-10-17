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
  // Cancels any "Staging E2E" fixture a journey's own cleanup left live.
  globalTeardown: "./e2e/staging/global-teardown.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  // The JSON report feeds ci/check-staging-journeys.mjs, which ledgers every
  // journey pass/skip/fail and fails loud when nothing passed (Playwright
  // exits 0 on all-skipped, so without the gate that run looks green).
  // No HTML report: it embeds each API call's raw step error, and a
  // token-bearing QA call's step error carries its request headers. This
  // repo is public and its failure artifacts are downloadable, so that
  // recording surface stays off (e2e/qa-artifacts.test.mjs); the sweep in
  // ci/scrub-qa-token.py remains the fail-closed backstop.
  reporter: [["list"], ["json", { outputFile: "test-results/staging-journeys.json" }]],
  use: {
    baseURL: stagingOrigin,
    serviceWorkers: "block",
    // Written by each spec file's beforeAll from real QA logins (global-setup
    // no longer signs in); never a checked-in session.
    storageState: "e2e/staging/.auth/member.json",
    // No traces on the staging journeys: a trace records the token-bearing
    // QA calls themselves (action parameters and network headers), even
    // when the call succeeds and the journey fails later for another
    // reason, so any retained trace would carry the QA header into the
    // public failure artifact. Screenshots and the ledger stay as the
    // failure evidence; they cannot hold request data.
    trace: "off",
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
