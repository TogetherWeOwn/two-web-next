import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in evidence, not baseline acceptance. Runs the real local Wrangler Hono
// Worker against the disposable CI Postgres; the capture owns and removes its
// own draft rows, so the suite-wide fixture teardown is not needed.
export default defineConfig({
  ...base,
  globalTeardown: undefined,
  testMatch: "**/admin-event-form.capture.ts",
  outputDir: process.env.EVENT_FORM_CAPTURE_OUTPUT || base.outputDir,
  reporter: "list",
});
