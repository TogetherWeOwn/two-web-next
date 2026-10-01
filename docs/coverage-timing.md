# Required-check timing diagnostics

This instrumentation attributes time; it does **not** repair or explain a job-budget expiry.
The required `check` still has its ten-minute job budget and every original command,
assertion, full-service-DB test and aggregate/area coverage floor. The seeded admin
property command retains its ten-second process limit, seed and workload. No
pool, concurrency, isolation, fixture schema, migration, reset or disposal policy changes.

## Records

CI emits completed `TWO_TEST_TIMING` JSON records in the existing job log:

- `kind: command`: monotonic child lifetime for dependency-audit selftest/audit,
  npm installation, admin properties, migrations, config check, combined typechecks,
  full coverage, a11y node tests, cutover, backup selftest, numbering and dry-run build.
  The POSIX wrapper executes the original argv, retains stdout/stderr and normal exit
  codes, and never emits argv or environment values. Each command has its own process
  group; cancellation signals the whole group, with a one-second SIGKILL escalation
  if the launcher ignores it and cleanup of remaining group members when it exits.
  The wrapper exits by the received cancellation signal even if the child exits zero.
  A command record's `exitCode` is the launcher's code; `signal` also records wrapper
  cancellation and must not be ignored. Later commands are still gated by success.
- `kind: vitest`: each file's public collection, preparation, environment, setup and
  tests-and-hooks duration; coverage-ready and **pre-reporting test-run** boundaries.
  These diagnostics use Vitest 5.0.2's reporter interface. The default reporter stays enabled.
- `kind: db`: worker-side monotonic create, migration-file read, SQL replay, reset and
  disposal spans in the shared member-data fixture (also used by jobs), and create,
  migrate, seed, reset and disposal in the users/profiles import fixture.
  Records contain only fixed fixture/phase labels, a duration and success flag.
  Console delivery can be batched, but the recorded DB duration is measured in
  the worker around the actual operation. Logging is best-effort and adds no awaits.

Fixture/reporter records are opt-in with `TEST_TIMINGS=1`; the required CI coverage
step enables them. The standalone admin-properties gate does not enable them.
Completed spans remain in job logs if a later command fails or the job is cancelled.
A phase interrupted by process termination has no completion record: absence must
not be interpreted as zero duration or successful disposal.

## Interpretation and limits

- Durations use `node:perf_hooks` `performance.now()`, independent of test fake clocks.
  Reporter time offsets and worker spans are not a common absolute timeline.
- File preparation and collection fields can overlap with worker/server work. Do not
  sum them as disjoint wall-clock phases or subtract them to infer CPU contention.
- Tests-and-hooks includes measured fixture work. Do not add DB durations to file
  durations. Jobs' underlying member-data fixture is counted once, not twice.
- `lastModuleToCoverageReadyMs` includes the tail after the last module and coverage
  collection/merge. `coverageReadyToTestRunEndMs` ends at `onTestRunEnd`, **before**
  provider reporting and coverage-threshold checks in Vitest 5.0.2. These are boundary
  spans, not exact private-provider method timings; neither measures coverage reporting.
- The `test-run-end` record's `testRunReason` describes test execution only. It can be
  `passed` even when the subsequent coverage-threshold check fails. Public hooks used
  here do not observe terminal coverage acceptance. Require the enclosing `coverage`
  command to finish with `exitCode: 0` and `signal: null`, its coverage results and all
  later required CI gates green. Reporting and teardown remain included in the whole
  command duration, not separately attributed by this reporter.
- Older `run-end` / `coverageReadyToRunEndMs` records have the same pre-reporting boundary;
  any prior interpretation as reporting cost or terminal coverage acceptance is invalid.
- Fixture coverage is deliberately narrow. Ledger/web-v1 and standalone/hybrid
  per-file source-schema setup, extra jobs pools and resets bypassing these helpers
  remain included in file totals but are not attributed as direct DB spans.
- Checkout, job/service-container initialization, apt/forwarding, setup-node, artifact
  upload and runner cleanup are not command-instrumented. GitHub step timestamps can
  bound those costs, but are not precise monotonic command durations.
- Per-phase logging adds diagnostic overhead. A local agent-testdb run and CI's
  job-private localhost forward to the `postgres` service differ in topology.
  Record the exact SHA/runtime and changed test inventory before comparing them.
- No host, external-network or product-lifecycle cause follows from a slow file alone.
  Passing file progress or numeric coverage reports on failure are not acceptance:
  require terminal green full coverage and every required exact-head CI gate.

## Focused regression verification

The diagnostic helper, sink-failure/clock behavior, unchanged fixture operation order,
setup-failure cleanup, command exit/signal handling (including graceful cancellation
and launcher/descendant cleanup), and reporter data minimization are exercised with
synthetic fixtures. A tiny isolated coverage-threshold failure verifies that a passed
`test-run-end` record is not terminal coverage acceptance:

```sh
env -i PATH="$PATH" HOME="$HOME" CI=true TEST_TIMINGS=1 \
  node node_modules/vitest/vitest.mjs run \
  test/diagnostic-timing.test.ts test/diagnostic-db-lifecycle.test.ts \
  test/time-command.test.mjs test/member-data-fixture.test.ts
```

This focused command makes no DB connection and is **not** full-DB coverage evidence.
Do not point diagnostics at production or staging, inherit live DB bindings, change
credentials after a refusal, or rerun a source PR/nightly as a substitute.

Sources:
- https://vitest.dev/api/advanced/reporters.html
- https://vitest.dev/advanced/reporters.html (reporter API stability warning)
- https://nodejs.org/api/perf_hooks.html#performancenow
- https://nodejs.org/api/child_process.html#optionsdetached
- Vitest 5.0.2 installed source: `runTestSpecifications` awaits `_testRun.end` before
  `reportCoverage`; provider `reportCoverage` performs threshold checks afterward.
  The isolated regression verifies this ordering without depending on a private hook.
