// Unconditional browser oracle. Builder registers this runner in browser CI.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/calendar-navigation-browser.test.ts"] },
});
