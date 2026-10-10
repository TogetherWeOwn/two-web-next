import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.mjs"],
    // Smoke fixtures use node:test and run separately through test:smoke.
    exclude: [
      ...configDefaults.exclude,
      "test/smoke.test.mjs",
      "test/json-smoke.test.mjs",
      "test/revision-check.test.mjs",
    ],
    // Live suites truncate shared tables in one database, so files run serially.
    fileParallelism: false,
    // TOG-12549: refuse non-test DATABASE_URLs before any suite connects.
    // globalSetup (not setupFiles): runs in a separate process, so importing
    // the helper here cannot bind the real `postgres` driver ahead of suites
    // that vi.mock it (e.g. test/member-data-fixture.test.ts).
    globalSetup: ["./test/global-test-db-guard.ts"],
    // The Discord events cache is module state shared across requests; reset it per case.
    setupFiles: ["./test/setup-discord-events-cache.ts"],
    // Hang detectors, not performance budgets: shared self-hosted runners are 4-5x
    // slower than hosted ones and DB-heavy tests blew the 5s/10s defaults under load
    // (TOG-12177). Deliberate per-test limits and timing asserts are listed in
    // docs/ci-load-sensitive-tests.md.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}", "tail/**/*.ts"],
      // CI uploads the artifact and the job summary reads only
      // json-summary; lcov/html are unread artifacts, so they stay off the
      // hot path (CI timing audit: `check` mean 9.5 min across 20 main runs).
      reporter: ["text", "json-summary"],
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
        "src/jobs/**": { statements: 98.2, branches: 95.8, functions: 95.7, lines: 98.7 },
        "src/bot/**": { statements: 92, branches: 88.8, functions: 99, lines: 93.5 },
        "src/agent-events/**": { statements: 93.8, branches: 92, functions: 96.8, lines: 95.4 },
        "src/profiles/**": { statements: 96.3, branches: 92, functions: 95.4, lines: 97.8 },
      },
    },
  },
});
