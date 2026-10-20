# Quality gates

Deterministic gates over reviewer judgment. New gates start WARN (report, do
not fail) unless marked HARD. All of them run on the existing runners only.

- **fetch-await (HARD):** `sg-rules/fetch-await.yml` (`language: ts`,
  `src/**/*.ts`) plus its twin `sg-rules/fetch-await-tsx.yml`
  (`language: tsx`, `src/**/*.tsx`) require every `fetch(...)` in `src/**`
  to be awaited, returned, or `.then/.catch`-chained. Fails `check` via
  `npm run scan:fetch-await`; its error-severity fetch rules fail while
  warning-severity rules remain report-only. The `await`/`return` search stops at the nearest
  function boundary, so a floating call inside a callback is still flagged;
  a concise arrow body (`(u) => fetch(u)`) is the callback's implicit return
  and stays exempt. Islands (`assets/islands/*.js`) are out of scope: they
  use assigned `.then` chains behind generation guards. Rule fixtures live
  in `sg-tests/fetch-await*.yml` and run under `npm run scan:rules-test`.
- **Changed-lines coverage (WARN, 80%):** `ci/patch-coverage.mjs` intersects
  the PR diff with `coverage-final.json`; added TS lines nobody executes warn.
  A missing `coverage-final.json` fails the step instead of skipping, so a
  broken coverage run cannot silence the gate (docs-only and draft PRs skip
  via the scope guard). Aggregate floors in `vitest.config.ts` stay. Flip to
  `--strict` for HARD.
- **Semgrep TS + secrets (HARD):** `ci/semgrep-rules.yml` flags dangerous
  sinks (`eval`, string `setTimeout`, `innerHTML`, `document.write`) and
  secret-shaped literals. CI installs the pinned CLI into a Python virtual
  environment and runs `ci/semgrep-warn-selftest.mjs` against a planted finding
  before scanning the tree. Setup, selftest, partial-parse errors, scanner
  failures, and findings fail the `check` job and therefore the required `ci-ok`;
  the scan uses
  `--strict --error`. The regression test in `test/workflow-hardening.test.ts`
  pins the fail-closed workflow wiring. The selftest matches the rule id by
  suffix because Semgrep prefixes it with the config path. Full-history leak
  scanning stays with gitleaks.
- **Mutation nightly (non-blocking):** `ci/mutation-sessions-join.mjs` weakens
  one auth check at a time and runs the hermetic kill suite; survivors are
  coverage gaps in the report artifact, never a red build.
- **Test inventory (WARN):** `ci/test-inventory.mjs` warns when a
  `*.test.ts` / `*.test.mjs` file is reachable from no CI job. The step
  runs with `continue-on-error` and the `--selftest` is hermetic (fixture
  trees only), so an orphan can never fail the job or skip later steps.
- **Tier-0 check (required):** `npm run test:tier0` runs the fast-check
  validator properties, the role x route authz matrix and the
  default-planner EXPLAIN seq-scan check from `tier0/` (own vitest config:
  every `test/**` file runs inside the blocking coverage step, so Tier-0
  stays isolated in its own runner). The `check`-job step runs against the
  job Postgres service and prints the changed query files beside the verdict.
