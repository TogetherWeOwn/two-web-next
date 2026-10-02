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
    // Browser routing doesn't re-intercept server-side redirect hops. A dead
    // proxy makes every non-loopback destination fail closed, even on redirects.
    launchOptions: { args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"] },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npx wrangler dev --config e2e/wrangler.jsonc --local --local-protocol https --ip localhost --port 8787",
    url: "https://localhost:8787/up",
    ignoreHTTPSErrors: true,
    reuseExistingServer: false,
    timeout: 90_000,
    env: { WRANGLER_SEND_METRICS: "false" },
  },
});
