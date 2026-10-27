// Unconditional acceptance runner; no browser dependency in unit-test jobs.
// Builder registers this command and its executed-count receipt in browser CI.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/schedule-search-context-browser.test.ts"] },
});
