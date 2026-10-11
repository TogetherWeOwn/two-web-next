# Constraints

Last reviewed: 2026-10-11. No interview ran (non-interactive session), so this
records the floor plus the measured defaults from the constraint skill; the
numbered dimensions below mirror the gates already wired in this repo.

## Floor (always enforced, no setup required)

- No new suppression comments that silence a checker.
- No unimplemented stubs and no empty catch blocks that turn failure silent.
- No added test skips. Test-file deletion and assertion removal require a
  path-scoped, reasoned commit trailer:
  `Floor-waiver: test-deleted <path> -- <reason>` or
  `Floor-waiver: assertion-removed <path> -- <reason>`.
- No secrets in source.
- This file does not get weakened to make a change pass: thresholds only move
  up without discussion, and new exception rows fail the gate.

Checked by `npm run floor-guard` (HARD in the `check` job). Exemptions live
in `.constraintsignore`, one glob per line with a reason, and never cover
thresholds, exception rows, or deleted tests.

## Enforced with numbers

| Dimension | Rule | Checked by | Runs at |
|-----------|------|-----------|---------|
| Types | Zero type errors | `npm run typecheck` | every PR (`check` job) |
| Lint | Zero errors from our config | `npm run lint` | every PR (`check` job) |
| Fetch await | Every `fetch(...)` in `src/**` awaited, returned, or chained | `npm run scan:fetch-await` | every PR (`check` job, HARD) |
| Shared ast-grep rules | Vendored `sg-rules/ts-*.yml` report only; fixtures in `sg-tests/` pass | `npm run scan:rules-test` (fixtures) inside the fetch-await CI step | every PR (`check` job; scan WARN, fixtures HARD) |
| Secrets | No secrets in source | `bash .github/scripts/gitleaks-scan.sh` | every PR (`gitleaks` required check) |
| Coverage of changed lines | Added TS lines ≥ 80% executed | `npm run patch:coverage` (`--strict` flips it HARD) | every PR (`check` job, WARN: reports only) |
| Security: code | No high findings | Semgrep WARN step in `.github/workflows/ci.yml` (planted-warning selftest + scan) | every PR (`check` job, WARN: reports only) |
| Test inventory | Every test file reachable from CI | `npm run test:inventory` (`--strict` flips it HARD) | every PR (`check` job, WARN: reports only) |
| Bundle size | Served assets within budget | `npm run budget` | `bundle-budget` job, blocks merge |
| Page quality | Lighthouse categories within `ci/quality-budget.json`; security headers, HTML basics, internal links | `npm run lighthouse:quality`, `npm run standards` | `lighthouse` job, blocks merge |
| Accessibility | Zero critical or serious violations on fixtures | `npm run a11y` | `a11y` job, blocks merge |

Every row names the command that produces the verdict. A dimension with a
number and no command here is an aspiration, not a constraint.

## Measured, not yet enforced

| Metric | Today | Direction |
|--------|-------|-----------|
| Project coverage | Unmeasured; the first green `check` run on this branch records it via `coverage/coverage-summary.json` | must not fall (0.5% tolerance absorbs drift) |
| Mutation signal | Nightly, non-blocking; `R4`–`R7` and `W1`–`W3` targeted mutants proposed as the first blocking subset (see `docs/quality-gates.md`) | toward blocking the ~3s subset |

## Exceptions

No open exceptions. When one is needed, add a row of the form
`| W<n> | rule | path | reason | owner | expiry |` and expect the floor
guard to flag it until the reason is tracked; every exception has an owner
and an expiry no more than 90 days out.
