# Constraints

Last reviewed: 2026-10-15, after the floor changes in [#704](https://github.com/TogetherWeOwn/two-web-next/pull/704),
[#835](https://github.com/TogetherWeOwn/two-web-next/pull/835) and
[#878](https://github.com/TogetherWeOwn/two-web-next/pull/878). The guard
rejects the listed floor-lowering changes (`ci/floor-guard.mjs:8-12`); PR lint
requires queue-visible waiver trailers (`ci/pr-lint-output.py:26-71`).

## Floor (always enforced, no setup required)

- No new suppression comments that silence a checker.
- No unimplemented stubs and no empty catch blocks that turn failure silent.
- No added test skips. Test-file deletion, assertion removal, enforced-row
  removal, and ignore-list addition require a reasoned commit trailer:
  `Floor-waiver: test-deleted <path> -- <reason>`,
  `Floor-waiver: assertion-removed <path> -- <reason>`,
  `Floor-waiver: threshold-removed <Dimension> -- <reason>`, or
  `Floor-waiver: new-exemption .constraintsignore -- <reason>`.
  For PRs, mirror every recognized branch trailer verbatim in the PR body;
  missing mirrors fail `pr-lint` so merge-queue validation can see the waivers
  (`ci/pr-lint-output.py:65-70`; `ci/floor_waiver_body.py:51-62`).
- No secrets in source.
- This file does not get weakened to make a change pass: thresholds only move
  up without discussion, and new exception rows fail the gate.

Checked by `npm run floor-guard` (HARD in the `check` job). Exemptions live
in `.constraintsignore`, one glob per line with a reason, and never cover
test skips, thresholds, exception rows, or deleted tests. The ignore list is pinned to
the merge base: lines the branch adds fail as `new-exemption` unless a
reasoned waiver trailer covers the file. Every active waiver is printed to
the CI log and the job summary, so exemptions are tracked in the open.
Threshold rows pair by label, then by Checked-by cell: renaming a dimension
while lowering it, or deleting the row, fails the gate.

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors | `npm run typecheck` | every PR (`check` job) |
| Lint | Zero errors from our config | `npm run lint` | every PR (`check` job) |
| Fetch await | Every `fetch(...)` in `src/**` awaited, returned, or chained | `npm run scan:fetch-await` | every PR (`check` job, HARD) |
| Shared ast-grep rules | Vendored `sg-rules/ts-*.yml` report only; fixtures in `sg-tests/` pass | `npm run scan:rules-test` (fixtures) inside the fetch-await CI step | every PR (`check` job; scan WARN, fixtures HARD) |
| Secrets | No secrets in source | `bash .github/scripts/gitleaks-scan.sh` | every PR (`gitleaks` required check) |
| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` (`--strict` flips it HARD) | every PR (`check` job, WARN: reports only) |
| Project coverage | Zero threshold violations: statements 90.8, branches 84.2, functions 92.3, lines 94.4, plus per-area floors (`vitest.config.ts:40`) | `npm run test:coverage` | every PR (`check` job) |
| Security: code | No sink or secret-literal findings; scanner and partial-parse errors fail closed | Semgrep HARD step in `.github/workflows/ci.yml` (`--strict --error`, planted-finding selftest) | every PR (`check` job) |
| Test inventory | Every test file reachable from CI | `npm run test:inventory -- --strict` | every PR (`check` job, HARD) |
| Bundle size | Served assets within budget | `npm run budget` | `bundle-budget` job, blocks merge |
| Worker bundle | Main Worker dry-run bundle within budget | `npm run worker-budget` | every PR (`check` job) |
| Page quality | Lighthouse categories within `ci/quality-budget.json`; security headers, HTML basics, internal links | `npm run lighthouse:quality`, `npm run standards` | `lighthouse` job, blocks merge |
| Accessibility | Zero critical or serious violations on fixtures | `npm run a11y` | `a11y` job, blocks merge |

Every row names the command that produces the verdict. A dimension with a
number and no command here is an aspiration, not a constraint.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Mutation signal | Nightly, non-blocking; `R4`–`R7` and `W1`–`W3` targeted mutants proposed as the first blocking subset (see `docs/quality-gates.md`) | toward blocking the ~3s subset |

## Exceptions

No open exceptions. When one is needed, add a row of the form
`| W<n> | rule | path | reason | owner | expiry |` and expect the floor
guard to flag it until the reason is tracked; every exception has an owner
and an expiry no more than 90 days out.
