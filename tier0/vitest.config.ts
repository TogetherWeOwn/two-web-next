// Tier-0 report-only runner (TOG-19263). The root vitest.config.ts includes
// test/**, and everything under test/ runs inside the blocking coverage step;
// these suites must stay report-only until TOG-19236 step 3 flips them, so
// they live in tier0/ with their own config and run only from the
// `test:tier0` script (wired to the report-only CI step). Same DB guard,
// cache reset and timeouts as the main config; no coverage (thresholds belong
// to the blocking run).
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export default defineConfig({
  root: repoRoot,
  test: {
    include: ["tier0/**/*.test.ts"],
    exclude: [...configDefaults.exclude],
    fileParallelism: false,
    globalSetup: ["./test/global-test-db-guard.ts"],
    setupFiles: ["./test/setup-discord-events-cache.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
