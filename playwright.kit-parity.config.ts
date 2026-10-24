import { defineConfig, devices } from "@playwright/test";
import { requireGithubRunner } from "./e2e/ci-only.mjs";
import base from "./playwright.config";
import kitPerfBudget from "./ci/kit-perf-budgets/base.json" with { type: "json" };

requireGithubRunner();

// Same single-variable address as e2e/kit-parity.ts: an explicit
// KIT_WORKER_ORIGIN wins, otherwise the origin derives from KIT_WORKER_PORT,
// the port ci/kit-worker-dev.mjs listens on.
const kitOrigin =
  process.env.KIT_WORKER_ORIGIN ?? `http://127.0.0.1:${process.env.KIT_WORKER_PORT ?? "8788"}`;

// Kit journey parity (docs/kit-parity-gates.md): the journeys in
// e2e/kit-parity/ run against BOTH the Hono worker
// (https://localhost:8787, same entrypoint as the browser smoke) and the
// adapter-built Kit Worker (http://127.0.0.1:8788 via ci/kit-worker-dev.mjs,
// same fixture shape as ci/kit-worker-e2e.mjs). CI runs the separate
// events-index visual spec on the freshly seeded database before mutable
// browser journeys, then runs parity.spec.ts after the critical journeys on
// the same seeded disposable Postgres. The specs are read-only apart from the
// member-board journey's own writes — its single shared QA login (session row
// and anonymous board-view rows, counted like any other journey's) and its one
// going RSVP on the seeded event, withdrawn in afterAll — and the archive
// journey's 24 seeded rows (swept in afterAll), so they cannot contaminate the
// visual baseline or skew the teardown sweep.
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
  // Kit visual baselines (docs/kit-parity-gates.md): archive, events-index, and
  // member-board screenshots land in e2e/visual/__screenshots-kit__/, never the
  // Hono directory. CI never rewrites an existing baseline ("missing" only
  // creates absent ones); new baselines fail the uncommitted-baselines check
  // for review via node ci/kit-visual-accept.mjs. Same absolute pixel budget as
  // the Hono visual spec (playwright.visual.config.ts).
  updateSnapshots: "missing",
  snapshotPathTemplate: "{testDir}/../visual/__screenshots-kit__/{arg}{ext}",
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 300,
      animations: "disabled",
      caret: "hide",
      scale: "css",
    },
  },
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
      url: `${kitOrigin}/favicon.ico`,
      reuseExistingServer: false,
      // True startup enforcement: a worker that never becomes ready fails
      // the run before any journey executes. The ceiling is startup.maxMs in
      // ci/kit-perf-budgets/base.json (same cold-start bound as
      // ci/kit-worker-e2e.mjs's listen).
      timeout: kitPerfBudget.startup.maxMs,
      env: { WRANGLER_SEND_METRICS: "false" },
    },
  ],
});
