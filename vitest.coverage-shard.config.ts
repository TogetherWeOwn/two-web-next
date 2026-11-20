import { defineConfig } from "vitest/config";
import config from "./vitest.config";

const { test } = config;
if (!test?.coverage) throw new Error("The coverage shard requires the repository coverage config");

// A shard contributes coverage but cannot satisfy whole-suite thresholds.
// Only the merge uses the canonical vitest.config.ts and writes the final reports.
export default defineConfig({
  ...config,
  test: { ...test, coverage: { ...test.coverage, thresholds: undefined, reporter: [] } },
});
