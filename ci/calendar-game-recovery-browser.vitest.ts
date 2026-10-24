// Acceptance-only runner, unconditional Chromium. No gate, skip or budget changes.
// Builder must register the explicit command beside the existing browser suites.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/calendar-game-recovery-browser.test.ts"] },
});
