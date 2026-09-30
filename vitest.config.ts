import { defineConfig } from "vitest/config";

// Live suites truncate shared tables in one database, so files run serially.
export default defineConfig({ test: { include: ["test/**/*.test.ts", "test/**/*.test.mjs"], fileParallelism: false } });
