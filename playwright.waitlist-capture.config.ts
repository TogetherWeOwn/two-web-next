import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// The paired route/SSR fixture intercepts every request; no Worker or DB lifecycle.
export default defineConfig({
  ...base,
  globalTeardown: undefined,
  webServer: undefined,
  testMatch: "admin-waitlist-order.spec.ts",
  grep: /WQ-B03/,
  reporter: "list",
});
