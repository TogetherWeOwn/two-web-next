import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";
import base from "./playwright.config";

requireGithubRunner();

// Kit journey parity (TOG-22120, docs/kit-parity-gates.md): the no-login
// journeys in e2e/kit-parity/ run against BOTH the Hono worker
// (https://localhost:8787, same entrypoint as the browser smoke) and the
// adapter-built Kit Worker (http://127.0.0.1:8788 via ci/kit-worker-dev.mjs,
// same fixture shape as ci/kit-worker-e2e.mjs). Runs in the browser-smoke job
// AFTER the critical journeys, on the same seeded disposable Postgres — the
// specs are read-only (no fixtures, no writes, no QA logins), so journey
// mutations cannot skew them and they cannot skew the teardown sweep.
// The JSON report feeds ci/check-kit-parity.mjs, which fails loud when
// nothing passed (Playwright exits 0 on all-skipped).
export default defineConfig({
  ...base,
  globalTeardown: undefined,
  testDir: "./e2e/kit-parity",
  testMatch: "**/*.spec.ts",
  testIgnore: [],
  outputDir: "test-results-kit-parity",
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-kit-parity" }],
    ["json", { outputFile: "test-results/kit-parity-journeys.json" }],
  ],
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command:
        "npx wrangler dev --config e2e/wrangler.jsonc --local --local-protocol https --ip localhost --port 8787",
      url: "https://localhost:8787/up",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 90_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
    {
      command: "node ci/kit-worker-dev.mjs",
      url: "http://127.0.0.1:8788/favicon.ico",
      reuseExistingServer: false,
      timeout: 120_000,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
  ],
});
