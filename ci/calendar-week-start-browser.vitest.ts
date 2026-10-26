// Unconditional local Chromium acceptance. Builder registers this command in
// browser CI; the ordinary coverage job does not install browser dependencies.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/calendar-week-start-browser.test.ts"] },
});
