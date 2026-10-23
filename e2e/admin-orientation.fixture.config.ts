// Test Author owned; fixture-only entry point, never a deployed-origin runner.
import { defineConfig } from "@playwright/test";
import { join } from "node:path";

export default defineConfig({
  testDir: ".",
  testMatch: "admin-orientation.spec.ts",
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  outputDir: join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? "test-results", "admin-orientation"),
  reporter: [
    ["list"],
    [
      "json",
      {
        outputFile: join(
          process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? "test-results",
          "admin-orientation-browser.json",
        ),
      },
    ],
  ],
  use: {
    browserName: "chromium",
    serviceWorkers: "block",
    launchOptions: { args: ["--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=127.0.0.1"] },
    trace: "retain-on-failure",
  },
});
