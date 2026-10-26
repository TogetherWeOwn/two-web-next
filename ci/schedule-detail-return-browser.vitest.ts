// Independent acceptance runner; unconditional Chromium, no product/gate changes.
// Register this command in browser CI when consuming the acceptance history.
import { defineConfig } from "vitest/config";
import root from "../vitest.config";

export default defineConfig({
  ...root,
  test: { ...root.test, include: ["ci/schedule-detail-return-browser.test.ts"] },
});
