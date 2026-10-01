import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    // Smoke fixtures use node:test and run separately through test:smoke.
    exclude: [...configDefaults.exclude, "test/smoke.test.mjs"],
    // Live suites truncate shared tables in one database, so files run serially.
    fileParallelism: false,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "json-summary", "lcov", "html"],
      reportOnFailure: true,
      // Node 24 + full test-DB suite: baseline minus 1 point, rounded down to 0.1.
      // Aggregate area floors prevent unrelated coverage from masking a regression.
      thresholds: {
        statements: 90.8,
        branches: 84.2,
        functions: 92.3,
        lines: 94.4,
        "src/admin/**": { statements: 81.6, branches: 69.6, functions: 89.9, lines: 89.5 },
        "src/events/**": { statements: 92, branches: 86.3, functions: 96.1, lines: 96.7 },
        "src/join/**": { statements: 96, branches: 92.8, functions: 99, lines: 98.1 },
        "src/sessions.ts": { statements: 94.7, branches: 79.9, functions: 99, lines: 94.4 },
      },
    },
  },
});
