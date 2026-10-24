// Fixture-only entry point: no Wrangler server, CI identity, database or network.
// The same spec is discovered by the normal browser-smoke configuration in CI.
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "../../e2e",
  testMatch: "profile-milestone-disclosure.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  reporter: "list",
  outputDir: process.env.PAPERCLIP_RUN_SCRATCH_DIR
    ? `${process.env.PAPERCLIP_RUN_SCRATCH_DIR}/milestone-browser-results`
    : "../../test-results/milestone-disclosure",
  use: {
    browserName: "chromium",
    javaScriptEnabled: false,
    serviceWorkers: "block",
    launchOptions: {
      args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=localhost;127.0.0.1;[::1]"],
    },
  },
});