- **Floor guard (HARD):** `ci/floor-guard.mjs` enforces the CONSTRAINTS.md
  floor on the PR diff: new suppressions, test skip calls, deleted test files
  (including `*-selftest` scripts), net-removed assertions, source-code stubs,
  new exception rows, lowered table thresholds, removed enforced-threshold
  rows, and added `.constraintsignore` lines fail `check`. Renamed threshold
  rows pair by their Checked-by cell, so a rename-plus-lowering still fails.
  Removed threshold rows read the origin path, so moving CONSTRAINTS.md to
  another name and lowering a row still fails; moving CONSTRAINTS.md to a
  name that no longer matches fails as a threshold removal even with no row
  edit, and deleting CONSTRAINTS.md fails as a threshold removal. Test renames are judged against the runner
  globs (vitest includes test/** plus ci/audit-lifecycle.test.mjs, Playwright
  specs under e2e/); e2e safety and ci selftest scripts run via enumerated
  paths (only ci/a11y-*.test.mjs runs via glob), so any rename of those needs
  a waiver. Merge-queue squash messages hard-wrap PR bodies at ~72 columns,
  so `unfoldFloorWaiverLines` joins nonblank continuation lines after each
  `Floor-waiver:` line before matching; path-based waiver parsing removes
  wrap-inserted spaces within the path
  (`ci/floor-guard.mjs:215-234, 236-262`).
  Waivers are reasoned commit trailers (`test-deleted`, `assertion-removed`,
  `threshold-removed`, `new-exemption`) and every active one is printed to the
  log and the job summary for reviewer visibility. The ignore list is pinned
  to the merge base: branch-added entries take effect only behind a
  `new-exemption` waiver. It scopes skip detection to test code and stub
  detection to source/test code; generated minified islands are exempted by
  `.constraintsignore`. An assertion paired with one added in the same test
  file reads as a replacement. Failed or oversized diffs exit 2 rather than
  looking clean.
  Mirror every `Floor-waiver:` trailer from branch commits in canonical form
  in the PR body: `check_queue_visible_waivers` (`ci/pr-lint-output.py:26-71`) scans
  branch commit messages (`git log --format=%B HEAD --not <base>`,
  `ci/pr-lint-output.py:48-61`) and fails the PR (`sys.exit(1)`,
  `ci/pr-lint-output.py:65-70`) when `missing_body_waivers`
  (`ci/floor_waiver_body.py:60-62`) finds any canonical trailer from the
  commits absent from the body, where `waiver_trailers`
  (`ci/floor_waiver_body.py:51-57`) unfolds wrapped lines and canonicalizes
  whitespace (`ci/floor_waiver_body.py:6-10,17-48`). The mirror exists for
  merge-queue validation (`ci/pr-lint-output.py:67`): the queue squash lacks
  branch-only trailers, so without the body copy it would fail floor-guard
  (`ci/pr-lint-output.py:31-35`).
- **Shared ast-grep rules (WARN):** `sg-rules/ts-*.yml` are vendored
  byte-identical from the shared meta-only quality assets
  (`quality/meta-only/rules/ts/`) instead of rewritten: `ts-admin-join-attempt-write`
  (no SQL writes to join-attempt history from admin stores),
  `ts-path-stat-then-stream` (open once, stream the same descriptor),
  `ts-probe-unbounded-buffer` (bounded probe bodies), and
  `ts-vacuous-literal-expect` (no literal-true assertions). They run at
  warning severity inside the existing `ast-grep scan` step, so they report
  without failing; their fixtures live in `sg-tests/` with recorded
  baselines (`npm run scan:rules-test`, also run in that CI step).
  `ts-probe-unbounded-buffer` targets a `wrangler/src/**` tree this repo does
  not have, so it is wired for parity but never fires here. Wiring the rules
  caught one live `expect(true).toBe(true)` placeholder in
  `test/seo-headers.test.ts`, replaced with a mapping-table pin that asserts
  every documented section exists in the file.

## Merge-blocking mutation proposal

Nightly triage (2026-10-11, head `de850cf`): 20/20 mutants killed, zero
survivors, so nothing is on fire. The blocking candidates are the seven new
targeted mutants — `R4`–`R7` (`src/roles.ts`: blank-allowlist admit,
fetch-failure admit, lookup-failure admit, any-role admits) and `W1`–`W3`
(`src/admin/validation-wall-time.ts`: fold flip, gap admitted, unknown zone
admitted) — because each is killed by a 2-file, 46-test subset
(`moderator-malformed-success` + `event-time-validation`) that runs in ~3s
DB-free. A blocking job (baseline + 7 mutants ≈ under 1 min on the existing
runners) flips these from nightly-signal to merge-blocking without moving the
slow session/join/admin mutants, which stay nightly. Not implemented yet:
needs its own PR wiring the subset job in WARN first.
