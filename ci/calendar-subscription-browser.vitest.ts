// Standalone hermetic browser acceptance harness. No opt-in skips or changes to
// the normal test/quality gates. Builder must register this command in browser CI.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/calendar-subscription-browser.test.ts"] },
});
