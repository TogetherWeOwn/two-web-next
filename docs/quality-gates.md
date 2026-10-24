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
- **Focused mutation (WARN):** `.github/workflows/mutation-roles-wall-time.yml`
  runs the DB-free baseline plus only `R4`–`R7` and `W1`–`W3` on the existing
  standard GitHub-hosted runner. It is not required and is separate from `ci`
  (including `ci-ok` and its deployment consumer). The job and signal steps
  use `continue-on-error`: survivors and infrastructure failures cannot fail
  the overall check. JSON, Markdown and per-run Vitest evidence are retained
  for 14 days, including on failure. The full nightly signal stays unchanged.
- **Test inventory (HARD):** `ci/test-inventory.mjs` fails the job when a
  `*.test.ts` / `*.test.mjs` file is reachable from no CI job. The same
  step gates Playwright specs: every `e2e/**/*.spec.ts` and
  `e2e/**/*.visual.ts` must match a CI-referenced config's
  testDir/testMatch and not be excluded by testIgnore (honoring workflow
  file filters) or be imported transitively by such a spec. Import edges
  are side-effect imports, re-exports and require calls: a named import of
  a spec fails closed (Playwright's Babel elides unused bindings), as do
  argument forwarding (bare positionals as well as `--`) and
  `--prefix`/`--workspace` redirects on Playwright scripts. A workflow
  step that runs Playwright must run at the repo root: any other
  `working-directory:` or a preceding `cd` fails closed. `--json` prints
  the Playwright
  summary (`playwright-spec-reachability`, `OK`/`PLAYWRIGHT_SPEC_ORPHAN`,
  `next_action`). The step runs `npm run test:inventory -- --strict` with
  no `continue-on-error`; the `--selftest` stays hermetic (fixture trees
  plus wiring checks that never depend on the tree having zero orphans).
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

## Focused mutation rollout (WARN-first)

The fixed seven-mutant subset is `R4`–`R7` (`src/roles.ts`: blank-allowlist
admit, fetch-failure admit, lookup-failure admit, any-role admits) and `W1`–`W3`
(`src/admin/validation-wall-time.ts`: fold flip, gap admitted, unknown zone
admitted). It runs only `test/moderator-malformed-success.test.ts` and
`test/event-time-validation.test.ts` (46 tests), with no database URLs inherited
by Vitest. The slow session/join/admin mutants remain in the existing nightly
job; that inventory, its safeguards and all coverage floors are unchanged.

Run `env -u DATABASE_URL npm run mutation:roles-wall-time` locally. The runner
refuses dirty targets, requires a green unmutated baseline, checks unique
anchors, and reuses the nightly targeted restore with SHA-256 verification
before proceeding to another mutant. Each Vitest child has a 20-second cap;
the job has a five-minute cap. No whole-tree checkout or dirty-target bypass
is offered. A restore mismatch stops further mutation and preserves unexpected
bytes for inspection. Abrupt runner loss or an uncatchable process kill cannot
promise cleanup; partial reports are saved before mutation and after each result.

`artifacts/mutation-roles-wall-time/report.{json,md}` distinguishes surviving
mutants (coverage gaps, exit 0) from infrastructure failures (exit 1): baseline
failure, missing inputs, stale/ambiguous anchors, timeouts, signals, spawn/load
errors and restore mismatches. Exit 1 from Vitest is not enough to count a kill:
both suite files must produce complete, non-skipped assertion results with an
actual failed test. Reports include per-mutant before/after hashes. The
always-run workflow summary writes an infrastructure fallback if no runner
report exists, and the always-run upload preserves available reports and logs.

Run `npm run mutation:roles-wall-time:selftest` for hermetic harness and workflow
wiring checks. Promotion to HARD remains a separate reviewed slice: this job
is intentionally WARN-only and neither branch protection nor `ci-ok` reads it.
