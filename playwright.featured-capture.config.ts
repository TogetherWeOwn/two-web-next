import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Opt-in evidence, not baseline acceptance. Each invocation starts a fresh worker.
export default defineConfig({
  ...base,
  globalTeardown: undefined,
  testMatch: "**/featured-home.capture.ts",
});
