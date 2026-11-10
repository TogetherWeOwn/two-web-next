import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";
import { requireGithubRunner, requireTestDatabase } from "../e2e/ci-only.mjs";
import budget from "./budgets/kit/startup.json" with { type: "json" };

requireGithubRunner();
requireTestDatabase(process.env.DATABASE_URL);
const cwd = resolve(process.env.CAPTURE_APP_ROOT);
export default defineConfig({
  testDir: ".",
  testMatch: "discovery-title-capture.mjs",
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: "list",
  outputDir: "../test-results-discovery",
  use: { ignoreHTTPSErrors: true, serviceWorkers: "block", deviceScaleFactor: 1 },
  webServer: [
    {
      command:
        "node_modules/.bin/wrangler dev --config e2e/wrangler.jsonc --local --local-protocol https --ip localhost --port 8787",
      cwd,
      // The TSX preload belongs to the capture worker, not Wrangler/esbuild workers.
      env: { NODE_OPTIONS: "" },
      url: "https://localhost:8787/up",
      ignoreHTTPSErrors: true,
      reuseExistingServer: false,
      timeout: 90_000,
    },
    {
      command: "node ci/kit-worker-dev.mjs",
      cwd,
      // The TSX preload belongs to the capture worker, not Wrangler/esbuild workers.
      env: { NODE_OPTIONS: "" },
      url: "http://127.0.0.1:8788/favicon.ico",
      reuseExistingServer: false,
      timeout: budget.startup.maxMs,
    },
  ],
});
