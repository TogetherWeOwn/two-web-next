import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";

requireGithubRunner();

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "https://localhost:8787",
    ignoreHTTPSErrors: true,
    serviceWorkers: "block",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx wrangler dev --config e2e/wrangler.jsonc --local --local-protocol https --ip localhost --port 8787",
    url: "https://localhost:8787/health",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
